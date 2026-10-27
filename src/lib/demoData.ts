/**
 * Demo data — detection and one-step removal.
 *
 * Every brand-new install is seeded (see `seedIfEmpty` in db.ts) with demo
 * staff, demo services, demo customers and default PINs. This module finds
 * those exact seeded rows and removes them in one operation, safely:
 *
 *  1. REFUSES when any real (non-demo) bill exists — bills are never seeded,
 *     so any paid/cancelled bill means the salon is live. Held bills are
 *     device-local drafts, not issued bills, so they do not count.
 *  2. Downloads an automatic local JSON backup FIRST; if the copy fails,
 *     nothing is deleted.
 *  3. Asks for an explicit confirmation.
 *  4. Deletes via the normal Dexie `delete()` calls, so the deleting hooks in
 *     db.ts enqueue every row and the outbox pushes them as `op: "del"` —
 *     ordinary tombstones that propagate to every other device.
 *
 * Detection is deliberately conservative: a row must match a seeded row's id
 * AND its identifying fields (name, plus phone for staff/customers), so a row
 * the salon has renamed or repurposed is treated as real data and kept.
 */

import {
  STARTER_CATEGORIES,
  STARTER_PRODUCTS,
  STARTER_SERVICES,
  STARTER_STYLISTS,
  db,
  type Bill,
  type Customer,
  type Product,
  type Service,
  type Stylist,
} from "./db";
import { downloadLocalBackup } from "./export";

/* ------------------------- the seeded demo rows -------------------------- */

/** Demo staff: seed ids 1-4 (db.ts seedIfEmpty). */
export const DEMO_STAFF: { id: number; name: string; phone: string }[] = [
  { id: 1, name: "Karthik", phone: "9840011111" },
  { id: 2, name: "Priya", phone: "9840022222" },
  { id: 3, name: "Arun", phone: "9840033333" },
  { id: 4, name: "Divya", phone: "9840044444" },
];

/** Demo services: seed ids 1-20 (db.ts seedIfEmpty). */
export const DEMO_SERVICES: { id: number; name: string }[] = [
  { id: 1, name: "Men's Haircut" },
  { id: 2, name: "Women's Haircut" },
  { id: 3, name: "Kids Haircut" },
  { id: 4, name: "Beard Trim & Styling" },
  { id: 5, name: "Blow Dry" },
  { id: 6, name: "Hair Spa (L'Oréal)" },
  { id: 7, name: "Keratin Treatment" },
  { id: 8, name: "Global Hair Colour" },
  { id: 9, name: "Root Touch-up" },
  { id: 10, name: "Highlights (per streak)" },
  { id: 11, name: "Fruit Facial" },
  { id: 12, name: "O3+ Facial" },
  { id: 13, name: "Threading – Eyebrows" },
  { id: 14, name: "Full Arms Waxing" },
  { id: 15, name: "D-Tan Pack" },
  { id: 16, name: "Head Massage" },
  { id: 17, name: "Full Body Massage" },
  { id: 18, name: "Classic Manicure" },
  { id: 19, name: "Pedicure Deluxe" },
  { id: 20, name: "Gel Polish" },
];

/** Demo customers: seed ids 1-6 (db.ts seedIfEmpty). */
export const DEMO_CUSTOMERS: { id: number; name: string; phone: string }[] = [
  { id: 1, name: "Lakshmi Narayanan", phone: "9841234567" },
  { id: 2, name: "Senthil Kumar", phone: "9884012345" },
  { id: 3, name: "Meena Ramesh", phone: "9789056789" },
  { id: 4, name: "Vignesh Subramanian", phone: "9962011223" },
  { id: 5, name: "Aishwarya Rajan", phone: "9003344556" },
  { id: 6, name: "Prakash Iyer", phone: "9444066778" },
];

/** Starter products: seed ids 1-3 (db.ts seedIfEmpty). */
export const DEMO_PRODUCTS: { id: number; name: string }[] = STARTER_PRODUCTS.map((p, i) => ({
  id: i + 1,
  name: p.name,
}));

/**
 * Name matching used by restore: case-, space- and punctuation-spacing
 * insensitive, so "arun" counts as "Arun" and "Men's  Haircut" as
 * "Men's Haircut". Trimmed + collapsed + lowercased.
 */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

/* --------------------------------- scan ---------------------------------- */

export type DemoScan = {
  stylists: number[];
  services: number[];
  products: number[];
  customers: number[];
};

/** Ids of rows that are still exactly the seeded demo rows (id + identity). */
export function scanDemoData(input: {
  stylists: Pick<Stylist, "id" | "name" | "phone">[];
  services: Pick<Service, "id" | "name">[];
  products: Pick<Product, "id" | "name">[];
  customers: Pick<Customer, "id" | "name" | "phone">[];
}): DemoScan {
  const isDemoStaff = (r: Pick<Stylist, "id" | "name" | "phone">) =>
    DEMO_STAFF.some((s) => r.id === s.id && r.name === s.name && r.phone === s.phone);
  const isDemoService = (r: Pick<Service, "id" | "name">) =>
    DEMO_SERVICES.some((s) => r.id === s.id && r.name === s.name);
  const isDemoProduct = (r: Pick<Product, "id" | "name">) =>
    DEMO_PRODUCTS.some((p) => r.id === p.id && r.name === p.name);
  const isDemoCustomer = (r: Pick<Customer, "id" | "name" | "phone">) =>
    DEMO_CUSTOMERS.some((c) => r.id === c.id && r.name === c.name && r.phone === c.phone);
  return {
    stylists: input.stylists.filter(isDemoStaff).map((r) => r.id as number),
    services: input.services.filter(isDemoService).map((r) => r.id as number),
    products: input.products.filter(isDemoProduct).map((r) => r.id as number),
    customers: input.customers.filter(isDemoCustomer).map((r) => r.id as number),
  };
}

/**
 * Bills are NEVER seeded, so any paid or cancelled bill is the salon's real
 * data and demo removal must refuse. Held bills are device-local drafts.
 */
export function hasRealBills(bills: Pick<Bill, "status">[]): boolean {
  return bills.some((b) => b.status === "paid" || b.status === "cancelled");
}

/* ------------------------------- removal --------------------------------- */

/**
 * What the owner actually ticked. Everything defaults to FALSE: no action
 * runs, and nothing in the catalog is removed, unless its own box is ticked
 * AND confirmed ("Clear starter services and products" is one action).
 */
export type RemoveSelection = {
  /** Remove demo customers (fake people). */
  customers: boolean;
  /** Remove starter staff (the seeded stylists). */
  staff: boolean;
  /** Clear starter services and products. */
  catalog: boolean;
};

export const NO_REMOVAL: RemoveSelection = { customers: false, staff: false, catalog: false };
/** Everything ticked — used by tests and any "remove all" affordance. */
export const ALL_REMOVALS: RemoveSelection = { customers: true, staff: true, catalog: true };

export type RemoveOutcome =
  | { ok: true; removed: DemoScan }
  | {
      ok: false;
      reason: "real-bills" | "no-demo" | "backup-failed" | "declined" | "nothing-selected";
    };

export type RemoveDeps = {
  load: () => Promise<{
    stylists: Pick<Stylist, "id" | "name" | "phone">[];
    services: Pick<Service, "id" | "name">[];
    products: Pick<Product, "id" | "name">[];
    customers: Pick<Customer, "id" | "name" | "phone">[];
    bills: Pick<Bill, "status">[];
  }>;
  confirm: (message: string) => boolean;
  /** Automatic safety copy — must succeed before anything is deleted. */
  backup: () => Promise<unknown>;
  remove: (scan: DemoScan) => Promise<void>;
};

export const defaultRemoveDeps: RemoveDeps = {
  load: async () => ({
    stylists: await db.stylists.toArray(),
    services: await db.services.toArray(),
    products: await db.products.toArray(),
    customers: await db.customers.toArray(),
    bills: await db.bills.toArray(),
  }),
  confirm: (message) => window.confirm(message),
  backup: () => downloadLocalBackup(),
  remove: async (scan) => {
    // Plain per-row Dexie deletes: the "deleting" hooks in db.ts enqueue each
    // row, and the sync outbox pushes `op: "del"` — normal tombstones.
    // (No bulk helper: per-row delete() is the path the sync hooks are built
    // and tested around.)
    await db.transaction("rw", [db.stylists, db.services, db.products, db.customers], async () => {
      for (const id of scan.stylists) await db.stylists.delete(id);
      for (const id of scan.services) await db.services.delete(id);
      for (const id of scan.products) await db.products.delete(id);
      for (const id of scan.customers) await db.customers.delete(id);
    });
  },
};

/**
 * Read-only preflight used by the cleanup card (and its tests): loads the
 * current rows and reports exactly which seeded demo rows are still present,
 * plus whether any real bill exists (which makes every removal refuse).
 * Never writes anything.
 */
export async function findDemoRows(
  overrides?: Partial<RemoveDeps>,
): Promise<{ scan: DemoScan; realBills: boolean }> {
  const deps = { ...defaultRemoveDeps, ...overrides };
  const data = await deps.load();
  return { scan: scanDemoData(data), realBills: hasRealBills(data.bills) };
}

/**
 * Demo removal with backup + confirmation + real-bills refusal, run only for
 * the boxes the owner ticked. Each action needs its own confirmation.
 */
export async function removeDemoData(
  selection: RemoveSelection = NO_REMOVAL,
  overrides?: Partial<RemoveDeps>,
): Promise<RemoveOutcome> {
  const deps = { ...defaultRemoveDeps, ...overrides };
  if (!selection.customers && !selection.staff && !selection.catalog)
    return { ok: false, reason: "nothing-selected" };

  const data = await deps.load();

  if (hasRealBills(data.bills)) return { ok: false, reason: "real-bills" };

  const found = scanDemoData(data);
  const scan: DemoScan = {
    stylists: selection.staff ? found.stylists : [],
    services: selection.catalog ? found.services : [],
    products: selection.catalog ? found.products : [],
    customers: selection.customers ? found.customers : [],
  };
  const total =
    scan.stylists.length + scan.services.length + scan.products.length + scan.customers.length;
  if (!total) return { ok: false, reason: "no-demo" };

  const parts: string[] = [];
  if (selection.staff) parts.push(`${scan.stylists.length} starter staff`);
  if (selection.catalog)
    parts.push(`${scan.services.length} services and ${scan.products.length} products`);
  if (selection.customers) parts.push(`${scan.customers.length} demo customers`);

  const declined = !deps.confirm(
    `Remove ${parts.join(" + ")}?\n\n` +
      "These rows will be deleted from this device and, via sync, from every other device.\n\n" +
      "A local backup is downloaded first — restore it to undo.",
  );
  if (declined) return { ok: false, reason: "declined" };

  try {
    await deps.backup();
  } catch (e) {
    console.error("demo removal backup failed", e);
    return { ok: false, reason: "backup-failed" }; // nothing was deleted
  }

  await deps.remove(scan);
  return { ok: true, removed: scan };
}

/* ------------------------------ restore ---------------------------------- */

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
