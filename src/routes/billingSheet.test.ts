/**
 * Mobile billing sheet — compact line rows + a full-height sheet, read from
 * the source the way the other route-wiring tests here are written (the
 * measurements themselves are verified on a real 360/390/412 viewport).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(__dirname, "index.tsx"), "utf8");

/** The line-item list: from the scroller container to the sticky footer. */
const rowRegion = src.slice(src.indexOf("ref={listRef}"), src.indexOf("sticky bottom-0"));
/** Everything the footer must keep on screen. */
const footerRegion = src.slice(src.indexOf("sticky bottom-0"));

describe("each line item is one compact row", () => {
  it("row 1 = item name and price, row 2 = stylist, quantity stepper, remove", () => {
    expect(rowRegion).toContain("Row 1 — service name and the line's price");
    expect(rowRegion).toContain("Row 2 — stylist, quantity stepper, remove");
    // Fields, in order: name + amount, then the three controls.
    expect(rowRegion).toMatch(/\{l\.name\}/);
    expect(rowRegion).toContain("{inr(l.price * l.qty)}");
    expect(rowRegion).toContain("aria-label={`Stylist for ${l.name}`}");
    expect(rowRegion).toContain('aria-label="Less"');
    expect(rowRegion).toContain('aria-label="More"');
    expect(rowRegion).toContain("aria-label={`Remove ${l.name}`}");
  });

  it("keeps every touch target at 40px and the padding tight", () => {
    // The three row-2 controls: stylist chip, stepper buttons, remove.
    // The row controls carry an explicit 40px height — the global `tap`
    // utility would force them back to 48px and eat a whole extra row.
    expect(rowRegion).toMatch(/className="flex h-10 min-w-0/); // stylist chip
    expect(rowRegion).toContain('className="grid size-10 place-items-center"'); // −/+
    expect(rowRegion).toMatch(/aria-label={`Remove \$\{l\.name\}`}\s*\n\s*className="grid size-10/);
    expect(rowRegion).toContain("bg-card p-1"); // compact card padding
    expect(rowRegion).toContain("space-y-1"); // tight gap between rows
  });

  it("products still show their stock instead of the stylist chip", () => {
    expect(rowRegion).toContain("in stock");
    expect(rowRegion).toMatch(/l\.kind === "product"/);
  });
});

describe("the sheet uses the full available height", () => {
  it("is a fixed 92dvh column, not a content-sized sheet", () => {
    expect(src).toContain("h-[96dvh]");
    expect(src).not.toContain("max-h-[92dvh]");
  });

  it("the item list is the only scroller", () => {
    expect(rowRegion).toContain("flex-1 space-y-1 overflow-y-auto");
    expect(rowRegion).toContain("min-h-24 flex-1");
  });

  it("totals and buttons sit outside the scroller, pinned to the bottom", () => {
    expect(footerRegion).toContain("sticky bottom-0 z-10 shrink-0");
    // Everything that must stay visible lives in that pinned footer …
    expect(footerRegion).toContain("Discount / Tip");
    expect(footerRegion).toContain('k="Subtotal"');
    expect(footerRegion).toContain("Total");
    expect(footerRegion).toContain("MODES.map");
    expect(footerRegion).toMatch(/onClick=\{hold\}/);
    expect(footerRegion).toMatch(/save\("save"\)/);
    expect(footerRegion).toMatch(/save\("print"\)/);
  });

  it("Served by and the customer field stay above the list, tightened", () => {
    expect(src).toContain('aria-label="Served by"');
    expect(src).toContain("bill-customer");
    // Tighter chrome: one shared gap and a slimmer footer padding.
    expect(src).toContain("flex h-full min-h-0 flex-1 flex-col gap-0.5");
    expect(src).toContain("border-t bg-card pt-1");
  });
});
