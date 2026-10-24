import Dexie, { type Table } from "dexie";
import { takeBillNumberSeq, takeRowId, type LeasedTable } from "@/lib/lease";
import { hashPin } from "@/lib/pins";

export type Category = { id?: number | undefined; name: string; order: number };
export type Service = {
  id?: number | undefined;
  name: string;
  categoryId: number;
  price: number;
  duration: number;
  gstRate: number;
  commissionPct: number;
  active: boolean;
};
export type Product = {
  id?: number | undefined;
  name: string;
  price: number;
  stock: number;
  lowStock: number;
  gstRate: number;
  active: boolean;
};
export type Stylist = {
  id?: number | undefined;
  name: string;
  phone: string;
  commissionPct: number;
  active: boolean;
  /**
   * Personal sign-in PIN — stored as a salted hash (`s1$…`, see lib/pins).
   * Legacy installs still hold plain digits until that member's next
   * successful sign-in, which migrates them.
   */
  pin?: string | undefined;
};
export type Customer = {
  id?: number | undefined;
  name: string;
  phone: string;
  birthday?: string | undefined;
  notes?: string | undefined;
  createdAt: number;
};
export type BillLine = {
  key: string;
  kind: "service" | "product";
  refId: number;
  name: string;
  price: number;
  qty: number;
  gstRate: number;
  commissionPct: number;
  /** Commission for this line, in rupees, snapshotted when the bill is saved
   *  (price × qty × commissionPct). Absent on bills saved before earnings
   *  tracking existed — views derive it from the snapshotted pct, or show
   *  "not recorded" when the pct is missing too. Never re-derived from the
   *  current catalog rates. */
  commissionAmount?: number | undefined;
  stylistId?: number | undefined;
  stylistName?: string | undefined;
};
export type Payment = { mode: "Cash" | "UPI" | "Card" | "Wallet"; amount: number };
/** Salon details captured at save time so historical reprints never change. */
export type ReceiptInfo = {
  salonName: string;
  address: string;
  phone: string;
  gstOn: boolean;
  gstin: string;
  footer: string;
  reviewUrl: string;
};
export type Bill = {
  id?: number | undefined;
  number: string;
  createdAt: number;
  status: "paid" | "held" | "cancelled";
  customerId?: number | undefined;
  customerName?: string | undefined;
  customerPhone?: string | undefined;
  lines: BillLine[];
  discountType: "flat" | "pct";
  discountValue: number;
  discountReason?: string | undefined;
  subtotal: number;
  discount: number;
  cgst: number;
  sgst: number;
  tip: number;
  total: number;
  payments: Payment[];
  /** Who rang the sale up — stamped from the signed-in staff session. */
  cashierId?: number | undefined;
  cashierName?: string | undefined;
  /**
   * Which physical device wrote this bill, stamped when the bill is saved.
   * Absent on bills saved before multi-device tracking existed — views show
   * "Unknown device" rather than guessing. Never derived from anything else.
   */
  deviceName?: string | undefined;
  /** Save instant as ISO-8601 with the IST (+05:30) offset, for exports. */
  createdAtIso?: string | undefined;
  cancelReason?: string | undefined;
  /** Who cancelled and when — set once; a cancel never rewrites these. */
  cancelledBy?: string | undefined;
  cancelledAt?: number | undefined;
  receipt?: ReceiptInfo | undefined;
};
export type Settings = {
  id: 1;
  salonName: string;
  address: string;
  phone: string;
  gstOn: boolean;
  gstin: string;
  footer: string;
  paper: "80mm" | "58mm";
  autoPrint: boolean;
  ownerPin: string;
  reviewUrl: string;
  billSeq: number;
  onboarded: boolean;
};
export type Audit = { id?: number | undefined; at: number; action: string; detail: string };
/** Unfinished bill kept per browser tab so a refresh never loses work. */
export type Draft = {
  id?: number | undefined;
  tabId: string;
  updatedAt: number;
  lines: BillLine[];
  discountType: "flat" | "pct";
  discountValue: number;
  tip: number;
  mode: Payment["mode"];
  customerId?: number | undefined;
  customerName?: string | undefined;
  customerPhone?: string | undefined;
  heldId?: number | undefined;
};
/** A local row that changed and still needs to be pushed to the cloud. */
export type SyncQueueItem = { key: string; table: string; id: number; at: number };

class SalonDB extends Dexie {
  categories!: Table<Category, number>;
  services!: Table<Service, number>;
  products!: Table<Product, number>;
  stylists!: Table<Stylist, number>;
  customers!: Table<Customer, number>;
  bills!: Table<Bill, number>;
  settings!: Table<Settings, number>;
  audit!: Table<Audit, number>;
  drafts!: Table<Draft, number>;
  syncQueue!: Table<SyncQueueItem, string>;
  constructor() {
    super("salonbill");
    this.version(1).stores({
      categories: "++id, order",
      services: "++id, categoryId, active",
      products: "++id, active",
      stylists: "++id, active",
      customers: "++id, phone, name",
      bills: "++id, number, createdAt, status, customerId",
      settings: "id",
      audit: "++id, at",
    });
    // v2 adds drafts only — additive, no data migration needed.
    this.version(2).stores({
      drafts: "++id, tabId, updatedAt",
    });
    // v3 adds the cloud-sync outbox — additive, no data migration needed.
    this.version(3).stores({
      syncQueue: "key, table, at",
    });
    // v4 stamps bills with the device that wrote them plus an IST ISO string,
    // and records who cancelled a bill. All additive and un-indexed: existing
    // rows keep loading untouched and simply read as "Unknown device" /
    // "not recorded" until a view can tell otherwise — we never guess a value
    // for historical data.
    this.version(4).stores({
      bills: "++id, number, createdAt, status, customerId",
    });
  }
}

export const db = new SalonDB();

/* ------------------------------ cloud sync ------------------------------- */

/** Tables replicated to the cloud. audit/drafts/syncQueue stay device-local. */
export const SYNCED_TABLES = [
  "categories",
  "services",
  "products",
  "stylists",
  "customers",
  "bills",
  "settings",
] as const;
type SyncedTable = (typeof SYNCED_TABLES)[number];

/** True while the sync engine is applying remote rows (suppresses re-enqueue). */
let applyingRemote = false;

/** Run a write without recording it as a local change (used when pulling). */
export async function runWithoutEnqueue<T>(fn: () => Promise<T>): Promise<T> {
  applyingRemote = true;
  try {
    return await fn();
  } finally {
    applyingRemote = false;
  }
}

/**
 * Changed rows waiting to be recorded in the outbox. Dexie forbids writing to
 * another table from inside a transaction's hook (and every write — the seed's
 * bulk puts, a settings.update, commitSale — runs its hooks inside one), so the
 * hooks only collect keys here; the outbox write happens on the next tick,
 * after the triggering transaction has committed. Without this defer the put
 * throws `TransactionInactiveError`, changes never enter the outbox, and a
 * device's edits silently never reach the cloud.
 */
let pendingEnqueue: { table: string; id: number }[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushEnqueued() {
  flushTimer = null;
  const batch = pendingEnqueue;
  pendingEnqueue = [];
  if (!batch.length) return;
  const at = Date.now();
  db.syncQueue
    .bulkPut(batch.map((p) => ({ key: `${p.table}#${p.id}`, table: p.table, id: p.id, at })))
    .catch((e) => console.warn("enqueueSync failed", e));
}

/** Record a changed row so the next sync pushes it. Dedupes via key table#id. */
export function enqueueSync(table: string, id: number) {
  if (applyingRemote) return;
  if (!(SYNCED_TABLES as readonly string[]).includes(table)) return;
  // Held bills are device-local (never pushed) and neither are their deletions.
  pendingEnqueue.push({ table, id });
  if (flushTimer === null) flushTimer = setTimeout(flushEnqueued, 0);
}

/** Minimal hook surface we register — keeps Dexie's overloads out of the way. */
type HookableTable = {
  hook: (name: string, fn: (...args: never[]) => unknown) => void;
};

/** Register change hooks that keep the sync outbox up to date. */
export function registerSyncHooks() {
  for (const t of SYNCED_TABLES) {
    const table = db[t] as unknown as HookableTable;
    const isHeld = (o: unknown) =>
      t === "bills" && (o as { status?: string } | null)?.status === "held";

    table.hook("creating", function (
      this: { onsuccess: (k: number) => void },
      primKey: number | undefined,
      obj: { status?: string } | undefined,
    ) {
      // Held bills are device-local; never queue them for the cloud.
      if (isHeld(obj)) return;
      if (typeof primKey === "number") enqueueSync(t, primKey);
      else this.onsuccess = (key: number) => enqueueSync(t, key);
    } as never);
    table.hook("updating", ((
      _mods: unknown,
      primKey: number,
      obj: { status?: string } | undefined,
    ) => {
      if (isHeld(obj)) return;
      if (typeof primKey === "number") enqueueSync(t, primKey);
    }) as never);
    table.hook("deleting", ((primKey: number, obj: { status?: string } | undefined) => {
      if (isHeld(obj)) return;
      if (typeof primKey === "number") enqueueSync(t, primKey);
    }) as never);
  }
}

// Register once per page load (idempotent across HMR).
if (!(globalThis as { __sbHooks?: boolean }).__sbHooks) {
  (globalThis as { __sbHooks?: boolean }).__sbHooks = true;
  registerSyncHooks();
}

/** Highest local row id for a table — used as the lease floor so a new block
 *  never overlaps ids this device already used. */
export async function localMaxId(table: string): Promise<number> {
  const tbl = (db as unknown as Record<string, Table<unknown, number> | undefined>)[table];
  if (!tbl) return 0;
  const rows = await tbl.orderBy("id").last();
  return (rows as { id?: number } | undefined)?.id ?? 0;
}

/** Allocate a globally-unique row id for a synced table (falls back to local
 *  max + 1 when offline). */
export async function nextRowId(table: LeasedTable): Promise<number> {
  const max = await localMaxId(table);
  return takeRowId(table, max);
}

/** Let the sync engine react to a backup restore (full re-push + replace). */
let onRestored: (() => void) | null = null;
export function setOnRestored(fn: (() => void) | null) {
  onRestored = fn;
}

export const defaultSettings: Settings = {
  id: 1,
  salonName: "Glow Studio Unisex Salon",
  address: "12, 2nd Avenue, Anna Nagar, Chennai 600040",
  phone: "+91 98400 12345",
  gstOn: true,
  gstin: "33ABCDE1234F1Z5",
  footer: "Thank you! Visit again ✨",
  paper: "80mm",
  autoPrint: false,
  ownerPin: "1234",
  reviewUrl: "https://g.page/r/glowstudio/review",
  billSeq: 0,
  onboarded: false,
};

export async function logAudit(action: string, detail: string) {
  await db.audit.add({ at: Date.now(), action, detail });
}
export async function seedIfEmpty() {
  if (await db.settings.get(1)) return;
  // Salted hashes from the very first write: a brand-new device never puts a
  // plain PIN into storage (or into the first sync push).
  const [ownerPin, staffPins] = await Promise.all([
    hashPin(defaultSettings.ownerPin),
    Promise.all(["1111", "2222", "3333", "4444"].map((p) => hashPin(p))),
  ]);
  await db.transaction(
    "rw",
    [db.settings, db.categories, db.services, db.products, db.stylists, db.customers],
    async () => {
      // Another tab may have seeded between our check and this transaction.

      if (await db.settings.get(1)) return;
      await db.settings.put({ ...defaultSettings, ownerPin });
      const cats = ["Hair", "Colour", "Skin", "Spa", "Nails"];
      // Explicit ids: seeds are deterministic on every fresh device and the
      // creating hook (which can't read an auto key) still records them.
      await db.categories.bulkPut(cats.map((name, order) => ({ id: order + 1, name, order })));
      const [hair, colour, skin, spa, nails] = [1, 2, 3, 4, 5] as const;
      const s = (
        id: number,
        name: string,
        categoryId: number,
        price: number,
        duration: number,
      ): Service => ({
        id,
        name,
        categoryId,
        price,
        duration,
        gstRate: 18,
        commissionPct: 10,
        active: true,
      });
      await db.services.bulkPut([
        s(1, "Men's Haircut", hair, 300, 30),
        s(2, "Women's Haircut", hair, 600, 45),
        s(3, "Kids Haircut", hair, 200, 20),
        s(4, "Beard Trim & Styling", hair, 150, 15),
        s(5, "Blow Dry", hair, 400, 30),
        s(6, "Hair Spa (L'Oréal)", hair, 1200, 60),
        s(7, "Keratin Treatment", hair, 4500, 150),
        s(8, "Global Hair Colour", colour, 2500, 90),
        s(9, "Root Touch-up", colour, 900, 45),
        s(10, "Highlights (per streak)", colour, 250, 15),
        s(11, "Fruit Facial", skin, 900, 45),
        s(12, "O3+ Facial", skin, 2800, 60),
        s(13, "Threading – Eyebrows", skin, 50, 10),
        s(14, "Full Arms Waxing", skin, 450, 30),
        s(15, "D-Tan Pack", skin, 600, 30),
        s(16, "Head Massage", spa, 350, 20),
        s(17, "Full Body Massage", spa, 2200, 60),
        s(18, "Classic Manicure", nails, 500, 40),
        s(19, "Pedicure Deluxe", nails, 800, 50),
        s(20, "Gel Polish", nails, 700, 40),
      ]);
      await db.products.bulkPut([
        {
          id: 1,
          name: "L'Oréal Shampoo 250ml",
          price: 450,
          stock: 12,
          lowStock: 3,
          gstRate: 18,
          active: true,
        },
        {
          id: 2,
          name: "Matrix Hair Serum",
          price: 350,
          stock: 2,
          lowStock: 3,
          gstRate: 18,
          active: true,
        },
        {
          id: 3,
          name: "Beardo Beard Oil",
          price: 299,
          stock: 8,
          lowStock: 2,
          gstRate: 18,
          active: true,
        },
      ]);
      // Default staff PINs so identity stamping works out of the box — the
      // owner changes them in Settings → Staff & PINs. Stored as salted
      // hashes; the demo digits (1111 / 2222 / 3333 / 4444) still sign in.
      await db.stylists.bulkPut([
        {
          id: 1,
          name: "Karthik",
          phone: "9840011111",
          commissionPct: 10,
          active: true,
          pin: staffPins[0],
        },
        {
          id: 2,
          name: "Priya",
          phone: "9840022222",
          commissionPct: 12,
          active: true,
          pin: staffPins[1],
        },
        {
          id: 3,
          name: "Arun",
          phone: "9840033333",
          commissionPct: 10,
          active: true,
          pin: staffPins[2],
        },
        {
          id: 4,
          name: "Divya",
          phone: "9840044444",
          commissionPct: 15,
          active: true,
          pin: staffPins[3],
        },
      ]);
      const now = Date.now();
      await db.customers.bulkPut(
        (
          [
            ["Lakshmi Narayanan", "9841234567"],
            ["Senthil Kumar", "9884012345"],
            ["Meena Ramesh", "9789056789"],
            ["Vignesh Subramanian", "9962011223"],
            ["Aishwarya Rajan", "9003344556"],
            ["Prakash Iyer", "9444066778"],
          ] as [string, string][]
        ).map(([name, phone], i) => ({ id: i + 1, name, phone, createdAt: now })),
      );
    },
  );
}

export const billNumberFor = (seq: number) => `SB-${String(seq).padStart(4, "0")}`;

/* ------------------------------ device identity -------------------------- */

const DEVICE_KEY = "sb-device-name";

/**
 * This device's display name ("Counter", "Owner phone"). Set the first time
 * the device connects to the salon cloud and stored locally — it identifies a
 * physical phone/tablet, so it deliberately does NOT sync (each device keeps
 * its own). Returns "" when never set: bills saved before this existed read
 * as "Unknown device" instead of borrowing another device's name.
 */
export function getDeviceName(): string {
  try {
    return localStorage.getItem(DEVICE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setDeviceName(name: string) {
  try {
    localStorage.setItem(DEVICE_KEY, name);
  } catch {
    /* private mode */
  }
}

const DEVICE_NAME_PROMPT =
  "Name this device (e.g. Counter, Owner phone) — shown on every bill it creates";

/**
 * Ask the owner to name this device, and return the name to store.
 *
 * `window.prompt` is not available everywhere: some webviews and automation
 * contexts throw `prompt() is not supported` instead of returning null. It
 * used to be called unguarded inside connect(), which aborted the connection
 * after the sync token was saved but BEFORE the device was named — so the
 * device stayed unnamed forever and every bill it wrote exported as
 * "Unknown device".
 *
 * The question is therefore best-effort: a thrown prompt, a dismissed
 * dialog, a non-string answer or a blank one all fall back to `suggested`, so
 * a name is always produced and connect() can never fail here.
 *
 * `ask` is injectable so the failure modes are testable without a dialog.
 */
export function askDeviceName(
  suggested: string,
  ask: (message: string, defaultValue: string) => string | null = (message, defaultValue) =>
    window.prompt(message, defaultValue),
): string {
  let answer: unknown;
  try {
    answer = ask(DEVICE_NAME_PROMPT, suggested);
  } catch {
    answer = null;
  }
  const clean = typeof answer === "string" ? answer.trim().slice(0, 40) : "";
  return clean || suggested;
}

/** Label used wherever a bill's device is shown. Never guessed. */
export const deviceLabel = (b: Bill) => b.deviceName?.trim() || "Unknown device";

/** Thrown inside commitSale; the whole transaction rolls back so no partial write happens. */
export class StockShortageError extends Error {
  readonly shortages: { name: string; available: number; wanted: number }[];
  constructor(shortages: { name: string; available: number; wanted: number }[]) {
    super("Insufficient stock");
    this.name = "StockShortageError";
    this.shortages = shortages;
  }
}

export type NewBill = Omit<Bill, "id" | "number">;

/**
 * Save a sale in ONE IndexedDB transaction: bill number increment, stock check and
 * decrement, held-bill cleanup, customer creation, bill insert. IndexedDB serialises
 * read/write transactions on the same stores across tabs, so two tabs clicking Save
 * at the same moment can never share a bill number, oversell stock, or write twice
 * for one click. A thrown error rolls back everything, including the number.
 */
export async function commitSale(opts: {
  draft: NewBill;
  heldId?: number | undefined;
  newCustomer?: { name: string; phone: string } | undefined;
}): Promise<Bill> {
  const { draft, heldId, newCustomer } = opts;

  // Reserve globally-unique bill number + row ids BEFORE opening the
  // transaction. The lease fetcher may hit the network, and a network call
  // cannot happen inside an IndexedDB transaction. A reserved-but-rolled-back
  // number is simply skipped (harmless); uniqueness is what matters.
  const s = (await db.settings.get(1)) ?? defaultSettings;
  const seq = await takeBillNumberSeq(s.billSeq + 1);
  const billId = await nextRowId("bills");
  const customerId = newCustomer ? await nextRowId("customers") : draft.customerId;

  return db.transaction("rw", [db.bills, db.products, db.settings, db.customers], async () => {
    if (newCustomer && customerId !== undefined) {
      await db.customers.put({ id: customerId, ...newCustomer, createdAt: Date.now() });
    }

    // Check stock BEFORE mutating anything, inside the transaction.
    const shortages: { name: string; available: number; wanted: number }[] = [];
    for (const l of draft.lines) {
      if (l.kind !== "product") continue;
      const p = await db.products.get(l.refId);
      if (!p || p.stock < l.qty)
        shortages.push({ name: l.name, available: p?.stock ?? 0, wanted: l.qty });
    }
    if (shortages.length) throw new StockShortageError(shortages);

    await db.settings.update(1, { billSeq: seq });
    for (const l of draft.lines) {
      if (l.kind !== "product") continue;
      await db.products
        .where("id")
        .equals(l.refId)
        .modify((p) => {
          p.stock -= l.qty;
        });
    }
    if (heldId !== undefined) await db.bills.delete(heldId);
    const number = billNumberFor(seq);
    await db.bills.put({ ...draft, id: billId, customerId, number });
    return { ...draft, id: billId, customerId, number };
  });
}

/**
 * The append-only cancel transform: returns a NEW bill with only the status
 * and cancellation stamp changed. Pure so the "never overwrite the original"
 * contract is unit-testable — every other field must come back identical.
 */
export function applyCancel(
  b: Bill,
  reason: string,
  cancelledBy: string | undefined,
  at: number,
): Bill {
  return { ...b, status: "cancelled", cancelReason: reason, cancelledBy, cancelledAt: at };
}

/**
 * A cancel reason must contain real text. Whitespace-only input (and null)
 * is rejected with a throw so a bill can never be cancelled with an empty-
 * looking reason; valid input is returned trimmed.
 */
export function normalizeCancelReason(raw: string | null | undefined): string {
  const reason = (raw ?? "").trim();
  if (!reason) throw new Error("A cancel reason is required");
  return reason;
}

/**
 * Cancel a paid bill and put its product stock back, atomically.
 *
 * APPEND-ONLY: the original row is never deleted or rewritten beyond its
 * status and the cancellation stamp (see applyCancel). Every original field
 * (lines, totals, cashier, device, receipt) is preserved so the bill can
 * still be reprinted, audited and exported exactly as it was issued. A second
 * cancel is refused, so product stock is restored exactly once.
 */
export async function cancelBill(
  id: number,
  reason: string,
  cancelledBy?: string | undefined,
): Promise<Bill> {
  // Reject a whitespace-only reason before anything is touched.
  const cleanReason = normalizeCancelReason(reason);
  return db.transaction("rw", [db.bills, db.products, db.audit], async () => {
    const b = await db.bills.get(id);
    if (!b) throw new Error("Bill not found");
    if (b.status !== "paid") throw new Error("Only paid bills can be cancelled");
    for (const l of b.lines) {
      if (l.kind !== "product") continue;
      await db.products
        .where("id")
        .equals(l.refId)
        .modify((p) => {
          p.stock += l.qty;
        });
    }
    const at = Date.now();
    const updated = applyCancel(b, cleanReason, cancelledBy, at);
    await db.bills.update(id, {
      status: "cancelled",
      cancelReason: cleanReason,
      cancelledBy,
      cancelledAt: at,
    });
    await db.audit.add({
      at,
      action: "bill.cancel",
      detail: `${b.number}: ${cleanReason}${cancelledBy ? ` (by ${cancelledBy})` : ""}`,
    });
    return updated;
  });
}

/* ------------------------- unfinished-bill drafts ------------------------- */

/** Stable per-tab id: survives refresh (sessionStorage), unique across open tabs. */
export function getTabId(): string {
  try {
    let id = sessionStorage.getItem("salonbill-tab");
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem("salonbill-tab", id);
    }
    return id;
  } catch {
    return "no-session";
  }
}

export async function saveDraft(d: Omit<Draft, "id" | "updatedAt">) {
  const tabId = d.tabId;
  const existing = await db.drafts.where("tabId").equals(tabId).first();
  const row: Omit<Draft, "id"> = { ...d, updatedAt: Date.now() };
  if (existing) await db.drafts.update(existing.id!, row);
  else await db.drafts.add(row as Draft);
}

export async function loadDraft(tabId: string) {
  return db.drafts.where("tabId").equals(tabId).first();
}

export async function clearDraft(tabId: string) {
  await db.drafts.where("tabId").equals(tabId).delete();
}

/** Drafts left behind by tabs that closed without saving (other tabs / crashed windows). */
export async function listOrphanDrafts(tabId: string) {
  const cutoff = Date.now() - 7 * 24 * 3600_000;
  return db.drafts.filter((d) => d.tabId !== tabId && d.updatedAt > cutoff).toArray();
}

export async function deleteDraftById(id: number) {
  await db.drafts.delete(id);
}

export async function pruneDrafts(days = 30) {
  await db.drafts
    .where("updatedAt")
    .below(Date.now() - days * 24 * 3600_000)
    .delete();
}

/* ----------------------------- backup restore ---------------------------- */

const RESTORABLE = [
  "categories",
  "services",
  "products",
  "stylists",
  "customers",
  "bills",
  "settings",
  "audit",
] as const;

/** Structural sanity check before touching any data. */
export function validateBackup(data: unknown): data is Record<string, unknown[]> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const rec = data as Record<string, unknown>;
  if (!Array.isArray(rec["bills"]) || !Array.isArray(rec["settings"])) return false;
  const bills = rec["bills"] as unknown[];
  return bills.every(
    (b) =>
      !!b &&
      typeof b === "object" &&
      typeof (b as Record<string, unknown>)["number"] === "string" &&
      Array.isArray((b as Record<string, unknown>)["lines"]),
  );
}

/**
 * Replace local records with a backup file, keeping bill numbering monotonic so a
 * restore can never cause a future duplicate bill number. Runs in one transaction:
 * a validation failure leaves local data untouched.
 */
export async function restoreBackup(data: Record<string, unknown[]>): Promise<{ bills: number }> {
  // Restore is a wholesale replace: don't enqueue every row individually.
  // Instead we clear the outbox and tell the sync engine to do a full push
  // with replaceAll so the cloud converges to exactly this backup.
  await runWithoutEnqueue(() =>
    db.transaction("rw", db.tables, async () => {
      const currentSeq = (await db.settings.get(1))?.billSeq ?? 0;
      await db.syncQueue.clear();
      for (const t of db.tables) {
        if ((RESTORABLE as readonly string[]).includes(t.name) === false) continue; // drafts are per-tab ephemera
        const rows = data[t.name];
        if (!Array.isArray(rows)) continue;
        if (t.name === "settings") {
          const incoming = (rows[0] ?? null) as Partial<Settings> | null;
          await t.put({
            ...defaultSettings,
            ...(incoming ?? {}),
            id: 1,
            billSeq: Math.max(currentSeq, incoming?.billSeq ?? 0),
          });
        } else {
          await t.clear();
          if (rows.length) await t.bulkPut(rows as never[]);
        }
      }
    }),
  );
  onRestored?.();
  const bills = await db.bills.count();
  return { bills };
}
