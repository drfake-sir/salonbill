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

import { db, type Bill, type Customer, type Service, type Stylist } from "./db";
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

/* --------------------------------- scan ---------------------------------- */

export type DemoScan = {
  stylists: number[];
  services: number[];
  customers: number[];
};

/** Ids of rows that are still exactly the seeded demo rows (id + identity). */
export function scanDemoData(input: {
  stylists: Pick<Stylist, "id" | "name" | "phone">[];
  services: Pick<Service, "id" | "name">[];
  customers: Pick<Customer, "id" | "name" | "phone">[];
}): DemoScan {
  const isDemoStaff = (r: Pick<Stylist, "id" | "name" | "phone">) =>
    DEMO_STAFF.some((s) => r.id === s.id && r.name === s.name && r.phone === s.phone);
  const isDemoService = (r: Pick<Service, "id" | "name">) =>
    DEMO_SERVICES.some((s) => r.id === s.id && r.name === s.name);
  const isDemoCustomer = (r: Pick<Customer, "id" | "name" | "phone">) =>
    DEMO_CUSTOMERS.some((c) => r.id === c.id && r.name === c.name && r.phone === c.phone);
  return {
    stylists: input.stylists.filter(isDemoStaff).map((r) => r.id as number),
    services: input.services.filter(isDemoService).map((r) => r.id as number),
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

export type RemoveOutcome =
  | { ok: true; removed: DemoScan }
  | { ok: false; reason: "real-bills" | "no-demo" | "backup-failed" | "declined" };

export type RemoveDeps = {
  load: () => Promise<{
    stylists: Pick<Stylist, "id" | "name" | "phone">[];
    services: Pick<Service, "id" | "name">[];
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
    await db.transaction("rw", [db.stylists, db.services, db.customers], async () => {
      for (const id of scan.stylists) await db.stylists.delete(id);
      for (const id of scan.services) await db.services.delete(id);
      for (const id of scan.customers) await db.customers.delete(id);
    });
  },
};

/** One-step demo removal with backup + confirmation + real-bill refusal. */
export async function removeDemoData(overrides?: Partial<RemoveDeps>): Promise<RemoveOutcome> {
  const deps = { ...defaultRemoveDeps, ...overrides };
  const data = await deps.load();

  if (hasRealBills(data.bills)) return { ok: false, reason: "real-bills" };

  const scan = scanDemoData(data);
  const total = scan.stylists.length + scan.services.length + scan.customers.length;
  if (!total) return { ok: false, reason: "no-demo" };

  const declined = !deps.confirm(
    "Remove demo data?\n\n" +
      `${scan.stylists.length} demo staff, ${scan.services.length} demo services and ` +
      `${scan.customers.length} demo customers will be deleted from this device and, ` +
      "via sync, from every other device.\n\n" +
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
