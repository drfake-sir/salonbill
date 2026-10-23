import { describe, expect, it } from "vitest";

import {
  IST_OFFSET,
  computeEarnings,
  earningsToCsv,
  flatLines,
  istDayStart,
  istWeekday,
  rangeDays,
  rangeLastWeek,
  rangeThisMonth,
  rangeThisWeek,
  rangeThisYear,
  rangeYesterday,
  type Range,
} from "@/lib/earnings";
import type { Bill, BillLine } from "@/lib/db";

/* ------------------------------- fixtures -------------------------------- */

let seq = 0;

const line = (p: Partial<BillLine> = {}): BillLine => ({
  key: `k${++seq}`,
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
  id: ++seq,
  number: `SB-${String(seq).padStart(4, "0")}`,
  // 2026-04-15 12:00 IST (= 06:30 UTC) — a Wednesday.
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

const karthik = { id: 1, name: "Karthik" };
const priya = { id: 2, name: "Priya" };

/** A wide range covering all fixture timestamps. */
const ALL: Range = { start: Date.UTC(2026, 0, 1), end: Date.UTC(2028, 0, 1) };
const r2 = (n: number) => Math.round(n * 100) / 100;

/* --------------------------------- ranges -------------------------------- */

describe("IST ranges", () => {
  it("IST day start floors to IST midnight regardless of host TZ", () => {
    // 2026-04-14 18:29:59.999 UTC = 2026-04-14 23:59:59 IST (same day);
    // one millisecond later is already 2026-04-15 00:00 IST.
    const before = Date.UTC(2026, 3, 14, 18, 29, 59, 999);
    const after = Date.UTC(2026, 3, 14, 18, 30);
    // 14 Apr 00:00 IST === 13 Apr 18:30 UTC.
    expect(istDayStart(before)).toBe(Date.UTC(2026, 3, 13, 18, 30));
    expect(istDayStart(after)).toBe(Date.UTC(2026, 3, 14, 18, 30));
    expect(istDayStart(after) - istDayStart(before)).toBe(86_400_000);
  });

  it("week starts Monday in IST", () => {
    // 2026-04-13 is a Monday; IST Monday noon = 07:00 UTC.
    expect(istWeekday(Date.UTC(2026, 3, 13, 7, 0))).toBe(0);
    // Sunday 23:59 IST is the last day of that same week.
    expect(istWeekday(Date.UTC(2026, 3, 19, 18, 29))).toBe(6);
  });

  it("this week runs Monday→Sunday (Sunday belongs to the week that started Monday)", () => {
    // now = Sunday 2026-04-19 21:00 IST (15:30 UTC).
    const sundayNight = Date.UTC(2026, 3, 19, 15, 30);
    const w = rangeThisWeek(sundayNight);
    expect(w.start).toBe(Date.UTC(2026, 3, 12, 18, 30)); // Mon 00:00 IST
    expect(w.end).toBe(Date.UTC(2026, 3, 19, 18, 30)); // next Mon 00:00 IST
    // Past midnight IST (Mon 00:30) this bill is in the NEXT week:
    expect(sundayNight + 3.5 * 3600_000).toBeGreaterThanOrEqual(w.end);
  });

  it("last week is the previous Monday→Sunday", () => {
    const now = Date.UTC(2026, 3, 15, 6, 30); // Wed
    const w = rangeLastWeek(now);
    expect(w.end).toBe(rangeThisWeek(now).start);
    expect(w.end - w.start).toBe(7 * 86_400_000);
  });

  it("month and year boundaries cut exactly at IST midnight", () => {
    const apr5 = Date.UTC(2026, 3, 5, 6, 30); // 2026-04-05 12:00 IST
    const m = rangeThisMonth(apr5);
    expect(m.start).toBe(Date.UTC(2026, 2, 31, 18, 30)); // 1 Apr 00:00 IST
    expect(m.end).toBe(Date.UTC(2026, 3, 30, 18, 30)); // 1 May 00:00 IST

    const y2026 = rangeThisYear(Date.UTC(2026, 11, 31, 12, 0)); // 31 Dec 2026 IST noon
    expect(y2026.start).toBe(Date.UTC(2025, 11, 31, 18, 30)); // 1 Jan 2026 IST
    expect(y2026.end).toBe(Date.UTC(2026, 11, 31, 18, 30)); // 1 Jan 2027 IST

    // 31 Dec 23:59:59 IST is still this year; 1 Jan 00:00 IST is next year.
    const lateDec = Date.UTC(2026, 11, 31, 18, 29, 59);
    const newYears = Date.UTC(2026, 11, 31, 18, 30);
    expect(lateDec).toBeGreaterThanOrEqual(y2026.start);
    expect(lateDec).toBeLessThan(y2026.end);
    expect(newYears).toBeGreaterThanOrEqual(rangeThisYear(newYears).start);
  });

  it("custom range includes both boundary IST days", () => {
    // From 15 Apr 00:00 IST to 16 Apr 23:59 IST — both days fully included.
    const r = rangeDays(Date.UTC(2026, 3, 14, 18, 30), Date.UTC(2026, 3, 16, 18, 29));
    expect(r.start).toBe(Date.UTC(2026, 3, 14, 18, 30)); // 15 Apr 00:00 IST
    expect(r.end).toBe(Date.UTC(2026, 3, 16, 18, 30)); // 17 Apr 00:00 IST
    // First instant of the last included day is inside:
    expect(Date.UTC(2026, 3, 15, 18, 30)).toBeLessThan(r.end);
  });

  it("yesterday is the single IST day before today", () => {
    const now = Date.UTC(2026, 3, 15, 6, 30); // 15 Apr 12:00 IST
    const y = rangeYesterday(now);
    expect(y.end - y.start).toBe(86_400_000);
    expect(y.end).toBe(istDayStart(now));
  });
});

/* ------------------------------ attribution ------------------------------ */

describe("computeEarnings", () => {
  it("attributes each line to its own stylist in a multi-stylist bill", () => {
    const b = bill({
      lines: [
        line({
          stylistId: 1,
          stylistName: "Karthik",
          name: "Men's Haircut",
          price: 300,
          commissionAmount: 30,
        }),
        line({
          stylistId: 2,
          stylistName: "Priya",
          name: "Global Hair Colour",
          price: 2500,
          commissionPct: 12,
          commissionAmount: 300,
        }),
      ],
    });
    const k = computeEarnings([b], karthik, ALL);
    const p = computeEarnings([b], priya, ALL);
    expect(k.services).toBe(1);
    expect(k.value).toBe(300);
    expect(k.commission).toBe(30);
    expect(p.services).toBe(1);
    expect(p.value).toBe(2500);
    expect(p.commission).toBe(300);
  });

  it("excludes cancelled bills — earnings drop when a bill is cancelled later", () => {
    const b = bill();
    expect(computeEarnings([b], karthik, ALL).commission).toBe(30);
    const cancelled = { ...b, status: "cancelled" as const };
    expect(computeEarnings([cancelled], karthik, ALL)).toMatchObject({
      services: 0,
      value: 0,
      commission: 0,
      days: [],
    });
  });

  it("excludes held bills", () => {
    const held = bill({ status: "held" });
    expect(computeEarnings([held], karthik, ALL).services).toBe(0);
  });

  it("splits the tip by service value across stylists", () => {
    const b = bill({
      tip: 100,
      lines: [
        line({ stylistId: 1, price: 300, commissionAmount: 30 }),
        line({
          stylistId: 2,
          stylistName: "Priya",
          price: 2700,
          commissionPct: 10,
          commissionAmount: 270,
        }),
      ],
    });
    expect(computeEarnings([b], karthik, ALL).tip).toBe(10); // 100 × 300/3000
    expect(computeEarnings([b], priya, ALL).tip).toBe(90);
  });

  it("buckets by IST day: 23:59:59 IST counts, 00:00 IST next day moves", () => {
    const lateNight = bill({ createdAt: Date.UTC(2026, 3, 14, 18, 29, 59) }); // 14 Apr 23:59:59 IST
    const midnight = bill({ createdAt: Date.UTC(2026, 3, 14, 18, 30) }); // 15 Apr 00:00 IST
    const day15 = rangeYesterday(Date.UTC(2026, 3, 15, 6, 30) + 86_400_000); // 15 Apr IST
    expect(day15.start).toBe(Date.UTC(2026, 3, 14, 18, 30));

    const e = computeEarnings([lateNight, midnight], karthik, ALL);
    expect(e.days).toHaveLength(2);
    expect(e.days[0]!.day).toBe(istDayStart(lateNight.createdAt));
    expect(e.days[1]!.day).toBe(istDayStart(midnight.createdAt));

    const only15 = computeEarnings([lateNight, midnight], karthik, day15);
    expect(only15.services).toBe(1);
    expect(only15.days[0]!.day).toBe(Date.UTC(2026, 3, 14, 18, 30));
  });

  it("month boundary: 31 Mar 23:59 IST vs 1 Apr 00:00 IST", () => {
    const mar31 = bill({ createdAt: Date.UTC(2026, 2, 31, 18, 29, 59) });
    const apr1 = bill({ createdAt: Date.UTC(2026, 2, 31, 18, 30) });
    const april = rangeThisMonth(Date.UTC(2026, 3, 15, 6, 30));
    expect(computeEarnings([mar31, apr1], karthik, april).services).toBe(1);
  });

  it("year boundary: 31 Dec 23:59 IST vs 1 Jan 00:00 IST", () => {
    const nyEve = bill({ createdAt: Date.UTC(2026, 11, 31, 18, 29, 59) });
    const nyDay = bill({ createdAt: Date.UTC(2026, 11, 31, 18, 30) });
    const y2026 = rangeThisYear(Date.UTC(2026, 11, 31, 12, 0));
    expect(computeEarnings([nyEve, nyDay], karthik, y2026).services).toBe(1);
    const y2027 = rangeThisYear(Date.UTC(2027, 0, 5, 6, 30));
    expect(computeEarnings([nyEve, nyDay], karthik, y2027).services).toBe(1);
  });

  it("handles bills from before commission tracking: derive from pct, flag when missing", () => {
    const withPctOnly = bill({ lines: [line({ commissionAmount: undefined, commissionPct: 10 })] });
    const legacy = bill({
      lines: [line({ commissionAmount: undefined, commissionPct: undefined as unknown as number })],
    });

    const derived = computeEarnings([withPctOnly], karthik, ALL);
    expect(derived.commission).toBe(30); // 300 × 10% from the snapshotted pct
    expect(derived.unrecorded).toBe(0);

    const old = computeEarnings([legacy], karthik, ALL);
    expect(old.services).toBe(1); // still counted
    expect(old.value).toBe(300);
    expect(old.commission).toBe(0); // not guessed
    expect(old.unrecorded).toBe(1);
  });

  it("totals always equal the sum of the attributed bill lines", () => {
    const bills = [
      bill(),
      bill({
        tip: 50,
        lines: [
          line({ stylistId: 1, price: 1200, qty: 2, commissionAmount: 240 }),
          line({
            stylistId: 2,
            stylistName: "Priya",
            price: 900,
            commissionPct: 12,
            commissionAmount: 108,
          }),
        ],
      }),
      bill({ createdAt: Date.UTC(2026, 3, 16, 6, 30) }),
      bill({ status: "cancelled" }),
      bill({ status: "held" }),
    ];
    const e = computeEarnings(bills, karthik, ALL);
    const rows = flatLines(e);
    expect(rows).toHaveLength(e.services);
    expect(e.value).toBe(r2(rows.reduce((a, l) => a + l.amount, 0)));
    expect(e.commission).toBe(r2(rows.reduce((a, l) => a + (l.commission ?? 0), 0)));
    expect(e.tip).toBe(r2(rows.reduce((a, l) => a + l.tip, 0)));
    // Per-day subtotals agree with the grand total.
    for (const d of e.days) {
      expect(d.value).toBe(r2(d.lines.reduce((a, l) => a + l.amount, 0)));
    }
    expect(e.value).toBe(r2(e.days.reduce((a, d) => a + d.value, 0)));
  });

  it("owner 'all stylists' view (null) counts every service line once", () => {
    const b = bill({
      lines: [
        line({ stylistId: 1, price: 300, commissionAmount: 30 }),
        line({
          stylistId: 2,
          stylistName: "Priya",
          price: 2500,
          commissionPct: 12,
          commissionAmount: 300,
        }),
      ],
    });
    const all = computeEarnings([b], null, ALL);
    expect(all.services).toBe(2);
    expect(all.value).toBe(2800);
    expect(all.commission).toBe(330);
    // and it equals the sum of the two per-stylist views
    const k = computeEarnings([b], karthik, ALL);
    const p = computeEarnings([b], priya, ALL);
    expect(all.value).toBe(r2(k.value + p.value));
    expect(all.commission).toBe(r2(k.commission + p.commission));
  });

  it("matches a stylist by name when old lines carry no stylistId", () => {
    const legacy = bill({ lines: [line({ stylistId: undefined, stylistName: "Karthik" })] });
    expect(computeEarnings([legacy], karthik, ALL).services).toBe(1);
  });
});

/* ---------------------------------- CSV ---------------------------------- */

describe("earningsToCsv", () => {
  it("emits one row per line with headers and not-recorded markers", () => {
    const b = bill({
      customerName: "Syed",
      lines: [
        line({ commissionAmount: 30, commissionPct: 10 }),
        line({
          commissionAmount: undefined,
          commissionPct: undefined as unknown as number,
          name: "Old Service",
        }),
      ],
    });
    const rows = flatLines(computeEarnings([b], karthik, ALL));
    const csv = earningsToCsv(rows);
    const [head, ...body] = csv
      .replace(/^\uFEFF/, "")
      .split("\r\n")
      .filter((l) => l !== "");
    expect(head).toContain("Commission %");
    expect(head).toContain("Commission amount");
    expect(head).toContain("Stylist");
    expect(head).toContain("Cashier");
    expect(head).toContain("Device");
    expect(head).toContain("Status");
    expect(body).toHaveLength(2);
    // Newest first: the legacy line leads and carries the not-recorded marker.
    expect(body[0]).toContain("Karthik");
    expect(body[0]).toContain("not recorded");
    expect(body[0]).toContain("Old Service");
    expect(body[1]).toContain("Syed");
  });
});
