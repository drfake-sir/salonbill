import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Bill, Stylist } from "./db";
import { computeEarnings, IST_OFFSET, rangeDays, type Range } from "./earnings";
import { buildReport, istDateKey, parseIstDateKey } from "./reports";

/**
 * Owner report figures must be the bills themselves: the total is the sum of
 * the saved bills, cancelled and held bills never count, the payment split
 * adds back up to the total, per-stylist rows follow Earnings, and commission
 * never appears. Reports also stay owner-only.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 15, 8, 0) - IST_OFFSET; // 15 Oct 2026, 13:30 IST
const range: Range = rangeDays(NOW, NOW); // the IST day containing NOW

let seq = 0;
const bill = (over: Partial<Bill> & { total: number }): Bill => ({
  number: `SB-${String(++seq).padStart(4, "0")}`,
  createdAt: over.createdAt ?? NOW + 60_000,
  status: "paid",
  lines: [
    {
      key: "l1",
      kind: "service",
      refId: 1,
      name: "Haircut",
      price: 500,
      qty: 1,
      gstRate: 18,
      commissionPct: 10,
      stylistId: 1,
    },
  ],
  discountType: "flat",
  discountValue: 0,
  subtotal: over.total,
  discount: 0,
  cgst: 0,
  sgst: 0,
  tip: 0,
  payments: [{ mode: "Cash", amount: over.total }],
  ...over,
});

const stylists: Stylist[] = [
  { id: 1, name: "Asha", phone: "", commissionPct: 10, active: true },
  { id: 2, name: "Beenu", phone: "", commissionPct: 10, active: false },
];

const money = (n: number) => Math.round(n * 100) / 100;

describe("report totals are the saved bills", () => {
  it("equals the sum of the paid bills in range", () => {
    const bills = [
      bill({ total: 708 }),
      bill({ total: 354, payments: [{ mode: "UPI", amount: 354 }] }),
      bill({
        total: 1180,
        payments: [
          { mode: "Card", amount: 600 },
          { mode: "UPI", amount: 580 },
        ],
      }),
    ];
    const f = buildReport(bills, range, stylists, "Test");
    expect(f.bills).toBe(3);
    expect(f.sales).toBe(money(708 + 354 + 1180));
    expect(f.payments.reduce((a, p) => a + p.amount, 0)).toBe(f.sales);
    expect(f.payments.map((p) => p.mode)).toEqual(["Cash", "UPI", "Card"]);
  });

  it("excludes cancelled and held bills entirely", () => {
    const bills = [
      bill({ total: 708 }),
      bill({ total: 500, status: "cancelled" }),
      bill({ total: 300, status: "held" }),
    ];
    const f = buildReport(bills, range, stylists, "Test");
    expect(f.bills).toBe(1);
    expect(f.sales).toBe(708);
    expect(f.payments).toEqual([{ mode: "Cash", amount: 708 }]);
  });

  it("excludes bills from outside the range (IST day boundary)", () => {
    const bills = [
      bill({ total: 100, createdAt: range.start }),
      bill({ total: 999, createdAt: range.end }), // first instant of the NEXT day
      bill({ total: 50, createdAt: range.start - 1 }),
    ];
    const f = buildReport(bills, range, stylists, "Test");
    expect(f.bills).toBe(1);
    expect(f.sales).toBe(100);
  });

  it("carries no commission figure of any kind", () => {
    const f = buildReport([bill({ total: 708 })], range, stylists, "Test");
    expect(JSON.stringify(f)).not.toMatch(/commission/i);
    expect(Object.keys(f)).not.toContain("commission");
    expect(Object.keys(f.stylists[0]!)).toEqual(["id", "name", "sales", "services"]);
  });
});

describe("per-stylist rows follow Earnings", () => {
  it("matches computeEarnings for every stylist in range", () => {
    const bills = [bill({ total: 708 }), bill({ total: 600 })];
    // second bill: same service line, but attributed to stylist 2
    const second = bills[1];
    if (!second) throw new Error("test needs a second bill");
    const line = second.lines[0];
    if (!line) throw new Error("test bill needs a service line");
    bills[1] = { ...second, lines: [{ ...line, stylistId: 2, price: 600 }] };
    const f = buildReport(bills, range, stylists, "Test");
    for (const row of f.stylists) {
      const e = computeEarnings(bills, { id: row.id, name: row.name }, range);
      expect(row.sales).toBe(e.value);
      expect(row.services).toBe(e.services);
    }
    expect(f.stylists[0]).toEqual({ id: 1, name: "Asha", sales: 500, services: 1 });
    expect(f.stylists[1]).toEqual({ id: 2, name: "Beenu", sales: 600, services: 1 });
  });
});

describe("range labels and PDF filename keys are IST", () => {
  it("round-trips an IST day key", () => {
    expect(istDateKey(range.start)).toBe("2026-10-15");
    expect(parseIstDateKey("2026-10-15")).toBe(range.start);
    expect(parseIstDateKey("15-10-2026")).toBeNull();
  });

  it("takes fromKey/toKey from the first and last day of the range", () => {
    const f = buildReport([bill({ total: 10 })], range, stylists, "This month");
    expect(f.fromKey).toBe("2026-10-15");
    expect(f.toKey).toBe("2026-10-15");
    expect(f.label).toBe("This month");
  });

  it("a two-day range ends on its last IST day, not the exclusive end", () => {
    const twoDay = rangeDays(range.start, range.start + DAY);
    const f = buildReport([], twoDay, stylists, "Custom");
    expect(f.fromKey).toBe("2026-10-15");
    expect(f.toKey).toBe("2026-10-16");
  });
});

/* ------------------------------ owner only ------------------------------- */

describe("Reports is owner-only", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

  it("the route is wrapped in OwnerOnly", () => {
    const route = read("routes/reports.tsx");
    expect(route).toMatch(/component: \(\) => \(\s*<OwnerOnly>/);
  });

  it("staff never even see the Reports entry in the menu", () => {
    const shell = read("components/AppShell.tsx");
    expect(shell).toMatch(/to: "\/reports", label: "Reports".*ownerOnly: true/);
    expect(shell).toMatch(/\.filter\(\(n\) => !\("ownerOnly" in n\) \|\| owner\)/);
    expect(shell).toContain("useOwner");
  });

  it("the page itself never renders a commission amount", () => {
    const route = read("routes/reports.tsx");
    // Saying "commission is not shown" is fine; reading a commission figure is not.
    expect(route).not.toMatch(/commissionAmount|commissionPct|\.commission\b/);
    expect(route).not.toMatch(/mainFigure|computeEarnings/);
  });

  it("downloads the PDF under the required name and offers a share sheet", () => {
    const route = read("routes/reports.tsx");
    expect(route).toContain("reportPdfFilename(figures.fromKey, figures.toKey)");
    expect(route).toContain("shareReportPdf");
    const pdf = read("lib/pdf.ts");
    expect(pdf).toContain("SalonBill-Report-${from}-to-${to}.pdf");
    expect(pdf).toContain("format: [pageW, Math.max(pageH, imgH + margin * 2)]");
  });
});
