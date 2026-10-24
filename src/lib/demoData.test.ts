import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DEMO_CUSTOMERS,
  DEMO_SERVICES,
  DEMO_STAFF,
  hasRealBills,
  removeDemoData,
  scanDemoData,
  type DemoScan,
} from "./demoData";

/**
 * Demo data on a new salon:
 *  - detection of the seeded rows (and ONLY those),
 *  - refusal when real bills exist, backup-before-delete, confirmation,
 *  - deletions ride the normal Dexie delete path → sync tombstones,
 *  - first-run setup screen + Settings option wiring,
 *  - the demo constants stay in sync with the seed in db.ts.
 */

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, ...p), "utf8");

/* ------------------------------- fixtures -------------------------------- */

const seedInput = () => ({
  stylists: DEMO_STAFF.map((s) => ({ ...s, commissionPct: 10, active: true })),
  services: DEMO_SERVICES.map((s) => ({
    ...s,
    categoryId: 1,
    price: 300,
    duration: 30,
    gstRate: 18,
    commissionPct: 10,
    active: true,
  })),
  customers: DEMO_CUSTOMERS.map((c) => ({ ...c, createdAt: 1 })),
  bills: [] as { status: "paid" | "held" | "cancelled" }[],
});

/* --------------------------------- scan ---------------------------------- */

describe("scanDemoData", () => {
  it("finds every seeded demo row on a brand-new salon", () => {
    const scan = scanDemoData(seedInput());
    expect(scan.stylists).toEqual([1, 2, 3, 4]);
    expect(scan.services).toHaveLength(20);
    expect(scan.services).toContain(1);
    expect(scan.services).toContain(20);
    expect(scan.customers).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("keeps rows the salon has renamed, repurposed or added (real data)", () => {
    const scan = scanDemoData({
      stylists: [
        { id: 1, name: "Raj (was Karthik)", phone: "9840011111" }, // renamed → keep
        { id: 5, name: "Karthik", phone: "9988776655" }, // real staff named Karthik → keep
        { id: 2, name: "Priya", phone: "9840022222" }, // untouched demo → delete
      ],
      services: [
        { id: 1, name: "Men's Haircut" }, // untouched demo → delete
        { id: 21, name: "Men's Haircut" }, // real service reusing the name → keep
        { id: 2, name: "Beard highlights" }, // demo id repurposed with a new name → keep
      ],
      customers: [
        { id: 1, name: "Lakshmi Narayanan", phone: "9841234567" }, // demo → delete
        { id: 7, name: "Meena Ramesh", phone: "9000000000" }, // real, same name → keep
      ],
    });
    expect(scan).toEqual({ stylists: [2], services: [1], customers: [1] });
  });

  it("returns empty scans when there is no demo data left", () => {
    expect(scanDemoData({ stylists: [], services: [], customers: [] })).toEqual({
      stylists: [],
      services: [],
      customers: [],
    });
  });
});

/* ---------------------------- real-bill guard ---------------------------- */

describe("hasRealBills", () => {
  it("refuses when any paid or cancelled bill exists", () => {
    expect(hasRealBills([])).toBe(false);
    expect(hasRealBills([{ status: "held" }])).toBe(false); // device-local draft
    expect(hasRealBills([{ status: "paid" }])).toBe(true);
    expect(hasRealBills([{ status: "held" }, { status: "cancelled" }])).toBe(true);
  });
});

/* ------------------------------- the flow -------------------------------- */

function harness(overrides?: {
  bills?: { status: "paid" | "held" | "cancelled" }[];
  confirm?: boolean;
  backupFails?: boolean;
}) {
  const calls: string[] = [];
  let scanSeen: DemoScan | null = null;
  const result = removeDemoData({
    load: async () => ({ ...seedInput(), bills: overrides?.bills ?? [] }),
    confirm: () => {
      calls.push("confirm");
      return overrides?.confirm ?? true;
    },
    backup: async () => {
      if (overrides?.backupFails) throw new Error("disk full");
      calls.push("backup");
    },
    remove: async (scan) => {
      calls.push("remove");
      scanSeen = scan;
    },
  });
  return { calls, scanSeen: () => scanSeen, result };
}

describe("removeDemoData", () => {
  it("refuses when real bills exist — no confirmation, no backup, no deletion", async () => {
    const h = harness({ bills: [{ status: "paid" }] });
    const r = await h.result;
    expect(r).toEqual({ ok: false, reason: "real-bills" });
    expect(h.calls).toHaveLength(0);
    expect(h.scanSeen()).toBeNull();
  });

  it("downloads the automatic backup BEFORE deleting, after confirmation", async () => {
    const h = harness();
    const r = await h.result;
    expect(r.ok).toBe(true);
    // Order: confirm → backup → remove (backup strictly before the deletes).
    expect(h.calls).toEqual(["confirm", "backup", "remove"]);
    const scan = h.scanSeen()!;
    expect(scan.stylists).toHaveLength(4);
    expect(scan.services).toHaveLength(20);
    expect(scan.customers).toHaveLength(6);
  });

  it("aborts when the backup fails — nothing is deleted", async () => {
    const h = harness({ backupFails: true });
    const r = await h.result;
    expect(r).toEqual({ ok: false, reason: "backup-failed" });
    expect(h.calls).toEqual(["confirm"]); // asked, backed up (threw), remove never ran
    expect(h.scanSeen()).toBeNull();
  });

  it("aborts when the owner declines the confirmation", async () => {
    const h = harness({ confirm: false });
    const r = await h.result;
    expect(r).toEqual({ ok: false, reason: "declined" });
    expect(h.calls).toEqual(["confirm"]); // confirmation asked, then nothing
    expect(h.scanSeen()).toBeNull();
  });

  it("reports 'no-demo' when there is nothing to remove", async () => {
    const r = await removeDemoData({
      load: async () => ({ stylists: [], services: [], customers: [], bills: [] }),
      confirm: () => true,
      backup: async () => {},
      remove: async () => {
        throw new Error("must not run");
      },
    });
    expect(r).toEqual({ ok: false, reason: "no-demo" });
  });
});

/* --------------------------- wiring + tombstones -------------------------- */

describe("removal wiring", () => {
  it("the default delete path uses per-row Dexie deletes (the hooked tombstone path)", () => {
    const src = read("demoData.ts");
    expect(src).toMatch(/db\.stylists\.delete\(id\)/);
    expect(src).toMatch(/db\.services\.delete\(id\)/);
    expect(src).toMatch(/db\.customers\.delete\(id\)/);
    // And the default backup is the local JSON backup, before any delete.
    expect(src).toMatch(/backup: \(\) => downloadLocalBackup\(\)/);
  });

  it("db.ts hooks those deletions into the outbox and the client pushes op:del", () => {
    const dbSrc = read("db.ts");
    // Deleting hooks enqueue every synced table (stylists/services/customers
    // are in SYNCED_TABLES)…
    expect(dbSrc).toMatch(/table\.hook\("deleting"/);
    const tablesAt = dbSrc.indexOf("SYNCED_TABLES = [");
    expect(tablesAt).toBeGreaterThan(-1);
    const tablesBlock = dbSrc.slice(tablesAt, dbSrc.indexOf("]", tablesAt));
    for (const t of ["stylists", "services", "customers"]) expect(tablesBlock).toContain(`"${t}"`);
    // …and a queued row that no longer exists pushes as a tombstone.
    const clientSrc = read("syncClient.ts");
    expect(clientSrc).toMatch(/return \{ t: table, id: q\.id, op: "del" \}/);
  });

  it("the demo constants match the seed in db.ts (no drift)", () => {
    const dbSrc = read("db.ts");
    for (const s of DEMO_STAFF) {
      expect(dbSrc).toContain(`name: "${s.name}"`);
      expect(dbSrc).toContain(`"${s.phone}"`);
    }
    for (const s of DEMO_SERVICES) expect(dbSrc).toContain(`"${s.name}"`);
    for (const c of DEMO_CUSTOMERS) {
      expect(dbSrc).toContain(`"${c.name}"`);
      expect(dbSrc).toContain(`"${c.phone}"`);
    }
  });
});

/* --------------------------- setup screen wiring -------------------------- */

describe("first-run setup screen wiring", () => {
  it("AppShell blocks on setup (owner-only) until settings.onboarded is true", () => {
    const src = read("..", "components", "AppShell.tsx");
    expect(src).toMatch(/const needsSetup = !!settings && !settings\.onboarded;/);
    expect(src).toMatch(/<OwnerOnly>/);
    expect(src).toMatch(/<SetupScreen \/>/);
    // Settings route stays outside the setup gate (recovery path).
    expect(src).toMatch(/recovery \?/);
  });

  it("SetupScreen requires a new hashed owner PIN before finishing", () => {
    const src = read("..", "components", "SetupScreen.tsx");
    expect(src).toMatch(/isValidNewPin\(pin\)/);
    expect(src).toMatch(/ownerPin: await hashPin\(pin\), onboarded: true/);
    expect(src).toMatch(/disabled=\{!valid \|\| busy\}/); // finish stays disabled otherwise
    expect(src).toMatch(/removeDemoData\(\)/); // offers demo removal too
  });

  it("Settings exposes the matching 'Remove demo data' option", () => {
    const src = read("..", "routes", "settings.tsx");
    expect(src).toMatch(/removeDemoData\(\)/);
    expect(src).toMatch(/Remove demo data/);
    // Still owner-only (the whole page renders inside OwnerOnly).
    expect(src).toMatch(/<OwnerOnly>/);
  });

  it("the fresh-device / first-sync path is untouched (existing suites cover it)", () => {
    // This module performs ordinary row deletes + a settings.update only — no
    // firstSync/replaceAll/cursor logic lives here or in the setup screen.
    const demoSrc = read("demoData.ts");
    const setupSrc = read("..", "components", "SetupScreen.tsx");
    for (const src of [demoSrc, setupSrc]) {
      expect(src).not.toMatch(/firstSync|replaceAll|sb-sync/);
    }
  });
});
