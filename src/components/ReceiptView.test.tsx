import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReceiptView } from "./ReceiptView";
import type { Bill, Settings } from "@/lib/db";
import { SHOP_DEFAULTS, OLD_DEMO_SETTINGS } from "@/lib/shopDefaults";
import { billWaText } from "@/lib/billing";

const bill: Bill = {
  id: 1,
  number: "SB-0001",
  createdAt: Date.now(),
  status: "paid",
  lines: [
    {
      key: "k1",
      kind: "service",
      refId: 1,
      name: "Men's Haircut",
      price: 200,
      qty: 1,
      gstRate: 18,
      commissionPct: 10,
    },
  ],
  discountType: "pct",
  discountValue: 0,
  subtotal: 200,
  discount: 0,
  cgst: 18,
  sgst: 18,
  tip: 0,
  total: 236,
  payments: [{ mode: "Cash", amount: 236 }],
};

/** Settings exactly like a fresh install / the Settings live preview. */
const freshSettings: Settings = {
  id: 1,
  ...SHOP_DEFAULTS,
  paper: "80mm",
  autoPrint: false,
  ownerPin: "1234",
  billSeq: 0,
  onboarded: true,
};

const demoSettings: Settings = { ...freshSettings, ...OLD_DEMO_SETTINGS };

describe("receipt with empty address / GST off (new-salon defaults)", () => {
  it("hides the address line but keeps shop name and phone in the header", () => {
    const { container, queryByText, getByText } = render(
      <ReceiptView bill={bill} settings={freshSettings} stylists={[]} />,
    );
    expect(getByText(SHOP_DEFAULTS.salonName)).toBeTruthy();
    expect(getByText(/Ph: \+91 63791 83898/)).toBeTruthy();
    // Address is empty → no address line rendered at all.
    expect(container.textContent).not.toContain("Chennai");
    const header = container.textContent ?? "";
    expect(header.includes("undefined")).toBe(false);
  });

  it("never prints GSTIN, CGST/SGST or the review QR when GST is off / fields empty", () => {
    const { container, queryByText } = render(
      <ReceiptView bill={bill} settings={freshSettings} stylists={[]} />,
    );
    expect(container.textContent).not.toContain("GSTIN");
    expect(queryByText("CGST")).toBeNull();
    expect(queryByText("SGST")).toBeNull();
    expect(queryByText(/Review us on Google/)).toBeNull();
  });

  it("hides an empty footer line", () => {
    const { container } = render(
      <ReceiptView bill={bill} settings={{ ...freshSettings, footer: "" }} stylists={[]} />,
    );
    expect(container.textContent).not.toContain("Thank you! Visit again");
  });

  it("still prints everything when the values exist (GST on)", () => {
    const { container, queryByText, getByText } = render(
      <ReceiptView bill={bill} settings={demoSettings} stylists={[]} />,
    );
    expect(container.textContent).toContain(OLD_DEMO_SETTINGS.address);
    expect(container.textContent).toContain(`GSTIN: ${OLD_DEMO_SETTINGS.gstin}`);
    expect(queryByText("CGST")).toBeTruthy();
    expect(queryByText("SGST")).toBeTruthy();
    expect(queryByText(/Review us on Google/)).toBeTruthy();
    expect(container.textContent).toContain(OLD_DEMO_SETTINGS.footer);
    expect(getByText(/Ph: \+91 98400 12345/)).toBeTruthy();
  });

  it("a saved bill's snapshot wins, so reprints never change (existing rule)", () => {
    const withReceipt: Bill = {
      ...bill,
      receipt: {
        salonName: "Old Name",
        address: "",
        phone: "+91 11111 11111",
        gstOn: false,
        gstin: "",
        footer: "",
        reviewUrl: "",
      },
    };
    const { container } = render(
      <ReceiptView bill={withReceipt} settings={demoSettings} stylists={[]} />,
    );
    expect(container.textContent).toContain("Old Name");
    expect(container.textContent).not.toContain("GSTIN");
    expect(container.textContent).not.toContain("Chennai");
  });
});

describe("WhatsApp message carries none of the receipt-only lines", () => {
  it("no address, GSTIN, review link or footer text", () => {
    const text = billWaText(bill, demoSettings);
    expect(text).not.toContain("GSTIN");
    expect(text).not.toContain(OLD_DEMO_SETTINGS.address);
    expect(text).not.toContain("g.page");
    expect(text).not.toContain(OLD_DEMO_SETTINGS.footer);
    expect(text).toContain("Bill SB-0001");
  });
});
