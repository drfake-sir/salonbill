/**
 * "Served by" — one stylist per bill, applied from a chip row.
 *
 * The owner (or nobody) signed in usually bills for someone else, and
 * picking a stylist per service line is slow. A chip assigns one stylist to
 * every service line at once and to lines added later; a line whose stylist
 * is then changed individually keeps that choice and is marked "custom", so
 * multi-stylist bills still work.
 *
 * Storage is untouched: lines keep carrying `stylistId`/`stylistName` and
 * the bill keeps its own cashier fields — the chip state (`servedBy`) and
 * the set of individually-chosen line keys live in component state only.
 * Extracted here so the rules are unit-testable without a DOM or Dexie.
 */
import type { BillLine } from "./db";

/** Line keys whose stylist was chosen individually — chips never overwrite them. */
export type CustomStylistKeys = ReadonlySet<string>;

/**
 * The stylist a NEW service line defaults to: the active "Served by" chip
 * when one is chosen, otherwise the session default (a signed-in stylist →
 * themselves, the owner → undefined, i.e. still unattributed).
 */
export function stylistForNewLine(
  servedBy: number | null,
  fallback: number | undefined,
): number | undefined {
  return servedBy ?? fallback;
}

/**
 * Apply a chip to the bill: every service line that was NOT individually
 * chosen moves to `stylistId`; customised lines keep their own stylist, and
 * product lines are untouched (they carry no stylist).
 */
export function applyServedBy(
  lines: BillLine[],
  custom: CustomStylistKeys,
  stylistId: number,
): BillLine[] {
  return lines.map((l) => (l.kind === "service" && !custom.has(l.key) ? { ...l, stylistId } : l));
}

/**
 * Record an individual per-line stylist pick. Picking the chip's own stylist
 * removes the "custom" mark (it matches the bill default again); any other
 * pick marks the line so a later chip tap cannot clobber it.
 */
export function markStylistPick(
  custom: CustomStylistKeys,
  key: string,
  pickedId: number | undefined,
  servedBy: number | null,
): CustomStylistKeys {
  const next = new Set(custom);
  if (servedBy != null && pickedId === servedBy) next.delete(key);
  else next.add(key);
  return next;
}

/** True when a line deviates from an active chip and should show "custom". */
export function isCustomStylist(
  custom: CustomStylistKeys,
  key: string,
  servedBy: number | null,
): boolean {
  return servedBy != null && custom.has(key);
}

/**
 * The save-block message for lines with no stylist — it must point at the
 * "Served by" chips, because that is the fastest way to fix it.
 */
export function missingStylistMessage(count: number, firstName?: string | undefined): string {
  if (count === 1 && firstName) {
    return `Choose who did "${firstName}" — tap a Served by chip or pick a stylist`;
  }
  return `Choose a stylist for ${count} service${count === 1 ? "" : "s"} — tap a Served by chip before saving`;
}
