/**
 * Starter catalog restore.
 *
 * Every brand-new install is seeded (see `seedIfEmpty` in db.ts) with the
 * starter categories, services, products and stylists. This module puts those
 * rows back when the owner accidentally deletes them (Settings → Restore
 * starter catalog).
 *
 * NOTE: there is deliberately no demo-removal API any more. A real salon must
 * never be offered a "remove demo data" action, so the UI has no such screen
 * and nothing here deletes anything. Customers are not seeded at all — a new
 * salon starts with real rows only, added by the barber.
 */

import { STARTER_CATEGORIES, STARTER_PRODUCTS, STARTER_SERVICES, STARTER_STYLISTS, db } from "./db";

/**
 * Name matching used by restore: case-, space- and punctuation-spacing
 * insensitive, so "arun" counts as "Arun" and "Men's  Haircut" as
 * "Men's Haircut". Trimmed + collapsed + lowercased.
 */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

/* ------------------------------- restore ---------------------------------- */

export type RestoreCounts = {
  categories: number;
  services: number;
  products: number;
  stylists: number;
};

export type RestoreDeps = {
  load: () => Promise<{
    categories: { id?: number | undefined; name: string }[];
    services: { name: string; categoryId: number }[];
    products: { name: string }[];
    stylists: { name: string }[];
  }>;
  create: {
    category: (name: string, order: number) => Promise<number>;
    service: (s: {
      name: string;
      categoryId: number;
      price: number;
      duration: number;
    }) => Promise<unknown>;
    product: (p: {
      name: string;
      price: number;
      stock: number;
      lowStock: number;
    }) => Promise<unknown>;
    stylist: (s: { name: string; phone: string; commissionPct: number }) => Promise<unknown>;
  };
};

export const defaultRestoreDeps: RestoreDeps = {
  load: async () => ({
    categories: await db.categories.toArray(),
    services: await db.services.toArray(),
    products: await db.products.toArray(),
    stylists: await db.stylists.toArray(),
  }),
  create: {
    category: (name, order) => db.categories.add({ name, order }),
    service: (s) => db.services.add({ ...s, gstRate: 18, commissionPct: 10, active: true }),
    product: (p) => db.products.add({ ...p, gstRate: 18, active: true }),
    // NO pin: a restored stylist cannot sign in until the owner sets one.
    stylist: (s) => db.stylists.add({ ...s, active: true }),
  },
};

/**
 * Put the starter catalog back — ADD MISSING ROWS ONLY.
 *
 * - matched by name, ignoring case and repeated spaces ("arun" = "Arun");
 * - never edits, renames, re-prices or deletes anything that exists;
 * - never touches bills — saved lines keep their own price snapshots;
 * - uses the normal `add()` create paths (leased ids), so every restored row
 *   is enqueued and synced like any other create;
 * - safe to run twice: the second run adds 0;
 * - restored stylists come back WITHOUT a PIN.
 */
export async function restoreStarterCatalog(
  overrides?: Partial<RestoreDeps>,
): Promise<RestoreCounts> {
  const deps = { ...defaultRestoreDeps, ...overrides };
  const data = await deps.load();
  const counts: RestoreCounts = { categories: 0, services: 0, products: 0, stylists: 0 };

  const present = (rows: { name: string }[], name: string) =>
    rows.some((r) => normalizeName(r.name) === normalizeName(name));

  // Categories first: every restored service needs a real categoryId.
  const catId = new Map<string, number>();
  for (const c of data.categories) if (c.id !== undefined) catId.set(normalizeName(c.name), c.id);
  let order = data.categories.length;
  for (const name of STARTER_CATEGORIES) {
    if (catId.has(normalizeName(name))) continue;
    catId.set(normalizeName(name), await deps.create.category(name, order++));
    counts.categories++;
  }

  for (const s of STARTER_SERVICES) {
    if (present(data.services, s.name)) continue;
    const categoryId = catId.get(normalizeName(s.category));
    if (categoryId === undefined) continue; // never write a row we can't place
    await deps.create.service({
      name: s.name,
      categoryId,
      price: s.price,
      duration: s.duration,
    });
    counts.services++;
  }

  for (const p of STARTER_PRODUCTS) {
    if (present(data.products, p.name)) continue;
    await deps.create.product({
      name: p.name,
      price: p.price,
      stock: p.stock,
      lowStock: p.lowStock,
    });
    counts.products++;
  }

  for (const s of STARTER_STYLISTS) {
    if (present(data.stylists, s.name)) continue;
    await deps.create.stylist({ name: s.name, phone: s.phone, commissionPct: s.commissionPct });
    counts.stylists++;
  }

  return counts;
}

/** The toast sentence the owner is promised, verbatim. */
export const restoreReport = (c: RestoreCounts) =>
  `Added ${c.services} services, ${c.products} products, ${c.stylists} stylists`;
