import { describe, it, expect } from "vitest";
import {
  computeTotals,
  inr,
  waRecipient,
  waLink,
  waText,
  billWaText,
  waBillLink,
  waBillMessage,
} from "./billing";
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

/* -------------------- wa.me chat deep link (open chat) -------------------- */

const shop = { id: 1, salonName: "Glow Studio" } as Settings;

/** 05 Jan 2026, 04:00 UTC = 09:30 IST (+05:30). */
const chatBill = {
  id: 7,
  number: "SB-0042",
  createdAt: Date.UTC(2026, 0, 5, 4, 0),
  status: "paid",
  customerName: "Asha",
  customerPhone: "9840012345",
  lines: [
    { key: "a", kind: "service", refId: 1, name: "Haircut", price: 600, qty: 2 },
    { key: "b", kind: "product", refId: 2, name: "Shampoo", price: 250, qty: 1 },
  ],
  discountType: "flat",
  discountValue: 50,
  subtotal: 1450,
  discount: 50,
  cgst: 0,
  sgst: 0,
  tip: 20,
  total: 1420,
  payments: [
    { mode: "Cash", amount: 420 },
    { mode: "UPI", amount: 1000 },
  ],
} as unknown as Bill;

const bareBill = { ...chatBill, discount: 0, tip: 0, payments: [] } as Bill;

describe("waBillMessage — the text that lands in the chat", () => {
  it("carries shop, bill number, IST date/time, one line per item, money and thanks", () => {
    const text = waBillMessage(chatBill, shop);
    const rows = text.split("\n");
    expect(rows[0]).toBe("Glow Studio");
    expect(rows[1]).toBe("Bill SB-0042");
    // 04:00 UTC renders as 09:30 in IST, never as the device's local time.
    expect(rows[2]).toMatch(/9:30/);
    expect(rows[2]).not.toMatch(/4:00/);
    expect(rows[3]).toBe("Haircut x2 - ₹1,200");
    expect(rows[4]).toBe("Shampoo x1 - ₹250");
    expect(text).toContain("Discount - ₹50");
    expect(text).toContain("Tip - ₹20");
    expect(text).toContain("Payment - Cash + UPI");
    expect(text).toContain("Total - ₹1,420");
    expect(text).toContain("Thank you! 🙏");
  });

  it("hides empty lines — no discount, no tip, no payments, no blank rows", () => {
    const text = waBillMessage(bareBill, shop);
    expect(text).not.toContain("Discount");
    expect(text).not.toContain("Tip");
    expect(text).not.toContain("Payment");
    expect(text).not.toContain("\n\n"); // no gaps where a hidden line was
    expect(text.split("\n").every((r) => r.trim().length > 0)).toBe(true);
    // What is always shown stays shown.
    expect(text).toContain("Glow Studio");
    expect(text).toContain("Total - ₹1,420");
  });

  it("drops the shop line when the salon name is blank", () => {
    const text = waBillMessage(chatBill, { id: 1, salonName: "" } as Settings);
    expect(text.startsWith("Bill SB-0042")).toBe(true);
    expect(text).not.toContain("\n\n");
  });

  it("only reads the saved bill — the total is never recomputed", () => {
    // Deliberately "wrong" money: the message must echo it, not fix it.
    expect(waBillMessage({ ...chatBill, total: 4242 } as Bill, shop)).toContain("Total - ₹4,242");
  });
});

describe("waBillLink — builds the deep link or nothing at all", () => {
  it("builds https://wa.me/91 + the 10 digits", () => {
    expect(waBillLink(chatBill, shop)).toMatch(/^https:\/\/wa\.me\/919840012345\?text=/);
  });

  it("percent-encodes the text: newlines arrive as %0A, never raw", () => {
    const url = waBillLink(chatBill, shop)!;
    expect(url).toContain("%0A");
    expect(url.slice(url.indexOf("?text=")).includes("\n")).toBe(false);
    const decoded = decodeURIComponent(url.split("?text=")[1] ?? "");
    expect(decoded).toBe(waBillMessage(chatBill, shop));
    expect(decoded).toContain("Glow Studio");
    expect(decoded).toContain("Haircut x2 - ₹1,200");
  });

  it("returns null — no URL is built — for an unusable number", () => {
    expect(waBillLink({ ...chatBill, customerPhone: "984001234" } as Bill, shop)).toBeNull();
    expect(waBillLink({ ...chatBill, customerPhone: "98400123456" } as Bill, shop)).toBeNull();
    expect(waBillLink({ ...chatBill, customerPhone: "" } as Bill, shop)).toBeNull();
    expect(waBillLink({ ...chatBill, customerPhone: undefined } as Bill, shop)).toBeNull();
  });

  it("still accepts prefixed stored numbers and normalises to 91 + 10", () => {
    const url = waBillLink({ ...chatBill, customerPhone: "+91 98400 12345" } as Bill, shop)!;
    expect(url).toMatch(/^https:\/\/wa\.me\/919840012345\?text=/);
  });
});
