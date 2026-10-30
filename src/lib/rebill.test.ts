import { describe, expect, it } from "vitest";
import type { Bill } from "./db";
import { REBILL_KEY, rebillPayload, takeRebill } from "./rebill";

const saved = {
  id: 42,
  number: "SB-0007",
  createdAt: Date.UTC(2026, 0, 5),
  status: "paid",
  customerId: 3,
  customerName: "Ravi Kumar",
  customerPhone: "9876543210",
  lines: [
    {
      key: "old-key-1",
      kind: "service",
      refId: 11,
      name: "Haircut",
      price: 300,
      qty: 2,
      gstRate: 0,
      commissionPct: 10,
      commissionAmount: 60,
      stylistId: 5,
      stylistName: "Karthik",
    },
    {
      key: "old-key-2",
      kind: "product",
      refId: 21,
      name: "Hair Oil",
      price: 250,
      qty: 1,
      gstRate: 0,
      commissionPct: 0,
      commissionAmount: 0,
      stylistId: undefined,
      stylistName: undefined,
    },
  ],
  discountType: "flat",
  discountValue: 0,
  subtotal: 850,
  discount: 0,
  cgst: 0,
  sgst: 0,
  tip: 0,
  total: 850,
  payments: [{ mode: "UPI" as const, amount: 850 }],
} as unknown as Bill;

describe("rebillPayload — what the new draft starts from", () => {
  it("carries items, quantities, stylists, customer and payment mode", () => {
    const p = rebillPayload(saved);
    expect(p.lines).toHaveLength(2);
    expect(p.lines[0]).toMatchObject({
      name: "Haircut",
      qty: 2,
      price: 300,
      stylistId: 5,
      stylistName: "Karthik",
      refId: 11,
      kind: "service",
    });
    expect(p.lines[1]).toMatchObject({ name: "Hair Oil", qty: 1, price: 250 });
    expect(p.customerId).toBe(3);
    expect(p.customerName).toBe("Ravi Kumar");
    expect(p.customerPhone).toBe("9876543210");
    expect(p.mode).toBe("UPI");
  });

  it("drops the saved identity so the new bill is a separate row", () => {
    const p = rebillPayload(saved);
    // Nothing on the payload can point back at the cancelled row: no id and
    // no bill number, so commitSale issues a NEW number on Save.
    expect("id" in p).toBe(false);
    expect("number" in p).toBe(false);
    expect(p.from).toBe("SB-0007"); // toast-only, never written to the new bill
    // Fresh line keys — the new bill never reuses the old row's line identity.
    expect(p.lines.map((l) => l.key)).not.toContain("old-key-1");
    expect(new Set(p.lines.map((l) => l.key)).size).toBe(2);
  });

  it("only reads saved values — no money is recomputed", () => {
    const p = rebillPayload(saved);
    const line = p.lines[0]!;
    expect(line.price).toBe(300);
    expect(line.qty).toBe(2);
    expect(line.commissionAmount).toBe(60);
    expect("total" in p).toBe(false); // totals are re-derived at save, from the lines
    expect("subtotal" in p).toBe(false);
  });
});

describe("takeRebill — consumed exactly once", () => {
  it("returns null when nothing is stored", () => {
    sessionStorage.removeItem(REBILL_KEY);
    expect(takeRebill()).toBeNull();
  });

  it("round-trips a stored payload and then forgets it", () => {
    sessionStorage.setItem(
      REBILL_KEY,
      JSON.stringify({ ...rebillPayload(saved), from: "SB-0007" }),
    );
    const first = takeRebill();
    expect(first?.lines).toHaveLength(2);
    expect(first?.mode).toBe("UPI");
    // Second take is empty: one cancelled bill can only spawn one new bill.
    expect(takeRebill()).toBeNull();
  });

  it("ignores a corrupt or empty payload", () => {
    sessionStorage.setItem(REBILL_KEY, "not json");
    expect(takeRebill()).toBeNull();
    sessionStorage.setItem(REBILL_KEY, JSON.stringify({ lines: [], mode: "Cash" }));
    expect(takeRebill()).toBeNull();
    sessionStorage.removeItem(REBILL_KEY);
  });
});
