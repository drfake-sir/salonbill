import { describe, it, expect } from "vitest";
import { computeTotals, inr, waRecipient, waLink, waText, billWaText } from "./billing";
import { askDeviceName, validateBackup, billNumberFor, StockShortageError } from "./db";
import type { Bill, Settings } from "./db";

const line = (price: number, qty = 1) => ({
  key: "k" + price,
  kind: "service" as const,
  refId: 1,
  name: "x",
  price,
  qty,
  gstRate: 18,
  commissionPct: 10,
});

describe("computeTotals", () => {
  it("adds CGST+SGST split equally when GST is on", () => {
    const t = computeTotals([line(300), line(600)], "flat", 0, true, 0);
    expect(t.cgst).toBe(81);
    expect(t.sgst).toBe(81);
    expect(t.total).toBe(1062);
  });
  it("has no tax when GST is off", () => {
    expect(computeTotals([line(1000)], "flat", 0, false, 0).total).toBe(1000);
  });
  it("applies percent discount before tax and adds tip", () => {
    const t = computeTotals([line(1000)], "pct", 10, true, 50);
    expect(t.discount).toBe(100);
    expect(t.total).toBe(900 + 162 + 50);
  });
  it("never discounts more than the subtotal", () => {
    expect(computeTotals([line(200)], "flat", 500, false, 0).total).toBe(0);
  });
});

describe("waRecipient", () => {
  it("accepts a plain 10-digit Indian number", () => {
    expect(waRecipient("9840012345")).toBe("919840012345");
  });
  it("strips trunk zero and country-code formats", () => {
    expect(waRecipient("09840012345")).toBe("919840012345");
    expect(waRecipient("+91 98400 12345")).toBe("919840012345");
    expect(waRecipient("91-98400-12345")).toBe("919840012345");
    expect(waRecipient("00919840012345")).toBe("919840012345");
  });
  it("rejects numbers that are not 10 digits", () => {
    expect(waRecipient("12345")).toBeNull();
    expect(waRecipient("9840012345678")).toBeNull();
    expect(waRecipient("")).toBeNull();
  });
});

describe("waLink / waText", () => {
  it("builds an encoded wa.me link", () => {
    expect(waLink("9840012345", "hi there")).toBe("https://wa.me/919840012345?text=hi%20there");
  });
  it("returns null for an invalid phone so we never open WhatsApp broken", () => {
    expect(waLink("abc", "x")).toBeNull();
  });
  it("includes bill number, items and total for saved bills", () => {
    const settings = { salonName: "Glow" } as Settings;
    const bill = {
      number: "SB-0007",
      customerName: "Meena",
      total: 708,
      lines: [
        {
          key: "k",
          kind: "service",
          refId: 1,
          name: "Haircut",
          price: 600,
          qty: 1,
          gstRate: 18,
          commissionPct: 10,
        },
      ],
    } as Bill;
    const text = billWaText(bill, settings);
    expect(text).toContain("Bill SB-0007");
    expect(text).toContain("Haircut x1");
    expect(text).toContain("₹708");
  });
  it("omits the bill number for unsaved bills", () => {
    const text = waText({ name: "Glow", items: ["A x1 – ₹10"], total: "₹10" });
    expect(text.startsWith("Glow\n")).toBe(true);
    expect(text).not.toContain("Bill ");
  });
});

describe("bill numbering & save safeguards", () => {
  it("pads bill numbers to four digits", () => {
    expect(billNumberFor(1)).toBe("SB-0001");
    expect(billNumberFor(4321)).toBe("SB-4321");
  });
  it("carries shortages on StockShortageError", () => {
    const e = new StockShortageError([{ name: "Serum", available: 1, wanted: 3 }]);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("StockShortageError");
    expect(e.shortages[0]?.available).toBe(1);
  });
});

describe("validateBackup", () => {
  const good = { bills: [{ number: "SB-0001", lines: [] }], settings: [{ id: 1 }] };
  it("accepts a real backup shape", () => {
    expect(validateBackup(good)).toBe(true);
  });
  it("rejects junk that would wipe data if trusted", () => {
    expect(validateBackup(null)).toBe(false);
    expect(validateBackup("hello")).toBe(false);
    expect(validateBackup([])).toBe(false);
    expect(validateBackup({})).toBe(false);
    expect(validateBackup({ bills: [{ nope: 1 }], settings: [] })).toBe(false);
    expect(validateBackup({ bills: "x", settings: [] })).toBe(false);
  });
});

describe("inr", () => {
  it("formats Indian-grouped thousands", () => {
    expect(inr(1234)).toBe("₹1,234");
    expect(inr(450000)).toBe("₹4,50,000");
  });
});

describe("askDeviceName", () => {
  it("uses the owner's answer, trimmed and length-capped", () => {
    expect(askDeviceName("Device ab12", () => "  Counter  ")).toBe("Counter");
    expect(askDeviceName("Device ab12", () => "x".repeat(80))).toHaveLength(40);
  });

  it("falls back when the dialog is dismissed or answered blank", () => {
    expect(askDeviceName("Device ab12", () => null)).toBe("Device ab12");
    expect(askDeviceName("Device ab12", () => "   ")).toBe("Device ab12");
    expect(askDeviceName("Device ab12", () => 42 as unknown as string)).toBe("Device ab12");
  });

  it("REGRESSION: a throwing prompt still yields a name instead of failing", () => {
    // connect() calls this AFTER saving the sync token, so a throw here used
    // to abort the connection and leave the device unnamed forever — every
    // bill it wrote then exported as "Unknown device".
    const boom = () => {
      throw new Error("prompt() is not supported.");
    };
    let name: string | undefined;
    expect(() => {
      name = askDeviceName("Device ab12", boom);
    }).not.toThrow();
    expect(name).toBe("Device ab12");
  });

  it("always produces a non-empty name so a bill is never stamped blank", () => {
    expect(askDeviceName("Device ab12", () => "")).not.toBe("");
    expect(
      askDeviceName("Device ab12", () => {
        throw new Error("x");
      }),
    ).not.toBe("");
  });
});
