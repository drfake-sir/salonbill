/**
 * Phone-field helpers for the in-app WhatsApp dialog.
 *
 * Kept in a plain module (not the component) so the rules are testable and
 * the component file only exports components.
 */

/**
 * Digits only, reduced to the local 10 — keeps the field numeric-keypad
 * friendly and tolerates a pasted "+91 98400 12345" / "09840012345".
 */
export function normalizePhoneInput(raw: string): string {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length > 10 && d.startsWith("91")) d = d.slice(2);
  if (d.length > 10 && d.startsWith("0")) d = d.slice(1);
  return d.slice(0, 10);
}

/** Exactly 10 digits — the rule the wa.me link builder also relies on. */
export function isValidPhone(raw: string): boolean {
  return /^\d{10}$/.test(raw);
}
