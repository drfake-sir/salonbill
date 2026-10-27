/**
 * SalonBill sync protocol (store-agnostic).
 *
 * Every synced row lives in one server table keyed by (table, id) with a
 * server-assigned `server_at` timestamp:
 *  - push "put"  → last-writer-wins by server arrival time (or insert-if-absent
 *    for a device's first sync, so a fresh device can never clobber edits that
 *    already exist on the server)
 *  - push "del"  → tombstone, returned to other devices as data: null
 *  - pull        → rows with server_at >= the client's cursor (idempotent,
 *    so a lost response just re-sends rows)
 *  - leases      → blocks of globally unique row ids and bill numbers allocated
 *    atomically from a counter floored by the current max, so two devices can
 *    never issue the same bill number or row id even while working offline.
 *
 * Auth is a shared salon PIN: the first device to connect sets it, everyone
 * else proves knowledge of the PIN. The server only ever stores salt + hash.
 */

export const SYNCED_TABLES = [
  "categories",
  "services",
  "products",
  "stylists",
  "customers",
  "bills",
  "settings",
] as const;
export type SyncedTable = (typeof SYNCED_TABLES)[number];

export const isSyncedTable = (t: unknown): t is SyncedTable =>
  typeof t === "string" && (SYNCED_TABLES as readonly string[]).includes(t);

/** JSON-serializable value — required by TanStack Start server functions. */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
/** A synced row as it travels over the wire. */
export type Row = Record<string, Json>;

/** One local change. `data` is omitted for deletes. */
export type PushItem = {
  t: string;
  id: number;
  op: "put" | "del";
  data?: Row | undefined;
};

export type PullRow = { t: string; id: number; data: Row | null };

export type LeaseBlock = { next: number; max: number };

export type SyncRequest = {
  deviceId: string;
  token: string;
  cursor: number;
  /** true on a device's very first sync: push is insert-if-absent. */
  firstSync?: boolean | undefined;
  push?: PushItem[] | undefined;
  /** Tables whose pushed id-set is authoritative (backup restore): rows on the
   *  server not in this set are deleted. */
  replaceAll?: Record<string, number[]> | undefined;
  /** Leases the client needs this round, e.g. { bills: 50, customers: 20 }. */
  lease?: Record<string, number> | undefined;
};

export type SyncResponse = {
  ok: boolean;
  error?: "auth" | "bad" | undefined;
  cursor: number;
  pull: PullRow[];
  /** true when the pull hit its row cap — the client should call again. */
  capped: boolean;
  applied: number;
  leases: Record<string, LeaseBlock>;
};

export type AuthRequest = {
  pin?: string | undefined;
  token?: string | undefined;
  /**
   * Forgot-owner-PIN recovery: verify the caller knows the salon cloud PIN
   * WITHOUT any side effect — an empty server refuses instead of adopting the
   * supplied PIN, and a supplied token never triggers a rotation. The server's
   * existing lockout still applies to failed attempts.
   */
  verifyOnly?: boolean | undefined;
};
export type AuthResponse = {
  ok: boolean;
  token?: string | undefined;
  error?: string | undefined;
  /**
   * Status signal (optional): is a salon PIN already configured on this
   * cloud? Returned on every auth response — most importantly on the
   * side-effect-free probe below — so a fresh device can pick its connect
   * screen wording ("Enter your salon PIN" vs "Create a salon PIN (first
   * device only)") without ever learning whether a PIN it types is correct.
   * Optional: older clients ignore it.
   */
  salonPinSet?: boolean | undefined;
};

export type AuthRecord = { salt: string; hash: string };

export interface SyncStore {
  getAuth(): Promise<AuthRecord | null>;
  setAuth(rec: AuthRecord): Promise<void>;
  /** Rows with server_at >= cursor, ordered by server_at, table, id. */
  rowsSince(
    cursor: number,
    limit: number,
  ): Promise<{ t: string; id: number; data: string | null; server_at: number }[]>;
  /** Apply puts/deletes. Returns how many puts changed stored content. */
  upsert(items: PushItem[], serverAt: number, mode: "lww" | "absent"): Promise<{ applied: number }>;
  /** For backup restore: delete rows of each table not in the given id set. */
  deleteNotIn(sets: Record<string, number[]>, serverAt: number): Promise<void>;
  /** Current max row id stored for a table (0 when empty). */
  maxId(table: string): Promise<number>;
  /** Highest bill number (SB-####) stored, 0 when none. */
  maxBillNo(): Promise<number>;
  /** Atomically reserve [floor+1 .. floor+size] and return the new high-water. */
  reserve(key: string, floor: number, size: number): Promise<LeaseBlock>;
  /** Read a scalar counter (auth lockout state). Missing keys read as 0. */
  getCounter(key: string): Promise<number>;
  /** Write a scalar counter (auth lockout state). */
  setCounter(key: string, value: number): Promise<void>;
}

export const PULL_LIMIT = 500;
export const PUSH_LIMIT = 400;
const MAX_TABLE_LEASE = 200;
const MAX_BILL_LEASE = 100;

/** Salon PINs must be at least 6 digits — 4 is brute-forceable from a phone. */
export const MIN_PIN_DIGITS = 6;
export const MAX_PIN_DIGITS = 8;
const PIN_RE = new RegExp(`^\\d{${MIN_PIN_DIGITS},${MAX_PIN_DIGITS}}$`);
const pinError = `Enter a ${MIN_PIN_DIGITS}-${MAX_PIN_DIGITS} digit PIN to set up this device`;

/** Server-side brute-force guard: N wrong attempts locks the salon PIN. */
export const AUTH_MAX_ATTEMPTS = 5;
export const AUTH_LOCKOUT_MS = 5 * 60_000; // 5 minutes
const AUTH_ATTEMPTS_KEY = "auth_attempts";
const AUTH_LOCK_KEY = "auth_lock_until";

export async function hashToken(pin: string, salt: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${pin}:${salt}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const randomSalt = () =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const isIntId = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

/**
 * Verify or establish the shared PIN auth.
 *  - no auth on server yet  → the supplied PIN becomes the salon PIN
 *  - valid token            → refresh (also used right after a PIN change if
 *                             the client sends the new pin alongside the old
 *                             valid token, rotating the stored hash)
 */
export async function runAuth(store: SyncStore, req: AuthRequest): Promise<AuthResponse> {
  const existing = await store.getAuth();
  const pin = (req.pin ?? "").trim();
  const salonPinSet = !!existing;

  // Status probe: a fresh device asking ONLY whether this cloud has a salon
  // PIN yet (it drives the connect screen's wording). No PIN, no token, no
  // verifyOnly — so no side effect of any kind: it runs before the lockout
  // check, never counts as a failed attempt (a reload-heavy page can't lock
  // the salon out), never adopts or rotates a PIN, and reveals nothing but
  // "configured or not" — never whether any PIN is correct.
  if (!pin && !req.token && !req.verifyOnly) {
    return { ok: false, error: pinError, salonPinSet };
  }

  // Locked out? Enforced server-side so a client can't reset the counter.
  const lockedUntil = await store.getCounter(AUTH_LOCK_KEY);
  if (lockedUntil > Date.now()) {
    const mins = Math.ceil((lockedUntil - Date.now()) / 60_000);
    return {
      ok: false,
      error: `Too many wrong PIN attempts — try again in ${mins} minute${mins === 1 ? "" : "s"}`,
      salonPinSet,
    };
  }

  const recordFailure = async () => {
    const attempts = (await store.getCounter(AUTH_ATTEMPTS_KEY)) + 1;
    if (attempts >= AUTH_MAX_ATTEMPTS) {
      await store.setCounter(AUTH_ATTEMPTS_KEY, 0);
      await store.setCounter(AUTH_LOCK_KEY, Date.now() + AUTH_LOCKOUT_MS);
      return `Too many wrong PIN attempts — locked for ${Math.round(AUTH_LOCKOUT_MS / 60_000)} minutes`;
    }
    await store.setCounter(AUTH_ATTEMPTS_KEY, attempts);
    return "Wrong PIN";
  };
  const recordSuccess = async () => {
    await store.setCounter(AUTH_ATTEMPTS_KEY, 0);
    await store.setCounter(AUTH_LOCK_KEY, 0);
  };

  // Recovery check: pure verification of an already-configured salon PIN.
  if (req.verifyOnly) {
    if (!existing)
      return {
        ok: false,
        error: "Salon cloud PIN is not set yet — connect a device first",
        salonPinSet: false,
      };
    if (PIN_RE.test(pin) && (await hashToken(pin, existing.salt)) === existing.hash) {
      await recordSuccess();
      return { ok: true, token: existing.hash, salonPinSet: true };
    }
    return { ok: false, error: await recordFailure(), salonPinSet: true };
  }

  if (!existing) {
    if (!PIN_RE.test(pin)) return { ok: false, error: pinError };
    const salt = randomSalt();
    const hash = await hashToken(pin, salt);
    await store.setAuth({ salt, hash });
    await recordSuccess();
    return { ok: true, token: hash, salonPinSet: true };
  }
  if (req.token && req.token === existing.hash) {
    // A PIN supplied alongside a valid token is a deliberate rotation.
    if (pin && PIN_RE.test(pin)) {
      const hash = await hashToken(pin, existing.salt);
      if (hash !== existing.hash) {
        await store.setAuth({ salt: existing.salt, hash });
        await recordSuccess();
        return { ok: true, token: hash };
      }
    }
    await recordSuccess();
    return { ok: true, token: existing.hash, salonPinSet: true };
  }
  // Fresh setup attempt on an already-configured server: only valid if the
  // caller still knows a valid token (rotation). Otherwise plain PIN check.
  if (pin) {
    const hash = await hashToken(pin, existing.salt);
    if (hash === existing.hash) {
      await recordSuccess();
      return { ok: true, token: hash, salonPinSet: true };
    }
  }
  return { ok: false, error: await recordFailure(), salonPinSet: true };
}

const cleanPush = (push: PushItem[] | undefined): PushItem[] => {
  if (!Array.isArray(push)) return [];
  return push
    .filter(
      (p) =>
        p &&
        isSyncedTable(p.t) &&
        isIntId(p.id) &&
        (p.op === "del" || (p.op === "put" && p.data && typeof p.data === "object")),
    )
    .slice(0, PUSH_LIMIT)
    .map((p) =>
      p.op === "del"
        ? { t: p.t, id: p.id, op: "del" as const }
        : { t: p.t, id: p.id, op: "put" as const, data: p.data as Row },
    );
};

export async function runSync(store: SyncStore, req: SyncRequest): Promise<SyncResponse> {
  const fail = (error: "auth" | "bad"): SyncResponse => ({
    ok: false,
    error,
    cursor: 0,
    pull: [],
    capped: false,
    applied: 0,
    leases: {},
  });

  if (!req || typeof req.token !== "string" || typeof req.deviceId !== "string") return fail("bad");
  const auth = await store.getAuth();
  if (!auth || auth.hash !== req.token) return fail("auth");

  const cursor = Number.isFinite(req.cursor) && req.cursor > 0 ? Math.floor(req.cursor) : 0;
  const start = Date.now();

  // 1. push — server timestamps every row (arrival order = conflict order)
  const items = cleanPush(req.push);
  let applied = 0;
  if (items.length) {
    applied = (await store.upsert(items, start, req.firstSync ? "absent" : "lww")).applied;
  }

  // 2. backup restore: rows on the server missing from the client's set go away
  if (req.replaceAll && typeof req.replaceAll === "object") {
    const sets: Record<string, number[]> = {};
    for (const [t, ids] of Object.entries(req.replaceAll)) {
      if (isSyncedTable(t) && Array.isArray(ids)) sets[t] = ids.filter(isIntId).slice(0, 20000);
    }
    if (Object.keys(sets).length) await store.deleteNotIn(sets, start);
  }

  // 3. pull — capped pages so a fresh device can drain a large history safely
  const rows = await store.rowsSince(cursor, PULL_LIMIT);
  const capped = rows.length >= PULL_LIMIT;
  const last = rows[rows.length - 1];
  const pull: PullRow[] = rows.map((r) => ({
    t: r.t,
    id: r.id,
    data: r.data === null ? null : (JSON.parse(r.data) as Row),
  }));

  // 4. leases — floors come from the data we just stored, so an allocation can
  //    never hand out an id/number that already exists.
  const leases: Record<string, LeaseBlock> = {};
  if (req.lease && typeof req.lease === "object") {
    for (const [key, sizeRaw] of Object.entries(req.lease)) {
      const size = Math.floor(Number(sizeRaw));
      if (!Number.isFinite(size) || size <= 0) continue;
      if (key === "billno") {
        const floor = await store.maxBillNo();
        leases["billno"] = await store.reserve("billno", floor, Math.min(size, MAX_BILL_LEASE));
      } else if (key.startsWith("row:")) {
        const t = key.slice(4);
        if (!isSyncedTable(t)) continue;
        const floor = await store.maxId(t);
        leases[key] = await store.reserve(key, floor, Math.min(size, MAX_TABLE_LEASE));
      }
    }
  }

  return {
    ok: true,
    cursor: capped && last ? last.server_at : start,
    pull,
    capped,
    applied,
    leases,
  };
}
