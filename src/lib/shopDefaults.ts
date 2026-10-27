/**
 * The salon's real identity and receipt defaults — the ONLY place these
 * values may be hardcoded.
 *
 * Consumers:
 *  - db.ts `defaultSettings` → every fresh install seeds from here;
 *  - SetupScreen → pre-fills the "Set up your salon" form and decides which
 *    receipt settings are safe to reset on Finish;
 *  - tests → assert no other file hardcodes the shop name/phone.
 *
 * The demo values shipped before this shop existed (the old Glow Studio
 * seed) live here too, because "is this install still exactly the shipped
 * demo?" can only be answered against those exact strings.
 */
import type { Settings } from "./db";

export const SHOP_NAME = "The House of Barber";
export const SHOP_PHONE = "+91 63791 83898";
/** Not known yet — stays empty until the owner fills it in Settings. */
export const SHOP_ADDRESS = "";
export const SHOP_FOOTER = "Thank you! Visit again";

/** Receipt defaults for a brand-new salon: GST off, no GSTIN, no review QR. */
export const SHOP_DEFAULTS: Pick<
  Settings,
  "salonName" | "address" | "phone" | "footer" | "gstOn" | "gstin" | "reviewUrl"
> = {
  salonName: SHOP_NAME,
  address: SHOP_ADDRESS,
  phone: SHOP_PHONE,
  footer: SHOP_FOOTER,
  gstOn: false,
  gstin: "",
  reviewUrl: "",
};

/** The demo receipt values the app used to seed (old db.ts `defaultSettings`). */
export const OLD_DEMO_SETTINGS: Pick<
  Settings,
  "salonName" | "address" | "phone" | "footer" | "gstOn" | "gstin" | "reviewUrl"
> = {
  salonName: "Glow Studio Unisex Salon",
  address: "12, 2nd Avenue, Anna Nagar, Chennai 600040",
  phone: "+91 98400 12345",
  footer: "Thank you! Visit again ✨",
  gstOn: true,
  gstin: "33ABCDE1234F1Z5",
  reviewUrl: "https://g.page/r/glowstudio/review",
};

/**
 * True while the stored settings row still carries EXACTLY the old demo
 * values (every receipt field). Any customisation at all → false, and
 * nothing in that row may be overwritten automatically.
 */
export function isStillDemoSettings(s: Partial<Settings> | undefined): boolean {
  if (!s) return false;
  return (
    s.salonName === OLD_DEMO_SETTINGS.salonName &&
    s.address === OLD_DEMO_SETTINGS.address &&
    s.phone === OLD_DEMO_SETTINGS.phone &&
    s.footer === OLD_DEMO_SETTINGS.footer &&
    s.gstOn === OLD_DEMO_SETTINGS.gstOn &&
    s.gstin === OLD_DEMO_SETTINGS.gstin &&
    s.reviewUrl === OLD_DEMO_SETTINGS.reviewUrl
  );
}

/**
 * What the setup form pre-fills:
 *  - still the shipped demo → the new shop defaults;
 *  - a fresh install (already seeded from SHOP_DEFAULTS) → same values;
 *  - anything customised → the salon's own stored values, so Finish can
 *    never silently rename a shop that already typed its name.
 */
export function prefillShopFields(s: Partial<Settings> | undefined): {
  name: string;
  phone: string;
  address: string;
} {
  if (isStillDemoSettings(s)) {
    return { name: SHOP_NAME, phone: SHOP_PHONE, address: SHOP_ADDRESS };
  }
  return {
    name: s?.salonName ?? SHOP_NAME,
    phone: s?.phone ?? SHOP_PHONE,
    address: s?.address ?? "",
  };
}

/**
 * The settings patch "Finish setup" may write — ONLY fields whose value the
 * owner actually changed, plus (while the row is still exactly the demo)
 * the receipt reset: GST off, GSTIN cleared, review link cleared.
 * A field that differs from the old demo because someone customised it is
 * never touched.
 */
export function setupFinishPatch(
  stored: Partial<Settings> | undefined,
  input: { name: string; phone: string; address: string },
): Partial<Settings> {
  const patch: Partial<Settings> = {};
  const name = input.name.trim();
  const phone = input.phone.trim();
  const address = input.address.trim();

  if (name && name !== stored?.salonName) patch.salonName = name;
  if (phone && phone !== stored?.phone) patch.phone = phone;
  if (address !== (stored?.address ?? "")) patch.address = address;

  if (isStillDemoSettings(stored)) {
    // First setup of an untouched install → adopt the real shop's receipt
    // defaults too (the demo GSTIN/review link must not reach a live shop).
    patch.gstOn = false;
    patch.gstin = "";
    patch.reviewUrl = "";
  }
  return patch;
}
