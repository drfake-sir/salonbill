/**
 * Client sync engine.
 *
 * Responsibilities:
 *  - Bootstrap: exchange the salon PIN for a sync token (first device sets it).
 *  - Push: drain the local `syncQueue` outbox (built by db.ts write hooks).
 *  - Pull: apply remote rows since a cursor, atomically, without re-enqueueing.
 *  - Leases: hand the lease module a network fetcher so bill numbers / row ids
 *    stay globally unique without blocking billing on every save.
 *
 * Everything degrades gracefully: with no token or no network the app is a
 * plain offline POS. Sync only adds convergence on top.
 */

import {
  db,
  runWithoutEnqueue,
  setOnRestored,
  SYNCED_TABLES,
  localMaxId,
  getDeviceName,
  setDeviceName,
  type SyncQueueItem,
} from "./db";
import {
  BILLNO,
  LEASED_TABLES,
  setLeaseFetcher,
  setLeaseFloorSource,
  topUpAllLeases,
  type LeasedTable,
  type LeaseBlock,
  type LeaseFloors,
  type LeaseRequest,
} from "./lease";
import { syncAuthFn, syncPushFn } from "@/syncFns";
import type { PushItem, Row, SyncRequest } from "@/server/syncCore";

/* --------------------------------- state --------------------------------- */

const LS = {
  device: "sb-sync-device",
  token: "sb-sync-token",
  cursor: "sb-sync-cursor",
  synced: "sb-sync-done", // "1" once this device has completed a full first sync
  ever: "sb-sync-ever-connected", // "1" once this device EVER held a token
  last: "sb-sync-last", // ms timestamp of the last successful sync (survives reload)
} as const;

const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
  del: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* private mode */
    }
  },
};

export type SyncPhase = "disabled" | "connecting" | "syncing" | "online" | "error";

/**
 * Warn the owner once bills have sat on this device unsynced this long.
 *
 * 3 h is long enough to survive a normal lunch-time network outage and short
 * enough that a day's takings are never quietly left off the cloud — if this
 * phone is lost, everything past this point is lost with it.
 */
export const UNSYNCED_WARN_MS = 3 * 60 * 60 * 1000;

/** True when the last successful sync is older than the warning threshold. */
export function isUnsyncedStale(lastSyncAt: number | null, now: number): boolean {
  return lastSyncAt !== null && now - lastSyncAt > UNSYNCED_WARN_MS;
}

export type SyncStatus = {
  phase: SyncPhase;
  /** true when the server has no PIN yet and this device will set it. */
  needsPin: boolean;
  lastSyncAt: number | null;
  error: string | null;
};

const persistedLastSync = () => {
  const n = Number(ls.get(LS.last) ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
};

let status: SyncStatus = {
  phase: "disabled",
  needsPin: false,
  lastSyncAt: persistedLastSync(),
  error: null,
};
const listeners = new Set<() => void>();

export function getSyncStatus(): SyncStatus {
  return status;
}
export function subscribeSync(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function setStatus(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch };
  for (const l of listeners) l();
}

export function getDeviceId(): string {
  let id = ls.get(LS.device);
  if (!id) {
    id = `dev-${crypto.randomUUID().slice(0, 8)}`;
    ls.set(LS.device, id);
  }
  return id;
}

export const hasToken = () => !!ls.get(LS.token);

/**
 * True once this device has EVER been connected to the salon cloud.
 *
 * This is the offline-safety latch: once a device has joined the salon, a
 * missing network must never lock billing behind the connect screen again.
 * A device that has never connected still has to complete the gate, because
 * that first upload is the only guarantee its bills get copied off it.
 */
export const everConnected = () => ls.get(LS.ever) === "1";

/**
 * Turn a thrown sync failure into copy a salon owner can act on.
 *
 * The four cases are genuinely different problems with different fixes, so
 * they get different words; anything unrecognised falls back to a generic
 * server error. The underlying error is always logged by the caller, so the
 * technical detail is never lost — it just never reaches the counter screen.
 */
export function friendlySyncError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // The server's own semantic failures travel as a bare token, not an Error.
  if (msg === "auth" || /\bauth\b|wrong pin|token/i.test(msg)) return "Wrong PIN";
  if (/fetch|network|Failed to fetch|ECONN|offline|timed? ?out/i.test(msg)) return "No internet";
  // Thrown by the server when the Worker has no D1 binding.
  if (/cloud database is not available/i.test(msg))
    return "Cloud database is not available on this server";
  return "Server error, try again";
}

/** The raw sync token (proof of salon-PIN knowledge) — used to authorise
 *  owner actions like a manual cloud backup. Never leaves the device except
 *  in those authenticated calls. */
export const getSyncToken = () => ls.get(LS.token);

/** true once this device has completed its very first full sync (the cloud
 *  copy of the local dataset exists). Used to gate billing on first setup. */
export const isFirstSyncDone = () => ls.get(LS.synced) === "1";

/** ms of the last successful sync, or null if this device never synced. */
export const lastSyncAt = () => persistedLastSync();

/* ------------------------------ lease wiring ------------------------------ */

// Bill numbers floor above the highest bill number already stored locally.
setLeaseFloorSource(async (blockKey: string) => {
  if (blockKey === BILLNO) return (await db.settings.get(1))?.billSeq ?? 0;
  const table = blockKey.replace(/^row:/, "");
  if ((LEASED_TABLES as readonly string[]).includes(table)) return localMaxId(table);
  return 0;
});

setLeaseFetcher(async (need: LeaseRequest, floors: LeaseFloors) => {
  const token = ls.get(LS.token);
  if (!token) return { tables: {} };
  const lease: NonNullable<SyncRequest["lease"]> = {};
  if (need.billno) lease["billno"] = need.billno;
  for (const [t, n] of Object.entries(need.tables ?? {})) if (n) lease[`row:${t}`] = n;
  const res = await syncPushFn({
    data: { deviceId: getDeviceId(), token, cursor: 0, lease },
  });
  const tables: Partial<Record<LeasedTable, LeaseBlock>> = {};
  for (const [k, b] of Object.entries(res.leases ?? {})) {
    if (k.startsWith("row:")) tables[k.slice(4) as LeasedTable] = b;
  }
  return { billno: res.leases?.["billno"], tables };
});

/* --------------------------------- bootstrap ------------------------------ */

/**
 * Connect this device to the salon cloud. On the very first device, `pin`
 * becomes the salon PIN stored (hashed) on the server. On later devices the
 * same PIN authenticates. Returns true on success.
 */
export async function connect(pin?: string): Promise<{ ok: boolean; error?: string }> {
  setStatus({ phase: "connecting", error: null });
  try {
    const token = ls.get(LS.token);
    const res = await syncAuthFn({ data: { token: token ?? undefined, pin } });
    if (!res.ok) {
      // The server already words its own errors ("Wrong PIN", PIN-too-short);
      // only fall back to the generic mapping when it sends nothing usable.
      setStatus({ phase: "error", needsPin: true, error: res.error ?? "Wrong PIN" });
      return { ok: false, error: res.error ?? "Wrong PIN" };
    }
    if (res.token) ls.set(LS.token, res.token);
    // Latch: from now on this device may bill offline without hitting the gate.
    ls.set(LS.ever, "1");
    // Name this device the first time it joins, so bills can say WHICH phone
    // or tablet wrote them. Asked once, then never again.
    if (!getDeviceName()) {
      const suggested = `Device ${getDeviceId().slice(-4)}`;
      const name = window.prompt(
        "Name this device (e.g. Counter, Owner phone) — shown on every bill it creates",
        suggested,
      );
      const clean = (name ?? "").trim().slice(0, 40);
      setDeviceName(clean || suggested);
    }
    setStatus({ needsPin: false });
    await syncNow({ forceFirst: true });
    return { ok: true };
  } catch (e) {
    const msg = friendlySyncError(e);
    console.error("sync connect failed", e);
    setStatus({ phase: "error", error: msg });
    return { ok: false, error: msg };
  }
}

export function disconnect() {
  ls.del(LS.token);
  ls.del(LS.cursor);
  ls.del(LS.synced);
  ls.del(LS.last);
  setStatus({ phase: "disabled", needsPin: false, lastSyncAt: null, error: null });
}

/* ------------------------------ push / pull -------------------------------- */

let running = false;
let queued = false;

/** Run one sync cycle. Safe to call often; concurrent calls collapse. */
export async function syncNow(opts?: { forceFirst?: boolean }): Promise<void> {
  if (running) {
    queued = true;
    return;
  }
  const token = ls.get(LS.token);
  if (!token) return;
  running = true;
  setStatus({ phase: "syncing" });
  try {
    await drain(token, opts?.forceFirst ?? false);
    // If new local changes arrived while we were syncing, loop once more.
    if (queued) {
      queued = false;
      await drain(token, false);
    }
    const at = Date.now();
    ls.set(LS.last, String(at));
    setStatus({ phase: "online", lastSyncAt: at, error: null });
  } catch (e) {
    // A sync failure must never be mistaken for a lost session: the token
    // stays, the queue keeps its rows, and billing continues offline.
    const authy = e instanceof Error && /\bauth\b|wrong pin|token/i.test(e.message);
    const msg = authy ? "Wrong PIN" : friendlySyncError(e);
    console.error("sync cycle failed", e);
    setStatus({ phase: "error", error: msg, needsPin: authy || status.needsPin });
  } finally {
    running = false;
  }
}

const PUSH_CHUNK = 400; // server cap per call

async function drain(token: string, forceFirst: boolean) {
  const firstSync = forceFirst || ls.get(LS.synced) !== "1";

  if (firstSync) {
    // First sync uploads the ENTIRE local dataset, not just the outbox: rows
    // seeded or written before the outbox existed (fresh installs, upgrades
    // from pre-sync versions, backup restores) must reach the cloud too.
    const all = await fullDatasetPush();
    const replaceAll = await fullReplaceSets();
    let cursor = Number(ls.get(LS.cursor) ?? 0) || 0;

    // Send in chunks of the server cap; the final chunk (or an empty dataset)
    // carries firstSync so the server finishes its replace step, and only then
    // is this device marked as having completed its first sync.
    const chunks: PushItem[][] = [];
    for (let i = 0; i < all.length; i += PUSH_CHUNK) chunks.push(all.slice(i, i + PUSH_CHUNK));
    if (!chunks.length) chunks.push([]);

    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      const res = await syncPushFn({
        data: {
          deviceId: getDeviceId(),
          token,
          cursor,
          firstSync: last,
          push: chunks[i],
          replaceAll,
        },
      });
      if (!res.ok)
        throw new Error(res.error === "auth" ? "auth: session expired" : "sync rejected");
      await applyPull(res.pull);
      cursor = res.cursor;
      if (last) ls.set(LS.synced, "1");
    }
    ls.set(LS.cursor, String(cursor));
    // Everything local was uploaded, so the outbox is fully superseded.
    await db.syncQueue.clear();
    return;
  }

  const cursor = Number(ls.get(LS.cursor) ?? 0) || 0;
  const push = await buildOutboxPush();

  const res = await syncPushFn({
    data: {
      deviceId: getDeviceId(),
      token,
      cursor,
      firstSync: false,
      push,
    },
  });

  if (!res.ok) throw new Error(res.error === "auth" ? "auth: session expired" : "sync rejected");

  await applyPull(res.pull);
  ls.set(LS.cursor, String(res.cursor));
  await clearPushed(push, res.applied);
}

/** Every synced local row, ready for the first-sync upload. Held bills skipped. */
async function fullDatasetPush(): Promise<PushItem[]> {
  const items: PushItem[] = [];
  for (const t of SYNCED_TABLES) {
    const tbl = (db as unknown as Record<string, { toArray: () => Promise<Row[]> }>)[t];
    if (!tbl) continue;
    const rows = await tbl.toArray();
    for (const row of rows) {
      if (typeof row["id"] !== "number") continue;
      if (t === "bills" && (row as { status?: string }).status === "held") continue;
      items.push({ t, id: row["id"], op: "put", data: row });
    }
  }
  return items;
}

/** Turn the outbox into a push payload. Held bills are skipped. */
async function buildOutboxPush(): Promise<PushItem[]> {
  const items: PushItem[] = [];
  const seen = new Set<string>();

  const queuedRows = await db.syncQueue.orderBy("at").toArray();

  for (const q of queuedRows.slice(0, PUSH_CHUNK)) {
    if (seen.has(q.key)) continue;
    seen.add(q.key);
    const item = await rowToPush(q);
    if (item) items.push(item);
    else if (q.table && q.id) await db.syncQueue.delete(q.key); // held/local-only: drop
  }
  return items;
}

async function rowToPush(q: SyncQueueItem): Promise<PushItem | null> {
  const table = q.table;
  if (!(SYNCED_TABLES as readonly string[]).includes(table)) return null;
  const tbl = (db as unknown as Record<string, { get: (k: number) => Promise<unknown> }>)[table];
  if (!tbl) return null;
  const row = await tbl.get(q.id);
  if (!row) return { t: table, id: q.id, op: "del" };
  if (table === "bills" && (row as { status?: string }).status === "held") return null;
  return { t: table, id: q.id, op: "put", data: row as Row };
}

/** On first sync, tell the server the full local id-set so it can drop orphans. */
async function fullReplaceSets(): Promise<Record<string, number[]>> {
  const sets: Record<string, number[]> = {};
  for (const t of SYNCED_TABLES) {
    const tbl = (
      db as unknown as Record<string, { toArray: () => Promise<{ id?: number }[]> } | undefined>
    )[t];
    if (!tbl) continue;
    const rows = await tbl.toArray();
    const ids = rows.map((r) => r.id).filter((n): n is number => typeof n === "number");
    if (ids.length) sets[t] = ids;
  }
  return sets;
}

/** Apply pulled rows locally without recording them as new local changes. */
async function applyPull(pull: { t: string; id: number; data: Row | null }[]) {
  if (!pull.length) return;
  const byTable = new Map<string, { id: number; data: Row | null }[]>();
  for (const r of pull) {
    if (!(SYNCED_TABLES as readonly string[]).includes(r.t)) continue;
    const arr = byTable.get(r.t) ?? [];
    arr.push(r);
    byTable.set(r.t, arr);
  }
  await runWithoutEnqueue(() =>
    db.transaction("rw", db.tables, async () => {
      for (const [t, rows] of byTable) {
        const table = (
          db as unknown as Record<
            string,
            { put: (o: unknown) => Promise<unknown>; delete: (k: number) => Promise<void> }
          >
        )[t];
        if (!table) continue;
        for (const r of rows) {
          if (r.data === null) await table.delete(r.id);
          else await table.put({ ...r.data, id: r.id });
        }
      }
    }),
  );
}

/** Remove successfully-pushed items from the outbox. */
async function clearPushed(push: PushItem[], applied: number) {
  // Deletes and held-skips are always safe to clear. Puts the server accepted
  // (applied) are cleared too; anything rejected stays for the next round.
  const accepted = new Set<string>();
  for (const p of push) {
    if (p.op === "del") accepted.add(`${p.t}#${p.id}`);
  }
  // For a first sync the server reports how many puts landed; we can't map them
  // 1:1, so clear the whole batch — idempotent re-push is harmless.
  if (applied >= 0) for (const p of push) accepted.add(`${p.t}#${p.id}`);
  for (const key of accepted) await db.syncQueue.delete(key);
}

/* --------------------------- background scheduling ------------------------ */

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

/** Kick off background sync + lease top-ups. Called once from the app shell. */
export function startSyncEngine() {
  if (started) return;
  started = true;

  // If a token already exists, resume silently; otherwise the UI prompts.
  if (hasToken()) {
    setStatus({ phase: "syncing" });
    void topUpAllLeases().catch(() => {});
    void syncNow();
  }

  timer = setInterval(() => {
    if (document.visibilityState === "visible" && hasToken()) void syncNow();
  }, 20_000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && hasToken()) void syncNow();
  });
  window.addEventListener("online", () => {
    if (hasToken()) void syncNow();
  });

  // Local edits trigger a near-immediate push (debounced).
  db.syncQueue.hook("creating", () => scheduleSoon());
  db.syncQueue.hook("updating", () => scheduleSoon());

  setOnRestored(() => {
    // A backup restore replaces everything: wipe the cursor and push it all.
    ls.del(LS.cursor);
    ls.set(LS.synced, "0");
    if (hasToken()) void syncNow({ forceFirst: true });
  });
}

let soonTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSoon() {
  if (!hasToken()) return;
  if (soonTimer) clearTimeout(soonTimer);
  soonTimer = setTimeout(() => {
    soonTimer = null;
    if (document.visibilityState === "visible") void syncNow();
  }, 1200);
}

export function stopSyncEngine() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
