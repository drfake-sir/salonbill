/**
 * Stylist attribution rules.
 *
 * The single source of truth for WHO PERFORMED a service. Extracted from the
 * billing screen so earnings, bill details and the CSV export cannot drift
 * apart, and so the rules are unit-testable without a DOM or Dexie.
 *
 * Two identities, never mixed:
 *  - STYLIST  → per line (stylistId + stylistName): who did the work.
 *  - CASHIER  → per bill (cashierId + cashierName): who was signed in and
 *    rang the sale up. A stylist can be the cashier on their own bill, but
 *    an owner ringing up a service is cashier only, never the stylist.
 */
import type { BillLine, Stylist } from "./db";

export type StaffSession = {
  role: "staff" | "owner";
  staffId?: number | undefined;
  name: string;
} | null;

/**
 * The stylist a NEW service line should default to.
 *
 *  - a signed-in STYLIST → themselves (they are about to do the work)
 *  - the OWNER           → undefined, deliberately. The owner is not
 *    performing the service, so they must choose per line; guessing would
 *    silently bill someone's commission to the wrong person.
 */
export function defaultStylistIdFor(session: StaffSession): number | undefined {
  return session?.role === "staff" ? session.staffId : undefined;
}

/** Service lines still missing the stylist who performed them. */
export function unattributedServiceLines(lines: BillLine[]): BillLine[] {
  return lines.filter((l) => l.kind === "service" && !l.stylistId);
}

/**
 * Resolve a line's stylist name from its id.
 *
 * Returns undefined when the line carries no id — an unattributed line must
 * never claim a name, or the CSV would invent a stylist the salon never
 * assigned. Old rows that stored only a name keep it (see lineMatchesStylist
 * in earnings.ts for the matching rule those rows rely on).
 */
export function stylistNameFor(
  stylists: Pick<Stylist, "id" | "name">[],
  line: Pick<BillLine, "kind" | "stylistId" | "stylistName">,
): string | undefined {
  if (line.kind !== "service") return undefined;
  if (line.stylistId == null) return line.stylistName;
  return stylists.find((s) => s.id === line.stylistId)?.name ?? line.stylistName;
}
