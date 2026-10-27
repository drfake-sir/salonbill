import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { typedCustomerName } from "./billing";
import { servedByLabel } from "./servedBy";
import type { BillLine } from "./db";

/**
 * A typed customer NAME must reach the saved bill even when there is no phone
 * (and therefore no customer record). These tests pin the rule at both ends:
 * the pure helper that decides what a typed string is, and every surface that
 * has to show it afterwards.
 */

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const indexSrc = read("routes/index.tsx");
const billsSrc = read("routes/bills.tsx");
const dbSrc = read("lib/db.ts");
const receiptSrc = read("components/ReceiptView.tsx");
const pdfSrc = read("lib/pdf.ts");
const exportSrc = read("lib/export.ts");
const billingSrc = read("lib/billing.ts");
const sendSrc = read("components/SendBillDialog.tsx");

describe("typedCustomerName decides what was typed", () => {
  it("keeps a name-only entry", () => {
    expect(typedCustomerName("syed")).toBe("syed");
    expect(typedCustomerName("  Syed  Ahmed  ")).toBe("Syed Ahmed");
    expect(typedCustomerName("syed123")).toBe("syed123");
  });

  it("empty or blank stays a Walk-in", () => {
    expect(typedCustomerName("")).toBeUndefined();
    expect(typedCustomerName("   ")).toBeUndefined();
    expect(typedCustomerName(undefined)).toBeUndefined();
  });

  it("digits alone are a phone number — that flow is unchanged", () => {
    expect(typedCustomerName("9840012345")).toBeUndefined();
    expect(typedCustomerName("09840012345")).toBeUndefined();
    expect(typedCustomerName("98400 12345")).toBeUndefined();
  });

  it("caps the name at 60 characters", () => {
    const long = "n".repeat(120);
    expect(typedCustomerName(long)).toHaveLength(60);
  });
});

describe("the typed name reaches the bill row and the draft", () => {
  it("both write paths fall back to the typed name", () => {
    expect(indexSrc).toMatch(/customerName: cust\?\.name \?\? typedCustomerName\(custQ\)/);
    const uses = indexSrc.split("typedCustomerName(custQ)").length - 1;
    expect(uses).toBeGreaterThanOrEqual(3); // build, draft autosave, "Saving as"
    // It is imported from lib/billing, not re-implemented in the route.
    expect(indexSrc).toMatch(
      /import \{ computeTotals, inr, typedCustomerName \} from "@\/lib\/billing"/,
    );
  });

  it("the field is labelled, hinted, and previews the name it will save", () => {
    expect(indexSrc).toContain("Customer name or phone");
    expect(indexSrc).toContain("Add a phone to save the customer and send on WhatsApp");
    expect(indexSrc).toMatch(/data-testid="saving-as"/);
    expect(indexSrc).toMatch(/Saving as: \{typedCustomerName\(custQ\)\}/);
    expect(indexSrc).toMatch(/maxLength=\{60\}/);
  });

  it("customerName stays an OPTIONAL field — old bills keep loading", () => {
    expect(dbSrc).toMatch(/customerName\?: string \| undefined;/); // Bill
    const draftIdx = dbSrc.indexOf("export type Draft");
    expect(dbSrc.slice(draftIdx, draftIdx + 600)).toMatch(/customerName\?: string \| undefined;/);
    // No index change, so no migration is involved.
    expect(dbSrc).not.toMatch(/index\("customerName"\)/);
  });

  it("a name alone never creates a customer record (phone required)", () => {
    expect(indexSrc).toMatch(/const newCustomer =\s*cust && !cust\.id && cust\.phone/);
    // The hold path follows the same rule.
    expect(indexSrc).toMatch(
      /cust && !cust\.id && cust\.phone\s*\?\s*\(\(await db\.customers\.add/,
    );
  });
});

describe("every surface shows the name instead of “Walk-in”", () => {
  it("Bills list and bill detail", () => {
    expect(billsSrc.match(/customerName \?\? "Walk-in"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(billsSrc).toMatch(/>Customer<\/span> ·/);
  });

  it("receipt preview, PDF and WhatsApp text", () => {
    expect(receiptSrc).toMatch(/Customer: \{bill\.customerName\}/);
    expect(pdfSrc).toMatch(/bill\.customerName \?\? "Walk-in customer"/);
    expect(billingSrc).toMatch(/name: b\.customerName \?\? settings\.salonName/);
  });

  it("the bills CSV", () => {
    expect(exportSrc).toMatch(/b\.customerName \?\? "Walk-in",/);
  });

  it("the WhatsApp dialog can create a customer from name + typed number", () => {
    expect(sendSrc).toMatch(/const named = Boolean\(bill\.customerName\)/);
    expect(sendSrc).toMatch(/await db\.customers\.add\(\{ name: bill\.customerName, phone,/);
    // …without editing the saved bill itself (append-only).
    expect(sendSrc).not.toMatch(/db\.bills\.(update|put)/);
    expect(sendSrc).toMatch(/\{named && \(/);
  });
});

describe("the bill detail says who billed and who served", () => {
  it("Billed by (cashier), Served by (line stylists) and Device", () => {
    expect(billsSrc).toMatch(/>Billed by<\/span> ·/);
    expect(billsSrc).toMatch(/>Served by<\/span> ·/);
    expect(billsSrc).toMatch(/>Device<\/span> ·/);
    expect(billsSrc).toMatch(/servedByLabel\(b\.lines\)/);
    expect(receiptSrc).toMatch(/Billed by: \{bill\.cashierName\}/);
    expect(receiptSrc).toMatch(/Device: \{deviceLabel\(bill\)\}/);
    // The per-line attribution on the receipt is what "Served by" summarises.
    expect(receiptSrc).toMatch(/by \{sty\(l\)\}/);
  });

  it("servedByLabel lists distinct line stylists and prints nothing otherwise", () => {
    const line = (stylistName?: string) => ({ stylistName }) as BillLine;
    expect(servedByLabel([line("Arun"), line("Arun"), line("Priya")])).toBe("Arun, Priya");
    expect(servedByLabel([line(undefined), line("") as BillLine])).toBeUndefined();
    expect(servedByLabel([])).toBeUndefined();
  });
});
