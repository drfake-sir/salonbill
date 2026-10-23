import { ensureSchema, type D1Like } from "./d1Store";

/**
 * Cloud backup layer (D1 → R2).
 *
 * Dumps the whole sync store (sb_rows) as a restore-ready JSON file plus a
 * bills CSV for humans, into an R2 bucket:
 *
 *   daily/salonbill-YYYY-MM-DD.json        full JSON backup
 *   daily/salonbill-YYYY-MM-DD-bills.csv   bills spreadsheet
 *   monthly/salonbill-YYYY-MM.json         monthly snapshot (rolling)
 *   meta/last.json                         when/what the last backup was
 *
 * Retention: every file older than ~13 months (400 days) is deleted.
 *
 * Scheduling: the platform's deploy manifest has no cron trigger, so the
 * nightly run is driven by sync traffic — the first sync request of a new day
 * (at most once per isolate-hour, at most once per 24 h) triggers the export.
 * Owner can also force a run from Settings (Back up now).
 */

/* ------------------------------- R2 surface ------------------------------- */

export type R2Like = {
  put: (
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    opts?: { httpMetadata?: { contentType?: string } },
  ) => Promise<unknown>;
  get: (key: string) => Promise<{ text: () => Promise<string> } | null>;
  head: (key: string) => Promise<{ key: string; size: number; uploaded: Date } | null>;
  list: (opts?: { prefix?: string; limit?: number; cursor?: string | undefined }) => Promise<{
    objects: { key: string; size: number; uploaded: Date }[];
    truncated?: boolean | undefined;
    cursor?: string | undefined;
  }>;
  delete: (keys: string | string[]) => Promise<void>;
};

/** Resolve the BACKUPS R2 binding from the Worker environment (same pattern as getD1). */
export function getR2(): R2Like | null {
  const g = globalThis as unknown as {
    __env__?: Record<string, unknown>;
    env?: Record<string, unknown>;
    BACKUPS?: unknown;
  };
  const candidates = [g.__env__, g.env, g];
  for (const c of candidates) {
    const b = c && typeof c === "object" ? (c as Record<string, unknown>)["BACKUPS"] : undefined;
    if (b && typeof (b as R2Like).put === "function" && typeof (b as R2Like).head === "function")
      return b as R2Like;
  }
  return null;
}

/* --------------------------------- format --------------------------------- */

export type BackupMeta = {
  at: number;
  key: string;
  rows: number;
  bills: number;
};

/**
 * Assemble a client-compatible backup object: `{ [table]: rows }` (rows carry
 * their id) plus a `__backup` marker. Tombstoned rows (deleted in the app) are
 * skipped. This is the exact shape Settings → Restore accepts, so an R2 file
 * can be downloaded and restored on any device without conversion.
 */
export function buildBackupJson(
  rows: { t: string; id: number; data: Record<string, unknown> | null }[],
  now: number,
): string {
  const out: Record<string, unknown> = {
    __backup: { format: "salonbill-cloud", version: 1, exportedAt: now },
  };
  for (const r of rows) {
    if (r.data === null) continue; // deleted
    const arr = (out[r.t] as Record<string, unknown>[] | undefined) ?? [];
    arr.push(r.data);
    out[r.t] = arr;
  }
  return JSON.stringify(out);
}

type BillCsvRow = {
  number?: string;
  createdAt?: number;
  status?: string;
  customerName?: string;
  customerPhone?: string;
  cashierName?: string;
  lines?: { name?: string; qty?: number; stylistName?: string }[];
  subtotal?: number;
  discount?: number;
  cgst?: number;
  sgst?: number;
  tip?: number;
  total?: number;
  payments?: { mode?: string; amount?: number }[];
  cancelReason?: string;
};

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Human-readable bills spreadsheet (opens in Excel / Google Sheets). */
export function billsCsv(bills: BillCsvRow[]): string {
  const head = [
    "Bill No",
    "Date",
    "Customer",
    "Phone",
    "Cashier",
    "Status",
    "Items",
    "Subtotal",
    "Discount",
    "CGST",
    "SGST",
    "Tip",
    "Total",
    "Payment",
    "Cancelled reason",
  ];
  const rows = bills.map((b) =>
    [
      b.number ?? "",
      b.createdAt ? new Date(b.createdAt).toISOString() : "",
      b.customerName ?? "Walk-in",
      b.customerPhone ?? "",
      b.cashierName ?? "",
      b.status ?? "",
      (b.lines ?? [])
        .map((l) => `${l.name ?? ""} x${l.qty ?? 1}${l.stylistName ? ` (${l.stylistName})` : ""}`)
        .join("; "),
      b.subtotal ?? 0,
      b.discount ?? 0,
      b.cgst ?? 0,
      b.sgst ?? 0,
      b.tip ?? 0,
      b.total ?? 0,
      (b.payments ?? []).map((p) => `${p.mode ?? ""} ${p.amount ?? 0}`).join(" + "),
      b.cancelReason ?? "",
    ]
      .map(csvCell)
      .join(","),
  );
  return [head.join(","), ...rows].join("\r\n");
}

/** Keep at least 13 months of daily and monthly snapshots. */
export const RETENTION_DAYS = 400;

/** True for daily/monthly keys older than the retention window. */
export function isExpiredKey(key: string, now: number): boolean {
  const m = key.match(/(\d{4}-\d{2}(?:-\d{2})?)/);
  const stamp = m?.[1];
  if (!stamp) return false;
  const iso = stamp.length === 7 ? `${stamp}-01T00:00:00Z` : `${stamp}T00:00:00Z`;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return now - t > RETENTION_DAYS * 86_400_000;
}

/* --------------------------------- runner --------------------------------- */

const META_KEY = "meta/last.json";
const DUE_MS = 24 * 60 * 60 * 1000; // one snapshot per day
const PAGE = 500; // well under D1's row caps

export async function backupMeta(r2: R2Like): Promise<BackupMeta | null> {
  const obj = await r2.head(META_KEY);
  if (!obj) return null;
  try {
    const full = await r2.get(META_KEY);
    if (!full) return null;
    const parsed = JSON.parse(await full.text()) as BackupMeta;
    return typeof parsed?.at === "number" ? parsed : null;
  } catch {
    return null;
  }
}

/** Read every live sb_rows row via keyset pagination. */
async function readAllRows(d1: D1Like): Promise<{ t: string; id: number; data: string | null }[]> {
  const out: { t: string; id: number; data: string | null }[] = [];
  let lastT = "";
  let lastId = -1;
  for (;;) {
    const res = await d1
      .prepare(
        `SELECT table_name AS t, row_id AS id, data FROM sb_rows
         WHERE table_name > ?1 OR (table_name = ?1 AND row_id > ?2)
         ORDER BY table_name ASC, row_id ASC LIMIT ?3`,
      )
      .bind(lastT, lastId, PAGE)
      .all<{ t: string; id: number; data: string | null }>();
    const rows = Array.isArray(res) ? res : res.results;
    out.push(...rows);
    if (rows.length < PAGE) break;
    lastT = rows[rows.length - 1]!.t;
    lastId = rows[rows.length - 1]!.id;
  }
  return out;
}

async function prune(r2: R2Like, now: number): Promise<void> {
  for (const prefix of ["daily/", "monthly/"]) {
    let cursor: string | undefined;
    do {
      const page = await r2.list({ prefix, limit: 100, cursor });
      const expired = page.objects.filter((o) => isExpiredKey(o.key, now)).map((o) => o.key);
      if (expired.length) await r2.delete(expired);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
}

export type BackupResult = {
  ok: boolean;
  skipped?: boolean;
  key?: string;
  rows?: number;
  bills?: number;
  at?: number;
  error?: string;
};

/**
 * Export D1 → R2. Skips when the last backup is newer than 24 h unless
 * `force` (manual owner trigger). Never throws — failures are reported.
 */
export async function runBackup(
  d1: D1Like,
  r2: R2Like,
  opts?: { force?: boolean; now?: number },
): Promise<BackupResult> {
  const now = opts?.now ?? Date.now();
  try {
    await ensureSchema(d1); // a fresh database may not have sb_rows yet
    const meta = await backupMeta(r2);
    if (!opts?.force && meta && now - meta.at < DUE_MS)
      return { ok: true, skipped: true, at: meta.at, key: meta.key };

    const raw = await readAllRows(d1);
    const rows = raw
      .filter((r) => r.data !== null)
      .map((r) => {
        let data: Record<string, unknown> | null = null;
        try {
          data = JSON.parse(r.data!) as Record<string, unknown>;
        } catch {
          data = null;
        }
        return { t: r.t, id: r.id, data };
      })
      .filter(
        (r): r is { t: string; id: number; data: Record<string, unknown> } => r.data !== null,
      );

    const json = buildBackupJson(rows, now);
    const billRows = rows.filter((r) => r.t === "bills").map((r) => r.data as BillCsvRow);
    const csv = billsCsv(billRows);

    const day = new Date(now).toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const dailyKey = `daily/salonbill-${day}.json`;
    const csvKey = `daily/salonbill-${day}-bills.csv`;
    const monthlyKey = `monthly/salonbill-${month}.json`;

    await r2.put(dailyKey, json, { httpMetadata: { contentType: "application/json" } });
    await r2.put(csvKey, csv, { httpMetadata: { contentType: "text/csv" } });
    await r2.put(monthlyKey, json, { httpMetadata: { contentType: "application/json" } });

    const metaOut: BackupMeta = {
      at: now,
      key: dailyKey,
      rows: rows.length,
      bills: billRows.length,
    };
    await r2.put(META_KEY, JSON.stringify(metaOut), {
      httpMetadata: { contentType: "application/json" },
    });

    await prune(r2, now);
    return { ok: true, ...metaOut };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "backup failed" };
  }
}

/* ------------------------------- scheduling ------------------------------- */

type BackupGlobal = { __sbBackupCheckAt?: number };

/**
 * Called after every successful sync: checks at most once per isolate-hour
 * (so the R2 head is cheap) and runs a full export once per 24 h. This is the
 * "nightly" trigger — the salon's open app syncs continuously, so the first
 * quiet morning request of each day produces that day's snapshot.
 */
export async function maybeBackup(d1: D1Like, r2: R2Like): Promise<void> {
  const g = globalThis as unknown as BackupGlobal;
  const now = Date.now();
  if (g.__sbBackupCheckAt && now - g.__sbBackupCheckAt < 60 * 60 * 1000) return;
  g.__sbBackupCheckAt = now;
  const r = await runBackup(d1, r2);
  if (!r.ok) console.warn("cloud backup failed:", r.error);
}
