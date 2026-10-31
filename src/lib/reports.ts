/*
 * Owner reports — pure figures, no rendering, no side effects.
 *
 * Ranges and attribution are borrowed from Earnings on purpose: same IST
 * windows (computeRange / Range from lib/earnings) and the same
 * "is this line this stylist's service line" helper, so a report can never
 * disagree with what Earnings shows. Cancelled and held bills are dropped up
 * front exactly as Earnings drops them.
 *
 * Commission is deliberately absent from this module: a report shows what was
 * billed and what each stylist sold, never what anyone is owed.
 */
import { computeEarnings, IST_OFFSET, type Range } from "./earnings";
import type { Bill, Stylist } from "./db";

export type ReportPayment = { mode: string; amount: number };

export type ReportStylistRow = {
  id: number;
  name: string;
  /** Pre-tax value of this stylist's services in range (the Earnings basis). */
  sales: number;
  /** Number of service lines done. */
  services: number;
};

export type ReportFigures = {
  range: Range;
  /** Human range label shown on screen and printed in the PDF header. */
  label: string;
  /** YYYY-MM-DD in IST for the first and last day of the range (PDF filename). */
  fromKey: string;
  toKey: string;
  bills: number;
  /** Σ bill.total — what the customer paid, tax and tip included. */
  sales: number;
  payments: ReportPayment[];
  stylists: ReportStylistRow[];
};

const MODE_RANK: Record<string, number> = { Cash: 0, UPI: 1, Card: 2, Wallet: 3 };

const r2 = (n: number) => Math.round(n * 100) / 100;

export function buildReport(
  all: Bill[],
  range: Range,
  stylists: Stylist[],
  label: string,
): ReportFigures {
  const inRange = all.filter(
    (b) => b.status === "paid" && b.createdAt >= range.start && b.createdAt < range.end,
  );

  const sales = r2(inRange.reduce((a, b) => a + b.total, 0));

  const byMode = new Map<string, number>();
  for (const b of inRange)
    for (const p of b.payments) byMode.set(p.mode, r2((byMode.get(p.mode) ?? 0) + p.amount));
  const payments: ReportPayment[] = [...byMode.entries()]
    .map(([mode, amount]) => ({ mode, amount }))
    .sort(
      (a, b) => (MODE_RANK[a.mode] ?? 9) - (MODE_RANK[b.mode] ?? 9) || a.mode.localeCompare(b.mode),
    );

  const rows: ReportStylistRow[] = stylists.map((s) => {
    const e = computeEarnings(all, { id: s.id, name: s.name }, range);
    return { id: s.id ?? 0, name: s.name, sales: r2(e.value), services: e.services };
  });

  return {
    range,
    label,
    fromKey: istDateKey(range.start),
    toKey: istDateKey(range.end - 1),
    bills: inRange.length,
    sales,
    payments,
    stylists: rows,
  };
}

/**
 * YYYY-MM-DD for an instant in IST (Asia/Kolkata) — the app's billing
 * timezone — so range labels and the PDF filename match what the owner sees.
 */
export function istDateKey(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** "2026-10-31" (an IST calendar day) → 00:00 IST of that day, as epoch ms. */
export function parseIstDateKey(key: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d)) - IST_OFFSET;
  return Number.isNaN(t) ? null : t;
}
