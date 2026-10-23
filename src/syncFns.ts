import { createServerFn } from "@tanstack/react-start";
import type { AuthRequest, AuthResponse, SyncRequest, SyncResponse } from "./server/syncCore";

/** Return type of the owner-facing backup functions (Settings screen). */
export type BackupStatus = {
  ok: boolean;
  at?: number | null;
  key?: string | null;
  rows?: number;
  bills?: number;
  error?: string;
};
export type BackupRun = {
  ok: boolean;
  skipped?: boolean | undefined;
  key?: string | undefined;
  rows?: number | undefined;
  bills?: number | undefined;
  error?: string | undefined;
};

/**
 * The D1 store + protocol live in server-only modules. We import them lazily
 * inside the handlers so the client bundle only ever sees the RPC stubs —
 * TanStack's import-protection then keeps `d1Store` (which reads the Worker
 * env) out of the browser build entirely.
 */
/**
 * Thrown when the Worker environment has no D1 binding. Distinguished from
 * every other failure because the fix is environmental, not a bug: the plain
 * Vite dev server (`npm run dev`) runs the SSR bundle in Node, where there is
 * no `env.DB`. Sync only exists inside workerd, so that server must be started
 * with `npm run dev:worker` (wrangler dev) or deployed with a D1 database.
 *
 * `message` is what the salon owner sees (short, actionable for them);
 * `hint` is the developer diagnosis and only ever goes to the server log.
 */
export class SyncStorageUnavailableError extends Error {
  readonly hint =
    "No D1 binding on this server: `npm run dev` serves the SSR bundle from Node, so globalThis.__env__.DB is undefined. " +
    "Run `npm run dev:worker` (wrangler dev --config wrangler.local.json) for a real Cloudflare runtime, or deploy with a D1 database.";

  constructor() {
    super("Cloud database is not available on this server");
    this.name = "SyncStorageUnavailableError";
  }
}

/**
 * Map a thrown error to what the UI may show. Storage problems are
 * environmental, so the owner gets a short message while the detail stays in
 * the log; anything else keeps the pre-existing generic copy.
 */
function syncErrorMessage(e: unknown, logLabel: string): string {
  if (e instanceof SyncStorageUnavailableError) {
    console.error(`${logLabel}: ${e.hint}`);
    return e.message;
  }
  console.error(logLabel, e);
  return "Sync storage unavailable";
}

async function store() {
  const { createD1Store, getD1 } = await import("./server/d1Store");
  const d1 = getD1();
  if (!d1) throw new SyncStorageUnavailableError();
  return createD1Store(d1);
}

/** Exchange the salon PIN (or an existing token) for a sync token. */
export const syncAuthFn = createServerFn({ method: "POST" })
  .validator((data: AuthRequest) => data)
  .handler(async ({ data }): Promise<AuthResponse> => {
    try {
      const { runAuth } = await import("./server/syncCore");
      return await runAuth(await store(), data ?? {});
    } catch (e) {
      return { ok: false, error: syncErrorMessage(e, "sync auth failed") };
    }
  });

/** Push local changes, pull remote changes, reserve id leases. */
export const syncPushFn = createServerFn({ method: "POST" })
  .validator((data: SyncRequest) => data)
  .handler(async ({ data }): Promise<SyncResponse> => {
    try {
      const { runSync } = await import("./server/syncCore");
      const res = await runSync(await store(), data);
      // Nightly-cloud-backup trigger (throttled): first successful sync of a
      // new day exports D1 → R2. Failures never affect the sync response.
      if (res.ok) {
        try {
          const [{ getD1 }, { getR2, maybeBackup }] = await Promise.all([
            import("./server/d1Store"),
            import("./server/backup"),
          ]);
          const d1 = getD1();
          const r2 = getR2();
          if (d1 && r2) await maybeBackup(d1, r2);
        } catch (e) {
          console.warn("backup piggyback failed", e);
        }
      }
      return res;
    } catch (e) {
      // The wire shape is a closed union ("auth" | "bad") that the client maps
      // to copy, so the real diagnosis has to land in the server log.
      if (e instanceof SyncStorageUnavailableError) console.error(`sync push: ${e.hint}`);
      else console.error("sync failed", e);
      return {
        ok: false,
        error: "bad",
        cursor: 0,
        pull: [],
        capped: false,
        applied: 0,
        leases: {},
      };
    }
  });

/** Owner check: the request must carry the salon's current sync token. */
async function requireToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const s = await store();
  const auth = await s.getAuth();
  return !!auth && auth.hash === token;
}

/** Last cloud backup info (owner screen). */
export const backupStatusFn = createServerFn({ method: "POST" })
  .validator((data: { token?: string | undefined }) => data)
  .handler(async ({ data }): Promise<BackupStatus> => {
    try {
      if (!(await requireToken(data?.token))) return { ok: false, error: "Owner unlock required" };
      const { getR2, backupMeta } = await import("./server/backup");
      const r2 = getR2();
      if (!r2) return { ok: false, error: "Cloud backup storage is not enabled on this app" };
      const meta = await backupMeta(r2);
      return {
        ok: true,
        at: meta?.at ?? null,
        key: meta?.key ?? null,
        rows: meta?.rows ?? 0,
        bills: meta?.bills ?? 0,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Could not read backup status" };
    }
  });

/** Force an immediate D1 → R2 export (owner screen, "Back up now"). */
export const backupNowFn = createServerFn({ method: "POST" })
  .validator((data: { token?: string | undefined }) => data)
  .handler(async ({ data }): Promise<BackupRun> => {
    try {
      if (!(await requireToken(data?.token))) return { ok: false, error: "Owner unlock required" };
      const { getD1 } = await import("./server/d1Store");
      const { getR2, runBackup } = await import("./server/backup");
      const d1 = getD1();
      const r2 = getR2();
      if (!d1 || !r2)
        return { ok: false, error: "Cloud backup storage is not enabled on this app" };
      const r = await runBackup(d1, r2, { force: true });
      return {
        ok: r.ok,
        skipped: r.skipped,
        key: r.key,
        rows: r.rows,
        bills: r.bills,
        error: r.error,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Backup failed" };
    }
  });
