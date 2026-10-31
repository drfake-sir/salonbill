import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Restore check (the "restore drill") regression guards.
 *
 * The old drill called the real `restoreBackup` — a transaction that CLEARS
 * every restorable table and re-puts the backup's rows — so it could change
 * live data if anything differed. The replacement must be read-only:
 *
 *  1. it plans the restore in memory and reports per-table row counts,
 *  2. it only ever reads (count), never writes,
 *  3. the live rows are byte-for-byte identical before and after.
 */

/* In-memory "live database": reads are served from it, writes are violations. */
const h = vi.hoisted(() => {
  const live: Record<string, unknown[]> = {
    categories: [{ id: 1, name: "Hair" }],
    services: [
      { id: 1, name: "Haircut" },
      { id: 2, name: "Colour" },
    ],
    products: [],
    stylists: [{ id: 1, name: "Asha" }],
    customers: [{ id: 1, name: "Lakshmi" }],
    bills: [
      { id: 1, number: "SB-0001", createdAt: 1, lines: [], status: "paid" },
      { id: 2, number: "SB-0002", createdAt: 2, lines: [], status: "paid" },
    ],
    settings: [{ id: 1, billSeq: 2 }],
    audit: [
      { id: 1, at: 1, action: "seed" },
      { id: 2, at: 2, action: "seed" },
      { id: 3, at: 3, action: "seed" },
    ],
  };
  return { live, violations: [] as string[] };
});

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  const table = (name: string) => ({
    count: async () => (h.live[name] ?? []).length,
    toArray: async () => [...(h.live[name] ?? [])],
    get: async () => (h.live[name] ?? [])[0],
    clear: async () => {
      h.violations.push(`clear:${name}`);
    },
    put: async () => {
      h.violations.push(`put:${name}`);
    },
    bulkPut: async () => {
      h.violations.push(`bulkPut:${name}`);
    },
    add: async () => {
      h.violations.push(`add:${name}`);
    },
    update: async () => {
      h.violations.push(`update:${name}`);
    },
    delete: async () => {
      h.violations.push(`delete:${name}`);
    },
    hook: () => undefined,
  });
  const db: Record<string, unknown> = { tables: [] };
  for (const t of [...original.RESTORABLE, "drafts", "syncQueue"] as string[]) db[t] = table(t);
  db["transaction"] = async (_mode: string, _tables: unknown, fn: () => Promise<void>) => {
    h.violations.push("transaction");
    await fn();
  };
  return { ...original, db: db as unknown as typeof original.db };
});

import { RESTORABLE } from "./db";
import { drillSummary, planRestoreCounts, runRestoreDrill } from "./restoreDrill";

const liveSnapshot = () => JSON.stringify(h.live);

const rows = (name: string) => [...(h.live[name] ?? [])];

/** A backup that matches the live tables exactly. */
const matchingBackup = () => ({
  categories: rows("categories"),
  services: rows("services"),
  products: rows("products"),
  stylists: rows("stylists"),
  customers: rows("customers"),
  bills: rows("bills"),
  settings: rows("settings"),
  audit: rows("audit"),
});

describe("planRestoreCounts — the restore, worked out on paper", () => {
  it("counts every restorable table the way a restore would leave it", () => {
    const plan = planRestoreCounts(matchingBackup());
    expect(plan.ok).toBe(true);
    expect([...plan.counts.keys()].sort()).toEqual([...RESTORABLE].sort());
    for (const t of RESTORABLE) {
      const expected = t === "settings" ? 1 : (h.live[t] as unknown[]).length;
      expect(plan.counts.get(t)).toBe(expected);
    }
  });

  it("leaves a table it does not carry out of the plan (restore would skip it)", () => {
    const b = matchingBackup() as Record<string, unknown>;
    delete b["audit"];
    const plan = planRestoreCounts(b);
    expect(plan.ok).toBe(true);
    expect(plan.counts.has("audit")).toBe(false); // treated as "unchanged"
    expect(plan.counts.get("bills")).toBe(2);
  });

  it("plans a different row count when the backup holds another number of bills", () => {
    const b = matchingBackup();
    b.bills = [...b.bills, { id: 3, number: "SB-0003", createdAt: 3, lines: [], status: "paid" }];
    const plan = planRestoreCounts(b);
    expect(plan.ok).toBe(true);
    expect(plan.counts.get("bills")).toBe(3);
    expect(plan.counts.get("settings")).toBe(1); // merged into the single row
  });

  it("rejects a file that is not a SalonBill backup", () => {
    expect(planRestoreCounts({ nope: true }).ok).toBe(false);
    expect(planRestoreCounts(null).problems).toEqual(["not a SalonBill backup file"]);
    expect(planRestoreCounts({ bills: "x", settings: [] }).ok).toBe(false);
  });
});

describe("runRestoreDrill — read-only, per-table comparison", () => {
  it("passes when the planned counts equal the live counts", async () => {
    const before = liveSnapshot();
    const r = await runRestoreDrill(matchingBackup());
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.tables.map((t) => t.table).sort()).toEqual([...RESTORABLE].sort());
    for (const t of r.tables) expect(t.match).toBe(true);
    expect(r.liveBills).toBe(2);
    expect(drillSummary(r)).toBe("passed — 8 tables match, 2 bills");
    // and nothing was written
    expect(h.violations).toEqual([]);
    expect(liveSnapshot()).toBe(before);
  });

  it("fails (and names the table) when the counts differ, without writing", async () => {
    const before = liveSnapshot();
    const b = matchingBackup();
    b.bills = [...b.bills, { id: 9, number: "SB-0009", createdAt: 9, lines: [], status: "paid" }];
    const r = await runRestoreDrill(b);
    expect(r.ok).toBe(false);
    expect(r.tables.find((t) => t.table === "bills")).toEqual({
      table: "bills",
      live: 2,
      wouldBe: 3,
      match: false,
    });
    expect(drillSummary(r)).toContain("bills: 2 now vs 3 from backup");
    expect(h.violations).toEqual([]);
    expect(liveSnapshot()).toBe(before);
  });

  it("fails on an unreadable file without touching a table", async () => {
    const before = liveSnapshot();
    const r = await runRestoreDrill({ hello: "world" });
    expect(r.ok).toBe(false);
    expect(drillSummary(r)).toContain("unreadable file");
    expect(h.violations).toEqual([]);
    expect(liveSnapshot()).toBe(before);
  });
});

/* ----------------------------- source rules ------------------------------ */

describe("the drill module can never write", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  const src = read("lib/restoreDrill.ts");

  it("never imports or calls the real restore, and only ever counts", () => {
    // Strip comments so wording like "clear() + bulkPut()" in prose is ignored.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("restoreBackup");
    expect(code).not.toMatch(/\.\s*clear\s*\(/);
    expect(code).not.toMatch(/\.\s*bulkPut\s*\(/);
    expect(code).not.toMatch(/\.\s*bulkAdd\s*\(/);
    expect(code).not.toMatch(/\.\s*put\s*\(/);
    expect(code).not.toMatch(/\.\s*update\s*\(/);
    expect(code).not.toMatch(/\.\s*delete\s*\(/);
    expect(code).not.toMatch(/db\s*\.\s*transaction/);
    // The one and only read primitive is `count()`.
    expect(code).toMatch(/await db\[t\]\.count\(\)/);
  });

  it("the Settings card drives it and never calls the real restore either", () => {
    const card = read("routes/settings.tsx");
    const start = card.indexOf("const runDrill");
    const end = card.indexOf("return (", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = card.slice(start, end);
    expect(body).toContain("runRestoreDrill(");
    expect(body).not.toContain("restoreBackup(");
    expect(body).not.toContain("db.bills.count");
    expect(body).toContain("setMetaText(META_KEYS.drillResult");
    expect(body).toContain("setMeta(META_KEYS.drill, at)");
    // The button carries the plain-words label.
    expect(card).toContain("Check that a backup can be restored (does not change your data)");
    expect(card).not.toContain("Run restore drill");
  });
});
