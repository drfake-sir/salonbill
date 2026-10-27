import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SendBillDialog } from "./SendBillDialog";
import { isValidPhone, normalizePhoneInput } from "@/lib/phoneInput";
import type { Bill, Settings } from "@/lib/db";

/* --------------------------------- mocks ---------------------------------- */

const customersUpdate = vi.fn((..._args: unknown[]) => Promise.resolve(1));
const customersAdd = vi.fn((..._args: unknown[]) => Promise.resolve(1));
vi.mock("@/lib/db", () => ({
  db: {
    customers: {
      update: (...a: unknown[]) => customersUpdate(...a),
      add: (...a: unknown[]) => customersAdd(...a),
    },
  },
}));

const shareBillPdf = vi.fn((..._args: unknown[]) => Promise.resolve("shared" as const));
vi.mock("@/lib/pdf", () => ({
  shareBillPdf: (...a: unknown[]) => shareBillPdf(...a),
}));

vi.mock("sonner", () => {
  const toast = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  });
  return { toast };
});

/* -------------------------------- fixtures -------------------------------- */

const settings = { id: 1 } as Settings;

const namedBill: Bill = {
  id: 9,
  number: "SB-0009",
  createdAt: Date.now(),
  status: "paid",
  customerId: 4,
  customerName: "Asha",
  customerPhone: "",
  lines: [],
  discountType: "pct",
  discountValue: 0,
  subtotal: 0,
  discount: 0,
  cgst: 0,
  sgst: 0,
  tip: 0,
  total: 0,
  payments: [{ mode: "Cash", amount: 0 }],
};

const walkInBill: Bill = { ...namedBill, id: 10, customerId: undefined, customerName: undefined };

const open = (bill: Bill) =>
  render(<SendBillDialog bill={bill} settings={settings} stylists={[]} onClose={vi.fn()} />);

const phoneInput = () => screen.getByLabelText("Customer phone") as HTMLInputElement;
const sendButton = () => screen.getByRole("button", { name: /Send/ });

beforeEach(() => {
  customersUpdate.mockClear();
  customersAdd.mockClear();
  shareBillPdf.mockClear();
});

/* --------------------------------- tests ---------------------------------- */

describe("phone normalisation and validation", () => {
  it("strips everything but digits, drops country/trunk prefixes, caps at 10", () => {
    expect(normalizePhoneInput("+91 98400 12345")).toBe("9840012345");
    expect(normalizePhoneInput("91 9840012345")).toBe("9840012345");
    expect(normalizePhoneInput("09840012345")).toBe("9840012345");
    expect(normalizePhoneInput("98765-43210-x")).toBe("9876543210");
    expect(normalizePhoneInput("")).toBe("");
  });

  it("accepts exactly 10 digits", () => {
    expect(isValidPhone("9840012345")).toBe(true);
    expect(isValidPhone("984001234")).toBe(false);
    expect(isValidPhone("98400123456")).toBe(false);
    expect(isValidPhone("984001234a")).toBe(false);
  });
});

describe("dialog behaviour", () => {
  it("Send stays disabled until exactly 10 digits are typed", () => {
    open(namedBill);
    expect(sendButton()).toBeDisabled();
    fireEvent.change(phoneInput(), { target: { value: "98400" } });
    expect(screen.getByText("Enter a 10-digit mobile number.")).toBeTruthy();
    expect(sendButton()).toBeDisabled();
    fireEvent.change(phoneInput(), { target: { value: "9840012345" } });
    expect(sendButton()).toBeEnabled();
    expect(screen.queryByText("Enter a 10-digit mobile number.")).toBeNull();
  });

  it("non-digits never enter the field (numeric keypad input)", () => {
    open(namedBill);
    fireEvent.change(phoneInput(), { target: { value: "98x4-00 12345" } });
    expect(phoneInput().value).toBe("9840012345");
  });

  it("does NOT save the number by default — only shares it", async () => {
    open(namedBill);
    fireEvent.change(phoneInput(), { target: { value: "9840012345" } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(shareBillPdf).toHaveBeenCalledTimes(1));
    expect(customersUpdate).not.toHaveBeenCalled();
    expect(customersAdd).not.toHaveBeenCalled();
    // The typed number rides along as the recipient — the bill object passed
    // to the share path carries it in memory only.
    const passed = shareBillPdf.mock.calls[0]?.[0] as Bill;
    expect(passed.customerPhone).toBe("9840012345");
    expect(passed.id).toBe(namedBill.id);
  });

  it("saves the number to the customer when the box is ticked", async () => {
    open(namedBill);
    fireEvent.change(phoneInput(), { target: { value: "9840012345" } });
    fireEvent.click(screen.getByLabelText("Save this number to the customer"));
    fireEvent.click(sendButton());
    await waitFor(() => expect(shareBillPdf).toHaveBeenCalledTimes(1));
    expect(customersUpdate).toHaveBeenCalledWith(4, { phone: "9840012345" });
    expect(customersAdd).not.toHaveBeenCalled();
  });

  it("shows the save checkbox only for named customers", () => {
    open(namedBill);
    expect(screen.getByLabelText("Save this number to the customer")).toBeTruthy();
  });

  it("hides the checkbox for walk-in bills", () => {
    open(walkInBill);
    expect(screen.queryByLabelText("Save this number to the customer")).toBeNull();
    // A walk-in can still be given a number for this send.
    fireEvent.change(phoneInput(), { target: { value: "9840012345" } });
    expect(sendButton()).toBeEnabled();
  });

  it("prefills and announces the current number when changing it", () => {
    open({ ...namedBill, customerPhone: "9840012345" });
    expect(phoneInput().value).toBe("9840012345");
    expect(screen.getByText(/Current number \+91 9840012345/)).toBeTruthy();
  });

  it("Cancel closes without sharing", () => {
    const onClose = vi.fn();
    render(<SendBillDialog bill={namedBill} settings={settings} stylists={[]} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(shareBillPdf).not.toHaveBeenCalled();
  });
});

describe("Bills list wiring", () => {
  it("opens the dialog instead of the dead-end toast, and never window.prompt", () => {
    // Read the source so this stays honest without rendering the full route.
    const src = readFileSync(join(__dirname, "..", "routes", "bills.tsx"), "utf8");
    expect(src).toContain("SendBillDialog");
    expect(src).toMatch(/if \(!b\.customerPhone\) \{\s*\n\s*\/\/ No number/);
    expect(src).not.toContain('toast.error("This bill has no customer phone number")');
    // The cancel-reason prompt is pre-existing and unrelated; the phone flow
    // must not use prompt.
    const phoneFlow = src.slice(src.indexOf("const share = async"), src.indexOf("const cancel"));
    expect(phoneFlow).not.toMatch(/prompt\(/);
  });
});
