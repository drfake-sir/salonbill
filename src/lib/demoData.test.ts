import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  defaultRestoreDeps,
  normalizeName,
  restoreReport,
  restoreStarterCatalog,
  type RestoreDeps,
} from "./demoData";
import { STARTER_CATEGORIES, STARTER_PRODUCTS, STARTER_SERVICES, STARTER_STYLISTS } from "./db";

/**
 * The barber's build: no demo-cleanup action anywhere, no seeded customers,
 * and the starter catalog still seeds on a fresh setup and can be restored.
 */

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, ...p), "utf8");

/* ------------------------- no demo-cleanup UI ---------------------------- */

describe("no demo-cleanup option anywhere", () => {
  it("Settings has no 'Demo data' card, no tick boxes, no removal button", () => {
    const src = read("..", "routes", "settings.tsx");
    expect(src).not.toContain("DemoCleanup");
    expect(src).not.toContain("Demo data");
    expect(src).not.toContain("removeDemoData");
    expect(src).not.toContain("Remove the ticked");
    expect(src).not.toContain("starter staff");
    expect(src).not.toContain("findDemoRows");
    // Still owner-only.
    expect(src).toMatch(/<OwnerOnly>/);
  });

  it("Settings still offers Restore starter catalog (shared helper kept)", () => {
    const src = read("..", "routes", "settings.tsx");
    expect(src).toContain("restoreStarterCatalog");
    expect(src).toContain('data-testid="restore-starter"');
    expect(src).toContain("Restore starter catalog");
  });

  it("the setup screen has no demo-cleanup step", () => {
    const src = read("..", "components", "SetupScreen.tsx");
    expect(src).not.toContain("DemoCleanup");
    expect(src).not.toContain("Demo data");
    expect(src).not.toContain("removeDemoData");
    expect(src).not.toContain("findDemoRows");
  });

  it("the DemoCleanup component is gone and nothing imports it", () => {
    expect(fs.existsSync(path.join(__dirname, "..", "components", "DemoCleanup.tsx"))).toBe(false);
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
      });
    for (const file of walk(path.join(__dirname, ".."))) {
      if (/\.test\.(ts|tsx)$/.test(file)) continue; // this file names it deliberately
      expect(fs.readFileSync(file, "utf8")).not.toMatch(/DemoCleanup/);
    }
  });

  it("demoData.ts exposes restore only — no removal/scanning API, no deletes", () => {
    const src = read("demoData.ts");
    for (const gone of [
      "removeDemoData",
      "scanDemoData",
      "findDemoRows",
      "hasRealBills",
      "ALL_REMOVALS",
      "NO_REMOVAL",
      "DEMO_CUSTOMERS",
      "DEMO_STAFF",
      "DEMO_SERVICES",
      "DEMO_PRODUCTS",
    ])
      expect(src).not.toContain(gone);
    expect(src).not.toMatch(/\.delete\(/);
    // Its public surface is exactly the restore helpers + shared name normaliser.
    const exported = [...src.matchAll(/export (?:async )?(?:function|const|type) (\w+)/g)].map(
      (m) => m[1],
    );
    expect(exported.sort()).toEqual([
      "RestoreCounts",
      "RestoreDeps",
      "defaultRestoreDeps",
      "normalizeName",
      "restoreReport",
      "restoreStarterCatalog",
    ]);
  });
});

/* ------------------------ fresh-setup seeding ---------------------------- */

describe("fresh setup: starter catalog yes, fake customers no", () => {
  const dbSrc = read("db.ts");
  const seedAt = dbSrc.indexOf("export async function seedIfEmpty");
  const seed = dbSrc.slice(seedAt, dbSrc.indexOf("billNumberFor", seedAt));

  it("seedIfEmpty bulkPuts the starter categories/services/products/stylists", () => {
    for (const c of [
      "STARTER_CATEGORIES.map(",
      "STARTER_SERVICES.map(",
      "STARTER_PRODUCTS.map(",
      "STARTER_STYLISTS.map(",
    ])
      expect(seed).toContain(c);
  });

  it("seedIfEmpty never writes customers", () => {
    expect(seed).not.toMatch(/db\.customers/);
    expect(seed).not.toMatch(/customers\.bulkPut/);
    expect(dbSrc).not.toMatch(/DEMO_CUSTOMERS/);
  });

  it("the starter constants are non-empty and self-consistent", () => {
    expect(STARTER_CATEGORIES.length).toBeGreaterThan(0);
    expect(STARTER_SERVICES.length).toBeGreaterThan(0);
    expect(STARTER_PRODUCTS.length).toBeGreaterThan(0);
    expect(STARTER_STYLISTS.length).toBeGreaterThan(0);
    for (const s of STARTER_SERVICES)
      expect(STARTER_CATEGORIES).toContain(s.category as (typeof STARTER_CATEGORIES)[number]);
    // every starter row is a complete, plausible record
    for (const s of STARTER_SERVICES) {
      expect(s.price).toBeGreaterThan(0);
      expect(s.duration).toBeGreaterThan(0);
    }
    for (const p of STARTER_PRODUCTS) expect(p.price).toBeGreaterThan(0);
  });

  it("only new installs are seeded — an existing salon is never overwritten", () => {
    expect(seed).toMatch(/if \(await db\.settings\.get\(1\)\) return;/);
    // double-check inside the transaction too
    expect(seed).toMatch(
      /if \(await db\.settings\.get\(1\)\) return;\s*\n\s*await db\.settings\.put/,
    );
  });
});

/* ------------------------- restore starter ------------------------------- */

describe("restoreStarterCatalog", () => {
  function harness(existing: {
    categories: { id?: number | undefined; name: string }[];
    services: { name: string; categoryId: number }[];
    products: { name: string }[];
    stylists: { name: string }[];
  }) {
    const calls: { kind: string; row: unknown }[] = [];
    const deps: Partial<RestoreDeps> = {
      load: async () => existing,
      create: {
        category: async (name, order) => {
          calls.push({ kind: "category", row: { name, order } });
          return existing.categories.length + 1 + calls.filter((c) => c.kind === "category").length;
        },
        service: async (s) => {
          calls.push({ kind: "service", row: s });
        },
        product: async (p) => {
          calls.push({ kind: "product", row: p });
        },
        stylist: async (s) => {
          calls.push({ kind: "stylist", row: s });
        },
      },
    };
    return { calls, deps, of: (kind: string) => calls.filter((c) => c.kind === kind) };
  }

  it("adds every missing starter row to an empty catalog", async () => {
    const h = harness({ categories: [], services: [], products: [], stylists: [] });
    const counts = await restoreStarterCatalog(h.deps);
    expect(counts.categories).toBe(STARTER_CATEGORIES.length);
    expect(counts.services).toBe(STARTER_SERVICES.length);
    expect(counts.products).toBe(STARTER_PRODUCTS.length);
    expect(counts.stylists).toBe(STARTER_STYLISTS.length);
    expect(restoreReport(counts)).toBe(
      `Added ${counts.services} services, ${counts.products} products, ${counts.stylists} stylists`,
    );
  });

  it("a second run adds nothing (idempotent)", async () => {
    const h = harness({ categories: [], services: [], products: [], stylists: [] });
    const firstCounts = await restoreStarterCatalog(h.deps);
    expect(firstCounts.services).toBe(STARTER_SERVICES.length);
    // catalog now has everything the first run created — model that:
    const second = harness({
      categories: STARTER_CATEGORIES.map((name, i) => ({ id: i + 1, name })),
      services: STARTER_SERVICES.map((s) => ({ name: s.name, categoryId: 1 })),
      products: STARTER_PRODUCTS.map((p) => ({ name: p.name })),
      stylists: STARTER_STYLISTS.map((s) => ({ name: s.name })),
    });
    const counts = await restoreStarterCatalog(second.deps);
    expect(counts).toEqual({ categories: 0, services: 0, products: 0, stylists: 0 });
    expect(second.calls).toHaveLength(0);
    expect(h.calls.length).toBeGreaterThan(0); // sanity: first run did work
  });

  it("never edits or deletes rows the salon already has", async () => {
    const h = harness({
      categories: [{ id: 1, name: "hair" }], // case-insensitive match
      services: [{ name: "Men's Haircut", categoryId: 1 }],
      products: [{ name: "L'Oréal Shampoo 250ml" }],
      stylists: [{ name: "  karthik " }], // space+case-insensitive match
    });
    const counts = await restoreStarterCatalog(h.deps);
    // matched rows are never among the created ones:
    expect(counts.stylists).toBe(STARTER_STYLISTS.length - 1); // "Karthik" matched
    expect(counts.services).toBe(STARTER_SERVICES.length - 1); // "Men's Haircut" matched
    expect(counts.products).toBe(STARTER_PRODUCTS.length - 1); // shampoo matched
    // the one starter category the salon already had ("hair") is not re-created…
    expect(h.of("category").map((c) => (c.row as { name: string }).name)).not.toContain("Hair");
    // …but the four genuinely missing ones are:
    const madeCategories = h.of("category").map((c) => (c.row as { name: string }).name);
    expect(madeCategories).toHaveLength(STARTER_CATEGORIES.length - 1);
    for (const name of STARTER_CATEGORIES)
      if (name !== "Hair") expect(madeCategories).toContain(name);
    expect(h.of("service").map((c) => (c.row as { name: string }).name)).not.toContain(
      "Men's Haircut",
    );
    expect(h.of("stylist").map((c) => (c.row as { name: string }).name)).not.toContain("Karthik");
    // RestoreDeps has no delete capability by type or shape.
    expect(Object.keys(defaultRestoreDeps).sort()).toEqual(["create", "load"]);
    expect(JSON.stringify(defaultRestoreDeps)).not.toContain("delete");
  });

  it("never touches bills (there is no bills access at all)", () => {
    expect(read("demoData.ts")).not.toContain("db.bills");
  });

  it("restored stylists come back without a PIN", async () => {
    const h = harness({
      categories: [],
      services: [],
      products: [],
      stylists: [],
    });
    await restoreStarterCatalog(h.deps);
    for (const c of h.of("stylist")) expect(c.row).not.toHaveProperty("pin");
  });

  it("a service whose starter category was deleted entirely is skipped, not orphaned", async () => {
    const h = harness({
      categories: [], // no categories at all
      services: [],
      products: [],
      stylists: [],
    });
    const counts = await restoreStarterCatalog(h.deps);
    // categories are created first, so all services should still be placed
    expect(counts.categories).toBe(STARTER_CATEGORIES.length);
    expect(counts.services).toBe(STARTER_SERVICES.length);
  });

  it("normalizeName collapses spaces and case for matching", () => {
    expect(normalizeName("  Men's   Haircut ")).toBe("men's haircut");
    expect(normalizeName("ARUN")).toBe("arun");
  });
});

/* ------------------------- gate wiring (kept) ---------------------------- */

describe("gate + setup wiring", () => {
  it("AppShell delegates both gates to SalonGate (the cloud decides, not the seed)", () => {
    const src = read("..", "components", "AppShell.tsx");
    expect(src).toMatch(/<SalonGate>\{children\}<\/SalonGate>/);
    expect(src).not.toMatch(/needsSetup|<OwnerOnly>|<SetupScreen \/>|<CloudGate>/);
    expect(src).toMatch(/recovery \?/);
  });

  it("SetupScreen requires a new hashed owner PIN before finishing", () => {
    const src = read("..", "components", "SetupScreen.tsx");
    expect(src).toMatch(/isValidNewPin\(pin\)/);
    expect(src).toMatch(/ownerPin: await hashPin\(pin\), onboarded: true/);
    expect(src).toMatch(/disabled=\{!valid \|\| !validShop \|\| busy\}/);
  });

  it("the fresh-device / first-sync path is untouched", () => {
    for (const src of [read("demoData.ts"), read("..", "components", "SetupScreen.tsx")])
      expect(src).not.toMatch(/firstSync|replaceAll|sb-sync/);
  });
});
