import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const settings = { id: 1, salonName: "Glow Studio" } as Settings;

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
const whatsAppButton = () => screen.getByRole("button", { name: "WhatsApp" });
const sharePdfButton = () => screen.getByRole("button", { name: "Share PDF" });

// Never let a test really navigate anywhere: wa.me is only ever *checked*.
const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

beforeEach(() => {
  customersUpdate.mockClear();
  customersAdd.mockClear();
  shareBillPdf.mockClear();
  openSpy.mockClear();
});

afterAll(() => {
  openSpy.mockRestore();
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

  it("field is numeric-keypad and capped at 10 characters", () => {
    open(namedBill);
    expect(phoneInput().getAttribute("inputmode")).toBe("numeric");
    expect(phoneInput().getAttribute("maxlength")).toBe("10");
  });

  it("accepts exactly 10 digits", () => {
    expect(isValidPhone("9840012345")).toBe(true);
    expect(isValidPhone("984001234")).toBe(false);
    expect(isValidPhone("98400123456")).toBe(false);
    expect(isValidPhone("984001234a")).toBe(false);
  });
});

describe("dialog behaviour", () => {
  it("both buttons stay disabled until exactly 10 digits are typed", () => {
    open(namedBill);
    expect(whatsAppButton()).toBeDisabled();
    expect(sharePdfButton()).toBeDisabled();
    fireEvent.change(phoneInput(), { target: { value: "98400" } });
    expect(screen.getByText("Enter a 10-digit mobile number.")).toBeTruthy();
    expect(whatsAppButton()).toBeDisabled();
    fireEvent.change(phoneInput(), { target: { value: "9840012345" } });
    expect(whatsAppButton()).toBeEnabled();
    expect(sharePdfButton()).toBeEnabled();
    expect(screen.queryByText("Enter a 10-digit mobile number.")).toBeNull();
  });

  it("WhatsApp is the MAIN button and Share PDF is the smaller second one", () => {
    open(namedBill);
    const wa = whatsAppButton();
    const pdf = sharePdfButton();
    // Main action = primary, larger; PDF = secondary, smaller.
    expect(wa.className).toContain("bg-primary");
    expect(wa.className).toContain("px-5");
    expect(pdf.className).toContain("bg-secondary");
    expect(pdf.className).toContain("px-4");
    // …and they are the same footer row, after Cancel.
    expect(wa.parentElement).toBe(pdf.parentElement);
  });

  it("non-digits never enter the field (numeric keypad input)", () => {
    open(namedBill);
    fireEvent.change(phoneInput(), { target: { value: "98x4-00 12345" } });
    expect(phoneInput().value).toBe("9840012345");
  });

  it("does NOT save the number by default — only shares it", async () => {
    open(namedBill);
    fireEvent.change(phoneInput(), { target: { value: "9840012345" } });
    fireEvent.click(sharePdfButton());
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
    fireEvent.click(sharePdfButton());
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
    expect(whatsAppButton()).toBeEnabled();
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

describe("the WhatsApp button opens the customer's own chat", () => {
  it("builds wa.me/91 + 10 digits with the bill text and never opens for free", async () => {
    open(namedBill);
    fireEvent.change(phoneInput(), { target: { value: "9840012345" } });
    fireEvent.click(whatsAppButton());
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));

    const [url, target, features] = openSpy.mock.calls[0] as [string, string, string];
    expect(url).toMatch(/^https:\/\/wa\.me\/919840012345\?text=/);
    expect(target).toBe("_blank");
    expect(features).toBe("noopener");
    // Every newline in the message reaches WhatsApp percent-encoded as %0A.
    expect(url).toContain("%0A");
    expect(url).not.toContain("\n");
    expect(decodeURIComponent(url.split("?text=")[1] ?? "")).toContain("Glow Studio");
    expect(decodeURIComponent(url.split("?text=")[1] ?? "")).toContain("Bill SB-0009");
    // The WhatsApp action is text-only — the PDF path is a separate button.
    expect(shareBillPdf).not.toHaveBeenCalled();
  });

  it("no URL is built while the number is incomplete", () => {
    open(namedBill);
    fireEvent.change(phoneInput(), { target: { value: "98400" } });
    fireEvent.click(whatsAppButton());
    expect(openSpy).not.toHaveBeenCalled();
    expect(shareBillPdf).not.toHaveBeenCalled();
  });

  it("Share PDF keeps the existing share path (never a wa.me deep link)", async () => {
    open(namedBill);
    fireEvent.change(phoneInput(), { target: { value: "9840012345" } });
    fireEvent.click(sharePdfButton());
    await waitFor(() => expect(shareBillPdf).toHaveBeenCalledTimes(1));
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe("Bills list wiring", () => {
  it("main row button is WhatsApp (wa.me), PDF stays the second button", () => {
    const src = readFileSync(join(__dirname, "..", "routes", "bills.tsx"), "utf8");
    // The row opens the chat directly through the shared URL builder…
    expect(src).toContain("waBillLink(b, settings)");
    expect(src).toContain('isValidPhone(b.customerPhone ?? "")');
    // …and falls back to the dialog when the number is not exactly 10 digits.
    expect(src).toContain("setDialogBill(b)");
    expect(src).toContain('aria-label="Open WhatsApp chat"');
    // The row uses the real WhatsApp logo, never the generic chat bubble.
    expect(src).toContain('<WhatsAppIcon className="size-4" />');
    expect(src).not.toContain("MessageCircle");
    // The PDF share path keeps its own, smaller button.
    expect(src).toContain('aria-label="Share bill PDF"');
    expect(src).toContain("void share(b)");
  });

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
