import type { Bill, Payment } from "./db";

/**
 * "Cancel and rebill" hand-off.
 *
 * The owner cancels a saved bill through the normal append-only flow (the
 * row stays, marked cancelled), and its contents are parked here so the
 * Billing screen can open them as a brand-new, EMPTY draft: no id, no number,
 * no heldId — Save runs commitSale as usual and the new bill gets its own
 * fresh bill number.
 *
 * Everything is READ from the saved bill and copied verbatim: items,
 * quantities, stylists, customer and payment mode. No money is recomputed
 * here (the totals the owner sees are re-derived by the normal save path
 * from the lines the owner can now edit).
 */

export const REBILL_KEY = "sb-rebill";

export type RebillPayload = {
  /** Fresh line keys so the new bill never reuses the old row's identity. */
  lines: Bill["lines"];
  /** Payment mode the bill was paid with — preselected on the new draft. */
  mode: Payment["mode"];
  customerId?: number | undefined;
  customerName?: string | undefined;
  customerPhone?: string | undefined;
  /** The cancelled bill's number — only used for the confirmation toast. */
  from: string;
  at: number;
};

/** Snapshot a saved bill's editable contents for the new draft. */
export function rebillPayload(b: Bill): RebillPayload {
  return {
    lines: b.lines.map((l) => ({ ...l, key: crypto.randomUUID() })),
    mode: b.payments[0]?.mode ?? "Cash",
    customerId: b.customerId,
    customerName: b.customerName,
    customerPhone: b.customerPhone,
    from: b.number,
    at: Date.now(),
  };
}

/** Park the payload in this tab's sessionStorage until Billing opens. */
export function storeRebill(b: Bill): void {
  try {
    sessionStorage.setItem(REBILL_KEY, JSON.stringify(rebillPayload(b)));
  } catch {
    /* private mode — the rebill simply won't be prefetched */
  }
}

/**
 * Read the payload ONCE and remove it: it can only ever become one new bill.
 * Returns null when nothing is stored (or the stored value is unusable).
 */
export function takeRebill(): RebillPayload | null {
  try {
    const raw = sessionStorage.getItem(REBILL_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(REBILL_KEY);
    const parsed = JSON.parse(raw) as RebillPayload;
    if (!parsed || !Array.isArray(parsed.lines) || !parsed.lines.length) return null;
    if (!parsed.mode) return null;
    return parsed;
  } catch {
    return null;
  }
}
