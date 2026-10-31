/*
 * Restore drill — "does a backup still restore?" answered WITHOUT touching data.
 *
 * A restore (db.ts `restoreBackup`) clears every restorable table and re-puts
 * the backup's rows inside one Dexie transaction, so the old drill could only
 * be honest by doing a real restore. This version instead mirrors that code
 * path on paper: `planRestoreCounts` works out exactly how many rows each
 * table WOULD hold after the restore, purely in memory, and `runRestoreDrill`
 * compares those numbers with the live row counts. Every operation below is a
 * `count()` — no transaction is opened, no table is written, and the live data
 * is left exactly as it was. The backup file itself is read only.
 */
import { db, RESTORABLE, validateBackup } from "./db";

export type DrillRow = {
  table: string;
  /** Rows in the live table right now. */
  live: number;
  /** Rows the table WOULD hold if this backup were restored (planned, not written). */
  wouldBe: number;
  match: boolean;
};

export type DrillResult = {
  ok: boolean;
  tables: DrillRow[];
  /** Why the plan is not restorable (file rejected), empty when it would restore. */
  problems: string[];
  /** Live bills at check time — for the recorded result line. */
  liveBills: number;
};

/**
 * How many rows `restoreBackup` would leave in each table, from the parsed
 * backup alone. Mirrors restoreBackup's shape checks 1:1 and never runs them:
 *   - a key that is not an array  → restore skips the table (row count kept)
 *   - settings                    → written as ONE merged row
 *   - everything else             → clear() + bulkPut(allRows) → rows.length
 */
export function planRestoreCounts(data: unknown): {
  ok: boolean;
  counts: Map<string, number>;
  problems: string[];
} {
  const empty = new Map<string, number>();
  if (!validateBackup(data)) {
    return { ok: false, counts: empty, problems: ["not a SalonBill backup file"] };
  }
  const src = data as Record<string, unknown[]>;
  const problems: string[] = [];

  // Same shape rules restoreBackup's bulkPut would hit: a table of primitives
  // would throw mid-transaction, so it is a failed plan, not a silent skip.
  for (const t of RESTORABLE) {
    if (t === "settings") continue;
    const rows = src[t];
    if (Array.isArray(rows) && rows.some((r) => !r || typeof r !== "object")) problems.push(t);
  }
  if (problems.length) return { ok: false, counts: empty, problems };

  const counts = new Map<string, number>();
  for (const t of RESTORABLE) {
    const rows = src[t];
    if (!Array.isArray(rows)) continue; // restoreBackup `continue`s → table untouched
    if (t === "settings") {
      // Always ONE put — an empty settings array still writes defaults + id.
      counts.set(t, 1);
      continue;
    }
    counts.set(t, rows.length);
  }
  return { ok: true, counts, problems: [] };
}

/** Row counts of the restorable tables. READ-ONLY: `count()` on each table. */
export async function liveCounts(): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  for (const t of RESTORABLE) m.set(t, await db[t].count());
  return m;
}

/**
 * Run the check: plan the restore in memory, read the live counts, compare.
 * Returns the per-table comparison. Writes nothing, anywhere.
 */
export async function runRestoreDrill(data: unknown): Promise<DrillResult> {
  const plan = planRestoreCounts(data);
  const live = await liveCounts();
  const tables: DrillRow[] = RESTORABLE.map((t) => {
    const liveN = live.get(t) ?? 0;
    const wouldBe = plan.counts.has(t) ? (plan.counts.get(t) as number) : liveN;
    return { table: t, live: liveN, wouldBe, match: liveN === wouldBe };
  });
  const mismatched = tables.filter((t) => !t.match);
  return {
    ok: plan.ok && mismatched.length === 0,
    tables,
    problems: plan.problems,
    liveBills: live.get("bills") ?? 0,
  };
}

/** One-line, human record of a check: "passed — 8 tables match, 2 bills". */
export function drillSummary(r: DrillResult): string {
  if (!r.ok) {
    if (r.problems.length) return `failed — unreadable file (${r.problems.join(", ")})`;
    const bad = r.tables
      .filter((t) => !t.match)
      .map((t) => `${t.table}: ${t.live} now vs ${t.wouldBe} from backup`)
      .join(", ");
    return `failed — ${bad || "row counts differ"}`;
  }
  return `passed — ${r.tables.length} tables match, ${r.liveBills} bills`;
}
