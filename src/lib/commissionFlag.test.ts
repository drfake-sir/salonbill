import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { commissionVisible, computeEarnings, mainFigure, type Earnings } from "@/lib/earnings";
import type { Bill, BillLine } from "@/lib/db";

/**
 * Regression guards for the owner-only "Show commission in Earnings" switch.
 *
 * jsdom has no layout engine, so the geometry lives in the browser matrix;
 * these tests pin the rules that must never silently regress:
 *  - the switch defaults to ON (including every settings row saved before it
 *    existed), is owner-only and syncs with the other settings,
 *  - OFF changes ONLY what is displayed — sales total + service count become
 *    the main figures and no commission amount/percent is rendered,
 *  - the numbers themselves are untouched: commission is still snapshotted on
 *    every bill line at save time and computeEarnings still reads it.
 */

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const settingsSrc = read("routes/settings.tsx");
const earningsSrc = read("routes/earnings.tsx");
const earningsLibSrc = read("lib/earnings.ts");
const catalogSrc = read("routes/catalog.tsx");
const indexSrc = read("routes/index.tsx");
const dbSrc = read("lib/db.ts");

/* ------------------------------- fixtures -------------------------------- */

const line = (p: Partial<BillLine> = {}): BillLine => ({
  key: "k1",
  kind: "service",
  refId: 1,
  name: "Men's Haircut",
  price: 300,
  qty: 1,
  gstRate: 18,
  commissionPct: 10,
  commissionAmount: 30,
  stylistId: 1,
  stylistName: "Karthik",
  ...p,
});

const bill = (p: Partial<Bill> = {}): Bill => ({
  id: 1,
  number: "SB-0001",
  createdAt: Date.UTC(2026, 3, 15, 6, 30),
  status: "paid",
  lines: [line()],
  discountType: "flat",
  discountValue: 0,
  subtotal: 300,
  discount: 0,
  cgst: 0,
  sgst: 0,
  tip: 0,
  total: 300,
  payments: [{ mode: "Cash", amount: 300 }],
  ...p,
});

const ALL = { start: Date.UTC(2026, 0, 1), end: Date.UTC(2028, 0, 1) };
const karthik = { id: 1, name: "Karthik" };

/* --------------------------------- flag ---------------------------------- */

describe('"Show commission in Earnings" defaults to ON', () => {
  it("reads ON whenever the settings row does not carry the key", () => {
    // This is both the fresh-install default and every pre-existing install.
    expect(commissionVisible(undefined)).toBe(true);
    expect(commissionVisible(null)).toBe(true);
    expect(commissionVisible({})).toBe(true);
    expect(commissionVisible({ showCommission: true })).toBe(true);
    expect(commissionVisible({ showCommission: false })).toBe(false);
  });

  it("is seeded ON and is a plain settings field (so it syncs like the rest)", () => {
    expect(dbSrc).toMatch(/showCommission: true,/);
    expect(dbSrc).toMatch(/showCommission\?: boolean \| undefined;/);
    // The settings row is written through the one shared updater + Dexie hook
    // that already pushes settings to every device.
    expect(settingsSrc).toMatch(
      /const set = \(p: Partial<Settings>\) => db\.settings\.update\(1, p\)/,
    );
  });

  it("is an owner-only toggle on the Settings screen", () => {
    expect(settingsSrc).toContain(
      'toggle("Show commission in Earnings", "showCommission", s.showCommission !== false)',
    );
    // Settings is behind the owner PIN gate — staff never reach this switch.
    expect(settingsSrc).toMatch(/component: \(\) => \(\s*<OwnerOnly>/);
    // Clicking must flip the RESOLVED value, so an absent key turns OFF
    // (not ON, which is what `!s[key]` would have written for undefined).
    expect(settingsSrc).toMatch(/onClick=\{\(\) => set\(\{ \[key\]: !on \}\)\}/);
  });
});

/* ------------------------------ main figures ------------------------------ */

describe("main figure follows the switch", () => {
  const e = computeEarnings([bill()], karthik, ALL);

  it("ON leads with commission — today's view, unchanged", () => {
    expect(mainFigure(e, true)).toEqual({ amount: 30, label: "commission earned" });
  });

  it("OFF leads with the sales total and never names commission", () => {
    expect(mainFigure(e, false)).toEqual({ amount: 300, label: "service value" });
  });

  it("the switch changes no number: same bill, same computed totals", () => {
    expect(e.services).toBe(1);
    expect(e.value).toBe(300);
    expect(e.commission).toBe(30); // still snapshotted on the line
    // Presentation helper only reads the values, it never recomputes them.
    expect(mainFigure(e, false).amount).toBe(e.value);
    expect(mainFigure(e, true).amount).toBe(e.commission);
  });

  it("commission is still snapshotted on every line when the bill is saved", () => {
    expect(indexSrc).toContain(
      "commissionAmount: Math.round(l.price * l.qty * l.commissionPct) / 100",
    );
    // …and the reader still prefers the stored snapshot over any live rate.
    expect(earningsLibSrc).toContain('typeof l.commissionAmount === "number"');
  });
});

/* -------------------------------- display -------------------------------- */

describe("Earnings hides commission when the switch is OFF", () => {
  it("period cards (today/week/month/year) lead with the switch's figure", () => {
    expect(earningsSrc).toContain("{inr(mainFigure(c.e, showCommission).amount)}");
    // …and the sales total stays visible underneath as the service count line.
    expect(earningsSrc).toMatch(/\{c\.e\.services\} services\{showCommission \? ` · /);
  });

  it("the range summary (custom range included) leads with the switch's figure", () => {
    expect(earningsSrc).toContain("{inr(mainFigure(active, showCommission).amount)}");
    expect(earningsSrc).toContain("{mainFigure(active, showCommission).label}");
  });

  it("every commission amount on screen is behind the flag", () => {
    // summary "commission not recorded" note, comparison column, daily total,
    // and the per-line amount + percent in the expanded breakdown.
    expect(earningsSrc).toMatch(/\{showCommission && active\.unrecorded > 0 &&/);
    expect(earningsSrc).toMatch(
      /\{showCommission &&\s*<span className="w-16 text-right">Comm\.<\/span>\}/,
    );
    expect(earningsSrc).toMatch(/\{showCommission && \(\s*<span className="block font-extrabold/);
    expect(earningsSrc).toMatch(/\{showCommission &&\s*\(l\.commission === null \?/);
    expect((earningsSrc.match(/showCommission &&/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("stylists still only ever see their own numbers", () => {
    expect(earningsSrc).toMatch(/forced=\{\{ id: session\.staffId, name: session\.name \}\}/);
    expect(earningsSrc).toMatch(/if \(forced\) return forced; \/\/ staff: always only themselves/);
  });
});

describe("the stylist editor hides the commission % field when OFF", () => {
  it("row editor: the box only renders while the switch is on", () => {
    expect(catalogSrc).toMatch(/\{showCommission \? \(\s*<Field label="Commission %">/);
    // …and an empty cell keeps the title row's track so nothing shifts.
    expect(catalogSrc).toMatch(/\) : \(\s*<span className="hidden lg:block" \/>\s*\)/);
    expect(catalogSrc).toContain(
      "{showCommission ? <span className={headCell}>Commission %</span> : <span />}",
    );
  });

  it("add form: the box is gone too, but the 10% default still applies", () => {
    expect(catalogSrc).toMatch(/\{showCommission && \(\s*<Field label="Commission %" always>/);
    expect(catalogSrc).toMatch(/const \[commission, setCommission\] = useState\("10"\)/);
    expect(catalogSrc).toMatch(/commissionPct: Math\.min\(100, numVal\(commission\)!\)/);
  });
});
