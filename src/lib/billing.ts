import type { Bill, BillLine, Settings } from "./db";

export const inr = (n: number) =>
  "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

const r2 = (n: number) => Math.round(n * 100) / 100;

/** GST is added on top of the discounted line value (exclusive pricing). */
export function computeTotals(
  lines: BillLine[],
  discountType: "flat" | "pct",
  discountValue: number,
  gstOn: boolean,
  tip: number,
) {
  const subtotal = lines.reduce((a, l) => a + l.price * l.qty, 0);
  const rawDisc =
    discountType === "pct" ? (subtotal * Math.min(discountValue, 100)) / 100 : discountValue;
  const discount = r2(Math.min(Math.max(rawDisc, 0), subtotal));
  const ratio = subtotal ? (subtotal - discount) / subtotal : 0;
  const tax = gstOn
    ? lines.reduce((a, l) => a + (l.price * l.qty * ratio * l.gstRate) / 100, 0)
    : 0;
  const half = r2(tax / 2);
  const total = Math.round(subtotal - discount + half * 2 + Math.max(tip, 0));
  return { subtotal: r2(subtotal), discount, cgst: half, sgst: half, tip: Math.max(tip, 0), total };
}

/**
 * The name typed into the bill sheet's "Customer name or phone" field that
 * was never linked to a customer record (a record needs a phone number).
 *
 * - digits only (spaces ignored) → that is a phone number, not a name: return
 *   undefined so the existing "Add new customer" phone flow keeps owning it
 *   unchanged;
 * - empty/blank  → undefined, so the bill still reads "Walk-in";
 * - otherwise    → the trimmed, whitespace-collapsed name, capped at 60 chars.
 *
 * This is what made a typed name like "syed" disappear: only a linked customer
 * record ever reached `bill.customerName`.
 */
export function typedCustomerName(raw: string | undefined): string | undefined {
  const q = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!q || /^\d+$/.test(q.replace(/\s/g, ""))) return undefined;
  return q.slice(0, 60);
}

/**
 * Normalise an Indian customer phone to digits for wa.me links.
 * Accepts "9840012345", "09840012345", "+91 98400 12345", "91-98400-12345".
 * Returns null when the number cannot be trusted (not 10 digits after the
 * country/trunk prefix), so we never open WhatsApp with a broken recipient.
 */
export function waRecipient(raw: string, cc = "91"): string | null {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2); // 0091… international prefix
  if (d.startsWith("0")) d = d.slice(1); // 09840012345 trunk prefix
  if (d.startsWith(cc)) d = d.slice(cc.length);
  return d.length === 10 ? cc + d : null;
}

export type WaMessage = {
  name: string;
  items: string[];
  total: string;
  number?: string | undefined;
};

/** WhatsApp summary for the current (unsaved) or a saved bill. */
export function waText(m: WaMessage): string {
  const head = m.number ? `Bill ${m.number} · ${m.name}` : m.name;
  return [head, ...m.items, `Total: ${m.total}`, "Thank you! 🙏"].join("\n");
}

export function waLink(phone: string, text: string, cc = "91"): string | null {
  const to = waRecipient(phone, cc);
  return to ? `https://wa.me/${to}?text=${encodeURIComponent(text)}` : null;
}

export function billWaText(b: Bill, settings: Settings): string {
  return waText({
    name: b.customerName ?? settings.salonName,
    number: b.number,
    items: b.lines.map((l) => `${l.name} x${l.qty} – ${inr(l.price * l.qty)}`),
    total: inr(b.total),
  });
}

/** Bill date/time in IST — the salon's timezone, never the device's. */
const istWhen = (ms: number) =>
  new Date(ms).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });

/**
 * Plain-text bill for the WhatsApp chat deep link (wa.me?text=…): shop name,
 * bill number, IST date/time, one "item x qty - amount" line per line, then
 * discount / tip / payment mode / total / thank-you — and ONLY those: a zero
 * discount, a zero tip, no payments or a missing shop name simply never
 * produce a line (no blank rows in the chat).
 *
 * Reads the saved bill values as they are: no money is recomputed here.
 */
export function waBillMessage(b: Bill, settings: Settings): string {
  const payments = b.payments.map((p) => p.mode);
  const rows: (string | null)[] = [
    settings.salonName,
    `Bill ${b.number}`,
    istWhen(b.createdAt),
    ...b.lines.map((l) => `${l.name} x${l.qty} - ${inr(l.price * l.qty)}`),
    b.discount > 0 ? `Discount - ${inr(b.discount)}` : null,
    b.tip > 0 ? `Tip - ${inr(b.tip)}` : null,
    payments.length ? `Payment - ${payments.join(" + ")}` : null,
    `Total - ${inr(b.total)}`,
    "Thank you! 🙏",
  ];
  return rows.filter((r): r is string => Boolean(r)).join("\n");
}

/**
 * wa.me deep link that opens THIS customer's own chat (91 + the 10 digits)
 * with the bill pre-filled, or null when the bill has no exactly-10-digit
 * number — the caller then falls back to the dialog that asks for it.
 */
export function waBillLink(b: Bill, settings: Settings): string | null {
  return waLink(b.customerPhone ?? "", waBillMessage(b, settings));
}
