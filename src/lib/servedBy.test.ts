import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { BillLine } from "./db";
import {
  applyServedBy,
  isCustomStylist,
  markStylistPick,
  missingStylistMessage,
  stylistForNewLine,
} from "./servedBy";

const line = (key: string, extra: Partial<BillLine> = {}): BillLine => ({
  key,
  kind: "service",
  refId: 1,
  name: "Men's Haircut",
  price: 200,
  qty: 1,
  gstRate: 0,
  commissionPct: 10,
  stylistId: undefined,
  ...extra,
});

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("one chip sets all lines", () => {
  it("applies the chip to every service line at once", () => {
    const lines = [line("a"), line("b"), line("c")];
    const next = applyServedBy(lines, new Set(), 7);
    expect(next.map((l) => l.stylistId)).toEqual([7, 7, 7]);
    // Inputs are untouched — pure function.
    expect(lines.map((l) => l.stylistId)).toEqual([undefined, undefined, undefined]);
  });

  it("leaves product lines alone (they carry no stylist)", () => {
    const lines = [line("a"), line("p", { kind: "product", name: "Shampoo" })];
    const next = applyServedBy(lines, new Set(), 7);
    expect(next[0]?.stylistId).toBe(7);
    expect(next[1]?.stylistId).toBeUndefined();
  });

  it("only changes stylistId — no stored field is added or removed", () => {
    const lines = [line("a")];
    const [next] = applyServedBy(lines, new Set(), 7);
    expect(Object.keys(next!).sort()).toEqual(Object.keys(lines[0]!).sort());
  });
});

describe("custom override survives", () => {
  it("an individually-chosen line keeps its stylist across chip taps", () => {
    const lines = [line("a"), line("b")];
    // Chip 1 → both lines; line b then re-picked individually to stylist 3
    // (this is exactly what the UI does: upd() + markStylistPick()).
    const afterChip = applyServedBy(lines, new Set(), 1);
    const custom = markStylistPick(new Set(), "b", 3, 1);
    const afterPick = afterChip.map((l) => (l.key === "b" ? { ...l, stylistId: 3 } : l));
    const afterChip2 = applyServedBy(afterPick, custom, 2);
    expect(afterChip2.find((l) => l.key === "a")?.stylistId).toBe(2); // follows the chip
    expect(afterChip2.find((l) => l.key === "b")?.stylistId).toBe(3); // keeps its own choice
    expect(isCustomStylist(custom, "b", 2)).toBe(true);
    expect(isCustomStylist(custom, "a", 2)).toBe(false);
  });

  it("picking the chip's own stylist clears the custom mark again", () => {
    const custom = markStylistPick(new Set(), "b", 3, 1);
    expect(custom.has("b")).toBe(true);
    const backToChip = markStylistPick(custom, "b", 1, 1);
    expect(backToChip.has("b")).toBe(false);
  });

  it("without an active chip every pick is just a normal per-line choice", () => {
    const custom = markStylistPick(new Set(), "b", 3, null);
    // Marked so a later chip cannot clobber it…
    expect(custom.has("b")).toBe(true);
    // …but no "custom" badge shows while no chip is chosen.
    expect(isCustomStylist(custom, "b", null)).toBe(false);
  });
});

describe("later added lines follow the chip", () => {
  it("new lines default to the chip, falling back to the session default", () => {
    expect(stylistForNewLine(5, undefined)).toBe(5); // chip wins
    expect(stylistForNewLine(5, 2)).toBe(5); // chip wins over signed-in stylist
    expect(stylistForNewLine(null, 2)).toBe(2); // signed-in stylist keeps working
    expect(stylistForNewLine(null, undefined)).toBeUndefined(); // owner → still blocked
  });
});

describe("save is blocked without a choice, with a message pointing at Served by", () => {
  it("the message names the chip row", () => {
    expect(missingStylistMessage(1, "Men's Haircut")).toContain("Served by");
    expect(missingStylistMessage(1, "Men's Haircut")).toContain("Men's Haircut");
    expect(missingStylistMessage(3)).toContain("3 services");
    expect(missingStylistMessage(3)).toContain("Served by");
  });

  it("billing still blocks on unattributed lines and uses that message", () => {
    const src = read("routes/index.tsx");
    expect(src).toMatch(/unattributedServiceLines\(lines\)/);
    expect(src).toMatch(/toast\.error\(missingStylistMessage\(/);
  });
});

describe("reset after save/clear and wiring", () => {
  it("reset() clears the chip and the custom marks", () => {
    const src = read("routes/index.tsx");
    const resetAt = src.indexOf("const reset = ()");
    expect(resetAt).toBeGreaterThan(-1);
    const body = src.slice(resetAt, resetAt + 700);
    expect(body).toMatch(/setServedBy\(null\)/);
    expect(body).toMatch(/setCustomStylists\(new Set/);
  });

  it("chips drive new lines and per-line picks mark them custom", () => {
    const src = read("routes/index.tsx");
    expect(src).toMatch(/stylistForNewLine\(servedBy, defaultStylistId\)/);
    expect(src).toMatch(/markStylistPick\(c, l\.key, id, servedBy\)/);
    expect(src).toMatch(/applyServedBy\(ls, customStylists, id\)/);
    expect(src).toMatch(/isCustomStylist\(customStylists, l\.key, servedBy\)/);
  });

  it("stored format is unchanged: per-line stylist only, cashier separate", () => {
    // The chip state never reaches build() — only line.stylistId/stylistName do.
    const src = read("routes/index.tsx");
    expect(src).not.toMatch(/servedBy:/);
    expect(src).not.toMatch(/customStylists:/);
    expect(src).toMatch(/cashierId: session\?\.staffId/);
    expect(src).toMatch(/stylistName: stylistNameFor\(stylists, l\)/);
  });

  it("earnings and export read the same unchanged line fields", () => {
    const earnings = read("lib/earnings.ts");
    const exp = read("lib/export.ts");
    expect(earnings).toMatch(/stylistId/);
    expect(exp).toMatch(/stylistId|stylistName/);
    // Neither knows anything about the chip state.
    expect(earnings).not.toContain("servedBy");
    expect(exp).not.toContain("servedBy");
  });
});
