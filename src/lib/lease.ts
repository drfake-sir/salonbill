/**
 * Lease cache — makes bill numbers and row ids unique ACROSS DEVICES.
 *
 * The server hands out disjoint blocks (e.g. bill numbers 6-55 to device A,
 * 56-105 to device B). A device burns through its block locally and only hits
 * the network when the block runs out, so billing stays instant and works
 * offline. On the same device, blocks are consumed under a Web Lock so two
 * tabs can never hand out the same number.
 *
 * Block names double as the server's lease keys: "billno" and "row:<table>".
 */

const KEY = (name: string) => `sb-lease-${name}`;

export const BILLNO = "billno";
export const BILL_LEASE_SIZE = 50;
export const TABLE_LEASE_SIZE = 50;

export type LeaseBlock = { next: number; max: number };

/** Tables whose row ids must be globally unique (Dexie auto-increment tables). */
export const LEASED_TABLES = [
  "categories",
  "services",
  "products",
  "stylists",
  "customers",
  "bills",
] as const;
export type LeasedTable = (typeof LEASED_TABLES)[number];

export const rowLeaseKey = (table: LeasedTable | string) => `row:${table}`;

function read(name: string): LeaseBlock | null {
  try {
    const raw = localStorage.getItem(KEY(name));
    if (!raw) return null;
    const b = JSON.parse(raw) as LeaseBlock;
    if (!Number.isInteger(b?.next) || !Number.isInteger(b?.max)) return null;
    return b;
  } catch {
    return null;
  }
}

function write(name: string, b: LeaseBlock) {
  try {
    localStorage.setItem(KEY(name), JSON.stringify(b));
  } catch {
    /* storage full / private mode — allocation degrades gracefully */
  }
}

/** Web Locks when available (cross-tab atomicity); plain run otherwise. */
export async function withLock<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: unknown } }).navigator?.locks as
    { request: (n: string, cb: () => Promise<T>) => Promise<T> } | undefined;
  if (locks?.request) return locks.request(name, () => Promise.resolve(fn()));
  return fn();
}

/**
 * Take the next value from a named block, or null if the block is exhausted /
 * absent (caller must then fetch a new lease before creating a row).
 * Runs under a cross-tab lock so two tabs never share a number.
 */
export async function takeLease(name: string): Promise<number | null> {
  return withLock(`lease-${name}`, () => {
    const b = read(name);
    if (!b || b.next > b.max) return null;
    write(name, { ...b, next: b.next + 1 });
    return b.next;
  });
}

/** Install a freshly fetched block, keeping an unused allocation that is ahead. */
export function installLease(name: string, block: LeaseBlock) {
  const cur = read(name);
  if (cur && cur.next <= cur.max && cur.next > block.next) {
    write(name, { next: block.next, max: Math.max(cur.max, block.max) });
  } else {
    write(name, block);
  }
}

export class LeaseExhaustedOfflineError extends Error {
  constructor() {
    super("Could not reserve a bill number — connect to the internet and try again.");
    this.name = "LeaseExhaustedOfflineError";
  }
}

export type LeaseRequest = { billno?: number; tables?: Partial<Record<LeasedTable, number>> };
export type LeaseFloors = { billno: number; tables: Partial<Record<LeasedTable, number>> };
export type LeaseFetcher = (
  need: LeaseRequest,
  floors: LeaseFloors,
) => Promise<{
  billno?: LeaseBlock | undefined;
  tables: Partial<Record<LeasedTable, LeaseBlock>>;
}>;

let fetcher: LeaseFetcher | null = null;
/** syncClient injects the network fetcher so this module stays storage-only. */
export function setLeaseFetcher(f: LeaseFetcher | null) {
  fetcher = f;
}

/** Current local high-water per block key, used as the server-side floor hint. */
export type FloorSource = (blockKey: string) => Promise<number>;
let floorSource: FloorSource | null = null;
export function setLeaseFloorSource(f: FloorSource | null) {
  floorSource = f;
}

/** Ensure at least one usable value remains in the block; true when usable. */
async function ensureBlock(name: string, size: number): Promise<boolean> {
  const b = read(name);
  if (b && b.next <= b.max) return true;
  if (!fetcher) return false;
  const table = name.startsWith("row:") ? name.slice(4) : null;
  const need: LeaseRequest = table ? { tables: { [table]: size } } : { billno: size };
  const floors: LeaseFloors = {
    billno: 0,
    tables: {},
  };
  if (table) floors.tables[table as LeasedTable] = (await floorSource?.(name)) ?? 0;
  else floors.billno = (await floorSource?.(name)) ?? 0;
  const res = await fetcher(need, floors);
  const got = table ? res.tables[table as LeasedTable] : res.billno;
  if (!got) return false;
  installLease(name, got);
  return read(name) !== null;
}

/**
 * Allocate the next bill number, fetching a lease if the block ran out.
 * `fallbackSeq` is used when offline so a sale is never blocked by the network.
 */
export async function takeBillNumberSeq(fallbackSeq: number): Promise<number> {
  const local = await takeLease(BILLNO);
  if (local !== null) return local;
  try {
    if (fetcher && (await ensureBlock(BILLNO, BILL_LEASE_SIZE))) {
      const again = await takeLease(BILLNO);
      if (again !== null) return again;
    }
  } catch {
    /* offline */
  }
  return fallbackSeq;
}

/** Allocate the next row id for a synced table (offline fallback: local max + 1). */
export async function takeRowId(table: LeasedTable, localMax: number): Promise<number> {
  const key = rowLeaseKey(table);
  const local = await takeLease(key);
  if (local !== null) return local;
  try {
    if (fetcher && (await ensureBlock(key, TABLE_LEASE_SIZE))) {
      const again = await takeLease(key);
      if (again !== null) return again;
    }
  } catch {
    /* offline */
  }
  return localMax + 1;
}

/** Ask the server for fresh blocks of every exhausted leased block (bootstrap). */
export async function topUpAllLeases(size = TABLE_LEASE_SIZE): Promise<void> {
  if (!fetcher) return;
  const tables: Partial<Record<LeasedTable, number>> = {};
  const need: LeaseRequest = { tables };
  const floors: LeaseFloors = { billno: 0, tables: {} };
  const billBlock = read(BILLNO);
  if (!billBlock || billBlock.next > billBlock.max) {
    need.billno = size;
    floors.billno = (await floorSource?.(BILLNO)) ?? 0;
  }
  for (const t of LEASED_TABLES) {
    const key = rowLeaseKey(t);
    const b = read(key);
    if (!b || b.next > b.max) {
      tables[t] = size;
      floors.tables[t] = (await floorSource?.(key)) ?? 0;
    }
  }
  const wanted = Object.keys(tables);
  if (!need.billno && !wanted.length) return;
  const res = await fetcher(need, floors);
  if (res.billno) installLease(BILLNO, res.billno);
  for (const [t, b] of Object.entries(res.tables ?? {})) {
    if (b) installLease(rowLeaseKey(t), b);
  }
}
