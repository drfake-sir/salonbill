import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guards for the mobile layout fixes.
 *
 * jsdom has no layout engine, so overflow/geometry itself is verified in the
 * live browser matrix (see the test report). These tests pin the exact source
 * changes so a refactor cannot silently drop them.
 */

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("bill sheet fits short viewports (360x640, landscape, keyboard-open)", () => {
  const src = read("routes/index.tsx");

  it("scrolls the mobile sheet body instead of overflowing past the viewport", () => {
    // The sheet's inner wrapper must scroll when panel content exceeds 85dvh.
    expect(src).toMatch(/flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain/);
  });

  it("keeps the Hold/Save/Print footer pinned inside the sheet", () => {
    expect(src).toMatch(/sticky bottom-0 z-10 shrink-0 space-y-3 border-t bg-card pt-4/);
  });

  it("never lets the line-items box collapse to zero height", () => {
    expect(src).toMatch(/-mx-1 min-h-24 flex-1 space-y-2 overflow-y-auto/);
    expect(src).not.toMatch(/-mx-1 min-h-0 flex-1 space-y-2 overflow-y-auto/);
  });
});

describe("touch targets are at least 44px", () => {
  const index = read("routes/index.tsx");
  const bills = read("routes/bills.tsx");
  const earnings = read("routes/earnings.tsx");
  const syncGate = read("components/SyncGate.tsx");

  it("billing: Clear button gets the 48px `tap` min-height", () => {
    expect(index).toMatch(
      /className="tap px-2 text-sm text-muted-foreground hover:text-destructive"/,
    );
  });

  it("billing: sheet close and customer-remove buttons are 44px (size-11)", () => {
    expect(index).toMatch(/aria-label="Close bill"/);
    expect(index).toContain("grid size-11 place-items-center rounded-xl text-muted-foreground");
    expect(index).toContain("grid size-11 shrink-0 place-items-center");
    expect(index).not.toContain(
      'aria-label="Close bill"\n              className="tap -mr-2 grid size-10',
    );
  });

  it("billing: discount %/₹ toggle is at least 44px wide (min-w-11)", () => {
    expect(index).toMatch(/h-11 min-w-11 shrink-0 rounded-r-xl bg-secondary/);
  });

  it("bills: month prev/next arrows are 44px (size-11)", () => {
    // The two interactive month buttons (not the decorative icon span) must
    // be 44x44.
    expect(bills).toMatch(
      /className="tap grid size-11 place-items-center rounded-xl bg-secondary"\s*aria-label="Previous month"/,
    );
    expect(bills).toMatch(
      /className="tap grid size-11 place-items-center rounded-xl bg-secondary disabled:opacity-40"\s*aria-label="Next month"/,
    );
    expect(bills).not.toMatch(/tap grid size-9 place-items-center/);
  });

  it("earnings: stylist comparison rows are at least 44px tall", () => {
    expect(earnings).toMatch(/grid min-h-11 w-full grid-cols-\[1fr_auto_auto_auto\]/);
  });

  it("sync sheet: close button is a 44px target", () => {
    expect(syncGate).toMatch(/aria-label="Close sync sheet"/);
    expect(syncGate).toMatch(/grid size-11 shrink-0 place-items-center rounded-full/);
  });
});

describe("held bill keeps its payment mode on resume", () => {
  const src = read("routes/index.tsx");

  it("resume() restores the held bill's payment mode", () => {
    expect(src).toMatch(/setMode\(b\.payments\[0\]\?\.mode \?\? "Cash"\)/);
  });

  it("phones can reach held/unsaved bills on an empty cart", () => {
    // The mobile entry pill must also render when there are no lines yet.
    expect(src).toMatch(/lines\.length === 0 && \(held\.length > 0 \|\| orphans\.length > 0\)/);
  });
});
