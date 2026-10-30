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
    expect(src).toMatch(/sticky bottom-0 z-10 shrink-0 space-y-1 border-t bg-card pt-1/);
  });

  it("footer spacing leaves room for 3 full service lines at 390×844", () => {
    // Tight gaps keep the sticky footer ≤ ~265px so three 90px line cards fit
    // above it (measured in the live browser matrix).
    expect(src).not.toMatch(/sticky bottom-0 z-10 shrink-0 space-y-3/);
  });

  it("never lets the line-items box collapse to zero height", () => {
    expect(src).toMatch(/-mx-1 min-h-24 flex-1 space-y-1 overflow-y-auto/);
    expect(src).not.toMatch(/-mx-1 min-h-0 flex-1 space-y-2 overflow-y-auto/);
  });
});

describe("touch targets are at least 40px", () => {
  const index = read("routes/index.tsx");
  const bills = read("routes/bills.tsx");
  const earnings = read("routes/earnings.tsx");
  const syncGate = read("components/SyncGate.tsx");

  it("billing: Clear button is a 40px target (compact header, no 48px tap floor)", () => {
    // The compact mobile sheet needs the header row ≤ 40px, so this button
    // carries its height explicitly instead of the global `tap` min-height.
    expect(index).toMatch(
      /className="px-2 py-2\.5 text-sm text-muted-foreground hover:text-destructive"/,
    );
  });

  it("billing: sheet close is 40px (size-10), customer-remove stays 44px", () => {
    expect(index).toMatch(/aria-label="Close bill"/);
    expect(index).toContain("grid size-10 place-items-center rounded-xl text-muted-foreground");
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
      /className="tap grid size-11 shrink-0 place-items-center rounded-xl bg-secondary"\s*aria-label="Previous month"/,
    );
    expect(bills).toMatch(
      /className="tap grid size-11 shrink-0 place-items-center rounded-xl bg-secondary disabled:opacity-40"\s*aria-label="Next month"/,
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

describe("sync status line is part of the layout — it can never cover a control", () => {
  const gate = read("components/SyncGate.tsx");
  const shell = read("components/AppShell.tsx");

  it("AppShell renders the pill in normal flow, above <main>", () => {
    const at = shell.indexOf("<SyncPill />");
    expect(at).toBeGreaterThan(-1);
    // Before <main> in the DOM and inside the page div — not in a fixed layer.
    expect(at).toBeLessThan(shell.indexOf("<main"));
    expect(shell).not.toMatch(/<div[^>]*\b(fixed|absolute)\b[^>]*>\s*<SyncPill/);
  });

  it("the status-line button itself uses static flow positioning only", () => {
    const at = gate.indexOf('data-testid="sync-status-line"');
    expect(at).toBeGreaterThan(-1);
    const win = gate.slice(at, at + 500);
    const cls = /className="([^"]*)"/.exec(win)?.[1] ?? "";
    expect(cls).toContain("w-full"); // full-width in-flow bar
    expect(cls).toContain("border-b"); // visually a header line
    // A fixed/absolute/sticky pill is exactly the bug this rule forbids.
    expect(cls).not.toMatch(/\b(fixed|absolute|sticky)\b/);
  });

  it("the SyncPill component body contains no floating positioning at all", () => {
    const start = gate.indexOf("export function SyncPill");
    const end = gate.indexOf("export function DataWarnings");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = gate.slice(start, end);
    expect(body).not.toMatch(/className="[^"]*\b(fixed|absolute)\b/);
    expect(body).not.toMatch(/position:\s*(fixed|absolute)/);
  });

  it("phones show the short text; details open on tap", () => {
    const start = gate.indexOf("export function SyncPill");
    const end = gate.indexOf("export function DataWarnings");
    const body = gate.slice(start, end);
    // Short form hides on md+, full line with last-sync time only shows there.
    expect(body).toMatch(/truncate md:hidden/);
    expect(body).toMatch(/hidden truncate md:inline/);
    // Tap opens the details sheet.
    expect(body).toMatch(/onClick=\{\(\) => setOpen\(true\)\}/);
    expect(body).toMatch(/Cloud sync — tap for details/);
  });

  it("offline / not-connected states stay clearly visible", () => {
    const start = gate.indexOf("export function SyncPill");
    const end = gate.indexOf("export function DataWarnings");
    const body = gate.slice(start, end);
    // Non-online states get the destructive colour + explicit text.
    expect(body).toMatch(/text-destructive/);
    expect(body).toContain('"Offline"');
    expect(body).toContain('"Not connected"');
    expect(body).toMatch(/Offline · \$\{waiting} waiting/);
    // The stale-queue warning strip is still rendered in the page flow too.
    expect(gate).toMatch(/unsynced changes sitting on this device/);
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
