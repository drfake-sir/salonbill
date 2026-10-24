import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { normalizeCancelReason } from "./db";

/**
 * Cancel reason must contain real text — a whitespace-only reason (" ", "\t\n")
 * can never cancel a bill, at either layer:
 *  - the UI prompt trims and returns early on empty (routes/bills.tsx),
 *  - cancelBill rejects it before opening the transaction (normalizeCancelReason).
 */

describe("whitespace-only cancel reason is rejected", () => {
  it("normalizeCancelReason throws on whitespace-only and empty input", () => {
    expect(() => normalizeCancelReason("   ")).toThrow(/reason is required/);
    expect(() => normalizeCancelReason("\t\n  ")).toThrow(/reason is required/);
    expect(() => normalizeCancelReason("")).toThrow(/reason is required/);
    expect(() => normalizeCancelReason(null)).toThrow(/reason is required/);
    expect(() => normalizeCancelReason(undefined)).toThrow(/reason is required/);
  });

  it("normalizeCancelReason trims valid reasons", () => {
    expect(normalizeCancelReason("  Customer changed mind  ")).toBe("Customer changed mind");
    expect(normalizeCancelReason("Refund given")).toBe("Refund given");
  });

  it("the cancel UI trims the prompt value and bails on empty input", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "routes", "bills.tsx"), "utf8");
    // Prompt result is trimmed immediately…
    expect(src).toMatch(/prompt\(`Reason for cancelling [^`]*`\)\?\.trim\(\)/);
    // …and an empty/whitespace-only value returns before cancelBill is called.
    const at = src.indexOf("const cancel = async");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 700);
    expect(body).toMatch(/if \(!reason\) return;/);
    expect(body).toMatch(/cancelBill\(b\.id!, reason,/); // passes the cleaned value
  });

  it("cancelBill validates the reason before opening its transaction", () => {
    const src = fs.readFileSync(path.join(__dirname, "db.ts"), "utf8");
    const fnAt = src.indexOf("export async function cancelBill");
    expect(fnAt).toBeGreaterThan(-1);
    const nextFn = src.indexOf("\nexport ", fnAt + 10);
    const fnBody = src.slice(fnAt, nextFn === -1 ? undefined : nextFn);
    // Validation happens up front — a blank reason can never reach the writes.
    expect(fnBody).toMatch(/normalizeCancelReason\(reason\)/);
    expect(fnBody.indexOf("normalizeCancelReason(reason)")).toBeLessThan(
      fnBody.indexOf("db.transaction"),
    );
    // The stored value is the cleaned one.
    expect(fnBody).toMatch(/cancelReason: cleanReason/);
  });
});
