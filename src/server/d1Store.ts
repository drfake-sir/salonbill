import type { AuthRecord, PushItem, SyncStore } from "./syncCore";

/**
 * Minimal D1 surface we use. Typed locally so the app builds without
 * @cloudflare/workers-types; at runtime the binding is Cloudflare's D1 client.
 */
export type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  first: <T = Record<string, unknown>>() => Promise<T | null>;
  all: <T = Record<string, unknown>>() => Promise<{ results: T[] } | T[]>;
  run: () => Promise<unknown>;
};
export type D1Like = {
  prepare: (sql: string) => D1Statement;
  batch: (stmts: D1Statement[]) => Promise<unknown[]>;
  exec: (sql: string) => Promise<unknown>;
};

// D1's exec() splits on newlines and cannot run a multi-line CREATE TABLE, so
// each statement is prepared and run individually (idempotent IF NOT EXISTS).
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sb_rows (
     table_name TEXT NOT NULL,
     row_id INTEGER NOT NULL,
     data TEXT,
     server_at INTEGER NOT NULL,
     PRIMARY KEY (table_name, row_id)
   )`,
  `CREATE INDEX IF NOT EXISTS sb_rows_by_time ON sb_rows (server_at)`,
  `CREATE TABLE IF NOT EXISTS sb_counters (
     key TEXT PRIMARY KEY,
     value INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sb_auth (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

let schemaPromise: Promise<void> | null = null;
/** Create sb_rows/sb_counters/sb_auth if missing (also used by the backup dump). */
export function ensureSchema(d1: D1Like): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = d1.batch(SCHEMA_STATEMENTS.map((sql) => d1.prepare(sql))).then(
      () => undefined,
      (e) => {
        schemaPromise = null; // allow retry on the next request
        throw e;
      },
    );
  }
  return schemaPromise;
}

const BATCH_ROWS = 80; // well under D1's 100 bound-params-per-statement limit

export function createD1Store(d1: D1Like): SyncStore {
  return {
    async getAuth() {
      await ensureSchema(d1);
      const row = await d1.prepare("SELECT value FROM sb_auth WHERE key = 'auth'").first<{
        value: string;
      }>();
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.value) as AuthRecord;
        return parsed.salt && parsed.hash ? parsed : null;
      } catch {
        return null;
      }
    },

    async setAuth(rec: AuthRecord) {
      await ensureSchema(d1);
      await d1
        .prepare(
          "INSERT INTO sb_auth (key, value) VALUES ('auth', ?1) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(JSON.stringify(rec))
        .run();
    },

    async rowsSince(cursor, limit) {
      await ensureSchema(d1);
      const res = await d1
        .prepare(
          "SELECT table_name AS t, row_id AS id, data, server_at FROM sb_rows " +
            "WHERE server_at >= ?1 ORDER BY server_at ASC, table_name ASC, row_id ASC LIMIT ?2",
        )
        .bind(cursor, limit)
        .all<{ t: string; id: number; data: string | null; server_at: number }>();
      return Array.isArray(res) ? res : res.results;
    },

    async upsert(items, serverAt, mode) {
      await ensureSchema(d1);
      const conflict =
        mode === "absent"
          ? "ON CONFLICT(table_name, row_id) DO NOTHING"
          : "ON CONFLICT(table_name, row_id) DO UPDATE SET data = excluded.data, server_at = excluded.server_at";
      for (let i = 0; i < items.length; i += BATCH_ROWS) {
        const chunk = items.slice(i, i + BATCH_ROWS);
        await d1.batch(
          chunk.map((it: PushItem, j: number) =>
            d1
              .prepare(
                "INSERT INTO sb_rows (table_name, row_id, data, server_at) VALUES (?1, ?2, ?3, ?4) " +
                  conflict,
              )
              .bind(
                it.t,
                it.id,
                it.op === "put" ? JSON.stringify(it.data) : null,
                serverAt + i + j,
              ),
          ),
        );
      }
      return { applied: items.length };
    },

    async deleteNotIn(sets, serverAt) {
      await ensureSchema(d1);
      for (const [t, ids] of Object.entries(sets)) {
        // Tombstone (data = NULL) rather than DELETE so devices that already
        // pulled these rows receive a delete and converge.
        await d1
          .prepare(
            "UPDATE sb_rows SET data = NULL, server_at = ?2 WHERE table_name = ?1 " +
              "AND data IS NOT NULL AND row_id NOT IN (SELECT value FROM json_each(?3))",
          )
          .bind(t, serverAt, JSON.stringify(ids))
          .run();
      }
    },

    async maxId(table) {
      await ensureSchema(d1);
      const row = await d1
        .prepare(
          "SELECT COALESCE(MAX(row_id), 0) AS m FROM sb_rows WHERE table_name = ?1 AND data IS NOT NULL",
        )
        .bind(table)
        .first<{ m: number }>();
      return row?.m ?? 0;
    },

    async maxBillNo() {
      await ensureSchema(d1);
      const row = await d1
        .prepare(
          "SELECT COALESCE(MAX(CAST(SUBSTR(json_extract(data, '$.number'), 4) AS INTEGER)), 0) AS m " +
            "FROM sb_rows WHERE table_name = 'bills' AND data IS NOT NULL",
        )
        .first<{ m: number }>();
      return row?.m ?? 0;
    },

    async reserve(key, floor, size) {
      await ensureSchema(d1);
      // Atomic in one statement: create the counter at floor+size, or advance an
      // existing counter past max(value, floor) by size. RETURNING gives the new
      // high-water mark, so two devices can never share a number.
      const row = await d1
        .prepare(
          "INSERT INTO sb_counters (key, value) VALUES (?1, ?2 + ?3) " +
            "ON CONFLICT(key) DO UPDATE SET value = MAX(sb_counters.value, ?2) + ?3 " +
            "RETURNING value",
        )
        .bind(key, floor, size)
        .first<{ value: number }>();
      const high = row?.value ?? floor + size;
      return { next: high - size + 1, max: high };
    },

    async getCounter(key) {
      await ensureSchema(d1);
      const row = await d1
        .prepare("SELECT value FROM sb_counters WHERE key = ?1")
        .bind(key)
        .first<{ value: number }>();
      return row?.value ?? 0;
    },

    async setCounter(key, value) {
      await ensureSchema(d1);
      await d1
        .prepare(
          "INSERT INTO sb_counters (key, value) VALUES (?1, ?2) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(key, value)
        .run();
    },
  };
}

/** Resolve the D1 binding from the Worker environment nitro/wrangler provides. */
export function getD1(): D1Like | null {
  const g = globalThis as unknown as {
    __env__?: Record<string, unknown>;
    env?: Record<string, unknown>;
    DB?: unknown;
  };
  const candidates = [g.__env__, g.env, g];
  for (const c of candidates) {
    const db = c && typeof c === "object" ? (c as Record<string, unknown>)["DB"] : undefined;
    if (db && typeof (db as D1Like).prepare === "function") return db as D1Like;
  }
  return null;
}
