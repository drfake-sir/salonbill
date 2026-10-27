import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  OLD_DEMO_SETTINGS,
  SHOP_ADDRESS,
  SHOP_DEFAULTS,
  SHOP_FOOTER,
  SHOP_NAME,
  SHOP_PHONE,
  isStillDemoSettings,
  prefillShopFields,
  setupFinishPatch,
} from "./shopDefaults";
import { defaultSettings } from "./db";

const SRC = join(__dirname, "..");

describe("new-salon defaults (fresh install seed)", () => {
  it("seeds The House of Barber with GST off and no GSTIN/review link", () => {
    expect(SHOP_DEFAULTS).toEqual({
      salonName: "The House of Barber",
      address: "",
      phone: "+91 63791 83898",
      footer: "Thank you! Visit again",
      gstOn: false,
      gstin: "",
      reviewUrl: "",
    });
    expect(SHOP_NAME).toBe("The House of Barber");
    expect(SHOP_PHONE).toBe("+91 63791 83898");
    expect(SHOP_ADDRESS).toBe("");
    expect(SHOP_FOOTER).toBe("Thank you! Visit again");
  });

  it("db.ts seeds from shopDefaults — the module is the only hardcoder", () => {
    // defaultSettings must be the shop defaults plus the non-identity fields.
    expect(defaultSettings.salonName).toBe(SHOP_DEFAULTS.salonName);
    expect(defaultSettings.phone).toBe(SHOP_DEFAULTS.phone);
    expect(defaultSettings.address).toBe(SHOP_DEFAULTS.address);
    expect(defaultSettings.gstOn).toBe(false);
    expect(defaultSettings.gstin).toBe("");
    expect(defaultSettings.reviewUrl).toBe("");
    expect(defaultSettings.footer).toBe(SHOP_DEFAULTS.footer);
    // Unrelated fields keep their old values.
    expect(defaultSettings.paper).toBe("80mm");
    expect(defaultSettings.autoPrint).toBe(false);
    expect(defaultSettings.billSeq).toBe(0);
    expect(defaultSettings.onboarded).toBe(false);
  });

  it("no other source file hardcodes the shop name or phone", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        if (entry === "shopDefaults.ts" || /\.(test|spec)\.(ts|tsx)$/.test(entry)) continue;
        const src = readFileSync(p, "utf8");
        if (src.includes(SHOP_PHONE) || src.includes(SHOP_NAME)) offenders.push(p);
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});

describe("demo-value detection", () => {
  it("an untouched shipped demo row is detected exactly", () => {
    expect(isStillDemoSettings({ ...OLD_DEMO_SETTINGS, id: 1 })).toBe(true);
  });

  it("new defaults and any customisation are NOT demo", () => {
    expect(isStillDemoSettings(SHOP_DEFAULTS)).toBe(false);
    expect(isStillDemoSettings(undefined)).toBe(false);
    // One changed field is enough to disqualify.
    expect(isStillDemoSettings({ ...OLD_DEMO_SETTINGS, salonName: "My Shop" })).toBe(false);
    expect(isStillDemoSettings({ ...OLD_DEMO_SETTINGS, address: "Plot 4, Pune" })).toBe(false);
    expect(isStillDemoSettings({ ...OLD_DEMO_SETTINGS, gstOn: false })).toBe(false);
    expect(isStillDemoSettings({ ...OLD_DEMO_SETTINGS, footer: "Thanks!" })).toBe(false);
  });
});

describe("setup prefill", () => {
  it("still-demo row → pre-fills the new shop defaults", () => {
    expect(prefillShopFields(OLD_DEMO_SETTINGS)).toEqual({
      name: SHOP_NAME,
      phone: SHOP_PHONE,
      address: "",
    });
  });

  it("fresh install (already seeded) → pre-fills the same defaults", () => {
    expect(prefillShopFields(defaultSettings)).toEqual({
      name: SHOP_NAME,
      phone: SHOP_PHONE,
      address: "",
    });
  });

  it("a customised row pre-fills its own values, never the defaults", () => {
    const stored = {
      salonName: "Trim & Fade",
      phone: "+91 90000 00000",
      address: "7 Lake Road",
      gstOn: true,
      gstin: "29AAAAA0000A1Z5",
      reviewUrl: "https://g.page/r/xyz",
      footer: "See you soon",
    };
    expect(prefillShopFields(stored)).toEqual({
      name: "Trim & Fade",
      phone: "+91 90000 00000",
      address: "7 Lake Road",
    });
  });
});

describe("Finish setup — no overwrite of custom values", () => {
  it("still-demo row: adopts the shop name/phone/address AND resets GST/GSTIN/review", () => {
    const patch = setupFinishPatch(OLD_DEMO_SETTINGS, {
      name: SHOP_NAME,
      phone: SHOP_PHONE,
      address: "",
    });
    expect(patch).toEqual({
      salonName: SHOP_NAME,
      phone: SHOP_PHONE,
      address: "",
      gstOn: false,
      gstin: "",
      reviewUrl: "",
    });
  });

  it("fresh (already-defaults) row: only writes what differs — nothing at all", () => {
    const patch = setupFinishPatch(defaultSettings, {
      name: SHOP_NAME,
      phone: SHOP_PHONE,
      address: "",
    });
    expect(patch).toEqual({});
  });

  it("customised row: identity fields are only written when the owner typed them", () => {
    const stored = {
      salonName: "Trim & Fade",
      phone: "+91 90000 00000",
      address: "7 Lake Road",
      gstOn: true,
      gstin: "29AAAAA0000A1Z5",
      reviewUrl: "https://g.page/r/xyz",
      footer: "See you soon",
    };
    // Untouched form (prefilled with stored values) → nothing changes at all,
    // especially not the custom GST/review settings.
    expect(
      setupFinishPatch(stored, {
        name: stored.salonName,
        phone: stored.phone,
        address: stored.address,
      }),
    ).toEqual({});
    // A typed address is written; GST settings stay custom.
    const patch = setupFinishPatch(stored, {
      name: stored.salonName,
      phone: stored.phone,
      address: "8 Lake Road, Pune",
    });
    expect(patch).toEqual({ address: "8 Lake Road, Pune" });
    expect(patch.gstOn).toBeUndefined();
    expect(patch.gstin).toBeUndefined();
    expect(patch.reviewUrl).toBeUndefined();
  });

  it("blank name/phone inputs are never written (cannot wipe a shop)", () => {
    const patch = setupFinishPatch(OLD_DEMO_SETTINGS, { name: "  ", phone: "", address: "" });
    // Blank identity fields are ignored…
    expect(patch.salonName).toBeUndefined();
    expect(patch.phone).toBeUndefined();
    // …but the demo address still gets cleared (it differs and may not stay),
    // and the receipt reset still applies to a demo row.
    expect(patch.address).toBe("");
    expect(patch.gstOn).toBe(false);
    expect(patch.gstin).toBe("");
    expect(patch.reviewUrl).toBe("");
  });
});
