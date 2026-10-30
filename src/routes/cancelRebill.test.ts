/**
 * Cancel and rebill — the wiring between the Bills list and the Billing draft.
 *
 * The action is read from the source the same way the other route-wiring
 * tests here do it: rendering the whole route would need the router, Dexie
 * and a live session, and the contract under test is "which flow is called,
 * for whom, and where the contents land".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const billsSrc = readFileSync(join(__dirname, "bills.tsx"), "utf8");
const indexSrc = readFileSync(join(__dirname, "index.tsx"), "utf8");

describe("the Cancel and rebill button", () => {
  it("sits in the bill detail and is only rendered for the signed-in owner", () => {
    expect(billsSrc).toContain("Cancel and rebill");
    // The gate: owner session AND a still-paid bill. Staff never see it.
    expect(billsSrc).toMatch(/owner && b\.status === "paid" &&/);
    // It is a real button inside the expanded detail, not the row toolbar.
    expect(billsSrc).toMatch(
      /owner && b\.status === "paid" &&[\s\S]*?<button[\s\S]*?Cancel and rebill/,
    );
  });

  it("cannot act for a non-owner even if it were clicked", () => {
    const fn = billsSrc.slice(
      billsSrc.indexOf("const cancelAndRebill"),
      billsSrc.indexOf("return (", billsSrc.indexOf("const cancelAndRebill")),
    );
    expect(fn).toMatch(/if \(!owner\) \{[\s\S]*?return;/);
  });
});

describe("the rebill flow", () => {
  const fn = () =>
    billsSrc.slice(
      billsSrc.indexOf("const cancelAndRebill"),
      billsSrc.indexOf("return (", billsSrc.indexOf("const cancelAndRebill")),
    );

  it("uses the existing append-only cancel flow with owner + reason", () => {
    const f = fn();
    // Same call the plain Cancel button makes: stock restored once, the
    // original row kept and only stamped cancelled.
    expect(f).toContain("await cancelBill(b.id!, reason, session?.name)");
    expect(f).toMatch(
      /const reason = prompt\(`Reason for cancelling \$\{b\.number\}\?`\)\?\.trim\(\);/,
    );
    // Aborted prompt → return before anything happens.
    expect(f).toMatch(/if \(!reason\) return;/);
    // A non-paid bill never reaches cancelBill (a second cancel is refused).
    expect(f).toMatch(/b\.status !== "paid"/);
  });

  it("parks the contents only AFTER the cancel succeeded, then opens Billing", () => {
    const f = fn();
    const cancelAt = f.indexOf("await cancelBill(");
    const storeAt = f.indexOf("storeRebill(b)");
    const navAt = f.indexOf('navigate({ to: "/" })');
    expect(cancelAt).toBeGreaterThan(-1);
    expect(storeAt).toBeGreaterThan(cancelAt);
    expect(navAt).toBeGreaterThan(storeAt);
  });

  it("never edits the saved bill in place", () => {
    // The route only ever cancels (db.cancelBill, append-only — covered by
    // cancelReason.test.ts) and copies values out; no other write exists.
    expect(billsSrc).not.toContain("db.bills.update");
    expect(billsSrc).not.toContain("db.bills.delete");
    expect(billsSrc).not.toContain("db.bills.put");
  });

  it("refuses to overwrite an unfinished bill sitting on the Billing screen", () => {
    expect(fn()).toContain("await loadDraft(getTabId())");
    expect(fn()).toMatch(/if \(mine\?\.lines\.length\) \{[\s\S]*?return;/);
  });
});

describe("the new bill", () => {
  it("is a separate row with a new number: no id, no heldId, fresh numbering", () => {
    // The draft the Billing screen receives carries no id/number (see
    // rebill.test.ts) and is applied without a heldId, so Save goes through
    // the normal commitSale path — which is what issues the next number.
    expect(indexSrc).toContain("takeRebill()");
    expect(indexSrc).toMatch(/setHeldId\(undefined\);.*new row with a new number/s);
    expect(indexSrc).not.toMatch(/setHeldId\(rebill/);
    // The old bill's number is only mentioned in the confirmation toast.
    expect(indexSrc).toMatch(/rebill\.from/);
  });

  it("prefills lines, customer and payment mode, and drops the rest", () => {
    expect(indexSrc).toContain("setLines(rebill.lines)");
    expect(indexSrc).toContain("setMode(rebill.mode)");
    expect(indexSrc).toMatch(/phone: rebill\.customerPhone \?\? ""/);
    // Discount / tip / held state start clean — the owner re-enters them.
    expect(indexSrc).not.toContain("setDisc(rebill");
    expect(indexSrc).not.toContain("setTip(rebill");
  });

  it("is consumed once: the payload is removed as it is applied", () => {
    const lib = readFileSync(join(__dirname, "..", "lib", "rebill.ts"), "utf8");
    expect(lib).toMatch(/export function takeRebill[\s\S]*?removeItem\(REBILL_KEY\)/);
  });
});
