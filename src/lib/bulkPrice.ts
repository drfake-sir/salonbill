/**
 * Bulk price planning — pure, so the preview a salon owner sees is provably
 * the same arithmetic that gets written to the services table.
 *
 * Rules (item 5):
 *  - increase or decrease, by percent or by rupees;
 *  - rounding to the nearest ₹1 or ₹5;
 *  - disabled services are skipped unless the caller opts them in;
 *  - an empty/zero/negative amount, or ANY result below ₹0, blocks the apply;
 *  - a row whose price would not change is left out of the plan, so the count
 *    ("Apply to N services" / "Updated N prices") is the number of real edits.
 *
 * Nothing here touches bills: a saved bill keeps its own line price snapshot,
 * so re-pricing the catalog can never rewrite history.
 */

export type BulkMode = {
  dir: "up" | "down";
  unit: "pct" | "inr";
  /** Raw typed amount (0 when empty / unparseable). */
  amount: number;
  /** Nearest ₹1 or ₹5. */
  rounding: 1 | 5;
  /** Opt-in: disabled services are skipped unless this is true. */
  includeDisabled: boolean;
};

export type BulkItem = {
  id: number;
  name: string;
  price: number;
  active?: boolean | undefined;
};

export type BulkLine = { id: number; name: string; from: number; to: number };

/** The new price for one service, before the no-change filter. */
export function computePrice(price: number, mode: BulkMode): number {
  const step = mode.dir === "up" ? mode.amount : -mode.amount;
  const raw = mode.unit === "pct" ? (price * (100 + step)) / 100 : price + step;
  // Round half up to the chosen ₹ step. A negative result is NOT clamped here
  // — it is reported by bulkProblem() and blocks the apply, so the owner
  // decides, instead of silently getting ₹0 rows.
  return Math.round(raw / mode.rounding) * mode.rounding;
}

/** Every service whose price actually changes, in list order. */
export function planBulk(items: BulkItem[], mode: BulkMode): BulkLine[] {
  return items
    .filter((s) => mode.includeDisabled || s.active !== false)
    .map((s) => ({ id: s.id, name: s.name, from: s.price, to: computePrice(s.price, mode) }))
    .filter((l) => l.to !== l.from);
}

/** Why the apply button is disabled — null when the plan may be written. */
export function bulkProblem(mode: BulkMode, plan: BulkLine[]): string | null {
  if (!Number.isFinite(mode.amount) || mode.amount <= 0) return "Enter an amount";
  if (mode.unit === "pct" && mode.amount > 100 && mode.dir === "down")
    return "A decrease can’t be more than 100%";
  // Any result below ₹0 blocks the whole apply — no silent clamping.
  if (plan.some((l) => l.to < 0)) return "A price would fall below ₹0";
  if (plan.length === 0) return "No prices would change";
  return null;
}
