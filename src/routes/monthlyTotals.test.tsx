import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { MonthlyTotals } from "./bills";
import { setSession } from "@/lib/lock";
import type { Bill } from "@/lib/db";

/* --------------------------------- mocks --------------------------------- */

let ownerNow = false;

vi.mock("@/lib/lock", () => ({
  useOwner: () => ownerNow,
  useSession: () => (ownerNow ? { role: "owner", name: "Owner" } : null),
  setSession: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { bills: {}, settings: {}, stylists: {}, customers: {} },
  cancelBill: vi.fn(),
  deviceLabel: () => "Counter",
}));

vi.mock("@/components/PinGate", () => ({
  PinPad: ({ onOk }: { onOk?: () => void }) => (
    <div data-testid="pin-pad">
      <button onClick={() => onOk?.()}>unlock</button>
    </div>
  ),
  OwnerOnly: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ReceiptView", () => ({ ReceiptView: () => null }));
vi.mock("@/components/PrintPortal", () => ({
  PrintPortal: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/SendBillDialog", () => ({ SendBillDialog: () => null }));
vi.mock("@/lib/pdf", () => ({ shareBillPdf: vi.fn() }));
vi.mock("@/lib/print", () => ({ printBill: vi.fn() }));
vi.mock("sonner", () => {
  const toast = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  });
  return { toast };
});

/* -------------------------------- fixtures -------------------------------- */

const bill = (total: number): Bill =>
  ({
    id: total,
    number: `SB-${total}`,
    createdAt: Date.now(),
    status: "paid",
    customerName: "",
    customerPhone: "",
    lines: [],
    discountType: "pct",
    discountValue: 0,
    subtotal: total,
    discount: 0,
    cgst: 0,
    sgst: 0,
    tip: 0,
    total,
    payments: [{ mode: "Cash", amount: total }],
  }) as Bill;

const BILLS = [bill(1000), bill(2500)];

const header = () => screen.getByTestId("monthly-totals-header");
const open = () => expect(header()).toHaveAttribute("aria-expanded", "true");
const shut = () => expect(header()).toHaveAttribute("aria-expanded", "false");

const renderLocked = () => {
  ownerNow = false;
  return render(<MonthlyTotals owner={false} bills={BILLS} />);
};

/* --------------------------------- tests ---------------------------------- */

describe("Monthly totals is one toggle — open and close by every affordance", () => {
  it("tapping the header opens it", () => {
    renderLocked();
    shut();
    fireEvent.click(header());
    open();
  });

  it("tapping the header AGAIN closes it while still locked", () => {
    renderLocked();
    fireEvent.click(header());
    open();
    fireEvent.click(header()); // the old code force-opened the pad here
    shut();
    expect(screen.queryByTestId("pin-pad")).toBeNull();
  });

  it("closes with the Close button under the pad", () => {
    renderLocked();
    fireEvent.click(header());
    fireEvent.click(screen.getByTestId("monthly-totals-close"));
    shut();
    expect(screen.queryByTestId("pin-pad")).toBeNull();
  });

  it("closes on Escape", () => {
    renderLocked();
    fireEvent.click(header());
    open();
    fireEvent.keyDown(window, { key: "Escape" });
    shut();
    expect(screen.queryByTestId("pin-pad")).toBeNull();
  });

  it("closes when tapping outside the pad", () => {
    renderLocked();
    fireEvent.click(header());
    open();
    fireEvent.pointerDown(document.body);
    shut();
  });

  it("reopens with cleared digits after a close", () => {
    renderLocked();
    fireEvent.click(header());
    const first = screen.getByTestId("pin-pad");
    fireEvent.click(screen.getByTestId("monthly-totals-close"));
    fireEvent.click(header());
    expect(screen.getByTestId("pin-pad")).not.toBe(first); // remounted
  });
});

describe("owner-only figures are absent from the DOM while locked", () => {
  it("the locked header shows only “Monthly totals / Owner only”", () => {
    renderLocked();
    const text = header().textContent ?? "";
    expect(text).toContain("Monthly totals");
    expect(text).toContain("Owner only");
    expect(text).not.toContain("₹");
    expect(text).not.toContain("across");
    expect(text).not.toContain("bills");
  });

  it("no amount or count anywhere in the locked card", () => {
    renderLocked();
    const card = header().closest("div") as HTMLElement;
    expect(card.textContent ?? "").not.toContain("₹");
    expect(card.textContent ?? "").not.toContain("across");
  });
});

describe("after the owner unlocks the figures appear, and Lock re-hides them", () => {
  it("the unlocked header shows the month total and bill count", () => {
    ownerNow = true;
    render(<MonthlyTotals owner bills={BILLS} />);
    const text = header().textContent ?? "";
    expect(text).toMatch(/₹[0-9,]+/);
    expect(text).toContain("across 2 bills");
  });

  it("the panel carries a Lock button that ends the owner session", () => {
    ownerNow = true;
    render(<MonthlyTotals owner bills={BILLS} />);
    fireEvent.click(header()); // open the owner panel
    fireEvent.click(screen.getByTestId("monthly-totals-lock"));
    expect(vi.mocked(setSession)).toHaveBeenCalledWith(null);
  });

  it("when the owner session ends, the figures lock again", () => {
    ownerNow = true;
    const { rerender } = render(<MonthlyTotals owner bills={BILLS} />);
    expect(header().textContent ?? "").toContain("across 2 bills");
    // Session ended (auto-lock / sign out) → parent re-renders with owner=false.
    ownerNow = false;
    rerender(<MonthlyTotals owner={false} bills={BILLS} />);
    expect(header().textContent ?? "").not.toContain("₹");
    expect(header().textContent ?? "").not.toContain("across");
    shut();
  });
});
