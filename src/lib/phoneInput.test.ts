import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { isPhoneShaped, isValidPhone, normalizePhoneInput, PHONE_ERROR } from "./phoneInput";
import { waLink } from "./billing";

const src = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

describe("normalizePhoneInput", () => {
  it("keeps digits only and caps at 10", () => {
    expect(normalizePhoneInput("9876543210")).toBe("9876543210");
    expect(normalizePhoneInput("98765-4321 0")).toBe("9876543210");
    expect(normalizePhoneInput("987654321098")).toBe("9876543210");
    expect(normalizePhoneInput("abcdefghij")).toBe("");
  });

  it("strips +91 / 91 / 0 prefixes", () => {
    expect(normalizePhoneInput("+91 98400 12345")).toBe("9840012345");
    expect(normalizePhoneInput("+919840012345")).toBe("9840012345");
    expect(normalizePhoneInput("91 9840012345")).toBe("9840012345");
    expect(normalizePhoneInput("09840012345")).toBe("9840012345");
    expect(normalizePhoneInput("00919840012345")).toBe("9840012345");
    // A 10-digit number that merely starts with 91 is NOT treated as prefixed:
    expect(normalizePhoneInput("9187654321")).toBe("9187654321");
  });

  it("does not modify an already-valid 10-digit number", () => {
    expect(normalizePhoneInput("9840012345")).toBe("9840012345");
  });
});

describe("isValidPhone / isPhoneShaped", () => {
  it("requires exactly 10 digits", () => {
    expect(isValidPhone("9840012345")).toBe(true);
    expect(isValidPhone("984001234")).toBe(false);
    expect(isValidPhone("98400123456")).toBe(false);
    expect(isValidPhone("")).toBe(false);
  });

  it("isPhoneShaped accepts any stored digit value up to 10+ without throwing", () => {
    expect(isPhoneShaped("")).toBe(false);
    expect(isPhoneShaped("9840012345")).toBe(true);
    expect(isPhoneShaped("98400123456")).toBe(true); // legacy odd value: valid=false, not a crash
    expect(isPhoneShaped("+91 98400")).toBe(true); // phone-shaped, but not yet 10 local digits
    expect(isPhoneShaped("Karthik")).toBe(false);
  });

  it("exports a stable inline error message", () => {
    expect(PHONE_ERROR).toBe("Enter a 10-digit mobile number.");
  });
});

describe("WhatsApp number format", () => {
  it("builds 91 + the 10 digits", () => {
    expect(waLink("9840012345", "hi")).toBe("https://wa.me/919840012345?text=hi");
    expect(waLink("+91 98400 12345", "hi")).toBe("https://wa.me/919840012345?text=hi");
    expect(waLink("09840012345", "hi")).toBe("https://wa.me/919840012345?text=hi");
  });

  it("returns null for unusable numbers", () => {
    expect(waLink("984001234", "hi")).toBeNull();
    expect(waLink("", "hi")).toBeNull();
  });
});

describe("every customer phone input uses the shared helpers", () => {
  it("the saved-bill dialog: numeric keypad, 10-char cap, shared inline error", () => {
    const text = src("components/SendBillDialog.tsx");
    expect(text).toContain('from "@/lib/phoneInput"');
    expect(text).toContain("normalizePhoneInput(");
    expect(text).toMatch(/inputMode="numeric"/);
    expect(text).toMatch(/maxLength=\{10\}/);
    expect(text).toContain("PHONE_ERROR");
  });

  it("the billing sheet: phone-shaped input is capped at 10 as it is typed", () => {
    const text = src("routes/index.tsx");
    expect(text).toContain('from "@/lib/phoneInput"');
    expect(text).toContain("setCustQ(isPhoneShaped(v) ? normalizePhoneInput(v) : v)");
    // numeric keypad while the value is number-shaped (names keep text mode)
    expect(text).toMatch(/inputMode=\{[^}]*numeric[^}]*\}/);
    // inline 10-digit error under the field…
    expect(text).toContain("PHONE_ERROR");
    expect(text).toContain('data-testid="customer-phone-error"');
    // …and saving is blocked until it is exactly 10 digits
    expect(text).toMatch(/isPhoneShaped\(custQ\) && !isValidPhone\(custQ\)/);
  });

  it("Settings shop phone field is untouched by the customer-phone cap", () => {
    const text = src("routes/settings.tsx");
    expect(text).not.toContain("normalizePhoneInput");
    expect(text).not.toContain("PHONE_ERROR");
  });
});
