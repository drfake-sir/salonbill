/**
 * Per-stylist earnings — always computed from stored bills at view time.
 *
 * Rules:
 *  - Only `paid` bills count (held bills are device-local, cancelled bills drop
 *    out automatically the moment their status changes).
 *  - A bill can involve several stylists: each service line is attributed to
 *    its own line.stylistId (falling back to line.stylistName for old rows).
 *  - Commission per line uses the commissionAmount snapshotted at save time;
 *    bills from before that field existed derive it from the line's
 *    commissionPct (also a save-time snapshot). When neither exists the line
 *    is counted but flagged as "commission not recorded" — never guessed
 *    from today's catalog rates.
 *  - The bill's tip is split across ALL service lines in proportion to their
 *    (pre-tax) value, so each stylist's tip share follows their work.
 *  - All date arithmetic is IST (a fixed UTC+05:30, no DST): week = Monday →
 *    Sunday, month = 1st → end, year = 1 Jan → 31 Dec.
 *  - Amounts are pre-tax line values (price × qty). The GST toggle and
 *    discount logic never enter here.
 *
 * This module is deliberately pure (no Dexie, no DOM) so it can be unit
 * tested directly and reused by the CSV export.
 */
import type { Bill, BillLine } from "./db";

/** IST is a fixed offset with no DST — safe to hard-code. */
export const IST_OFFSET = 5.5 * 60 * 60 * 1000;
const DAY = 86_400_000;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Half-open IST range [start, end) in epoch ms. */
export type Range = { start: number; end: number };

/** Start of the IST day containing `ms`. */
export const istDayStart = (ms: number) => Math.floor((ms + IST_OFFSET) / DAY) * DAY - IST_OFFSET;

/** Monday-based weekday (0=Mon … 6=Sun) of the IST day containing `ms`. */
export const istWeekday = (ms: number) => (new Date(ms + IST_OFFSET).getUTCDay() + 6) % 7;

const istParts = (ms: number) => {
  const d = new Date(ms + IST_OFFSET);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
};

/** Today in IST. */
export const rangeToday = (now: number): Range => {
  const s = istDayStart(now);
  return { start: s, end: s + DAY };
};

/** Yesterday in IST. */
export const rangeYesterday = (now: number): Range => {
  const s = istDayStart(now) - DAY;
  return { start: s, end: s + DAY };
};

/** This week: Monday 00:00 IST → next Monday 00:00 IST. */
export const rangeThisWeek = (now: number): Range => {
  const s = istDayStart(now) - istWeekday(now) * DAY;
  return { start: s, end: s + 7 * DAY };
};

/** Last week: the full Monday→Sunday week before this one. */
export const rangeLastWeek = (now: number): Range => {
  const s = istDayStart(now) - (istWeekday(now) + 7) * DAY;
  return { start: s, end: s + 7 * DAY };
};

/** This month: 1st 00:00 IST → 1st of next month 00:00 IST. */
export const rangeThisMonth = (now: number): Range => {
  const { y, m } = istParts(now);
  return { start: Date.UTC(y, m, 1) - IST_OFFSET, end: Date.UTC(y, m + 1, 1) - IST_OFFSET };
};

/** Last month. */
export const rangeLastMonth = (now: number): Range => {
  const { y, m } = istParts(now);
  return { start: Date.UTC(y, m - 1, 1) - IST_OFFSET, end: Date.UTC(y, m, 1) - IST_OFFSET };
};

/** This year: 1 Jan 00:00 IST → 1 Jan next year 00:00 IST. */
export const rangeThisYear = (now: number): Range => {
  const { y } = istParts(now);
  return { start: Date.UTC(y, 0, 1) - IST_OFFSET, end: Date.UTC(y + 1, 0, 1) - IST_OFFSET };
};

/** Custom range: both boundary days are IST days and both included. */
export const rangeDays = (fromMs: number, toMs: number): Range => ({
  start: istDayStart(Math.min(fromMs, toMs)),
  end: istDayStart(Math.max(fromMs, toMs)) + DAY,
});

/* ------------------------------ attribution ------------------------------ */

export type StylistRef = { id?: number | undefined; name: string };

/** A service line belongs to a stylist by snapshotted id, or by name for old rows. */
export function lineMatchesStylist(l: BillLine, s: StylistRef): boolean {
  if (l.kind !== "service") return false;
  if (s.id != null && l.stylistId != null) return l.stylistId === s.id;
  return (l.stylistName ?? "") === s.name && (s.id == null || l.stylistId == null);
}

/** `null` = every service line (owner's salon-wide view). */
const lineMatches = (l: BillLine, s: StylistRef | null) =>
  l.kind === "service" && (s === null || lineMatchesStylist(l, s));

export type EarnedLine = {
  billId: number;
  billNumber: string;
  at: number;
  /** IST day start (epoch ms) the bill was saved on. */
  day: number;
  service: string;
  qty: number;
  rate: number;
  /** Pre-tax line amount (price × qty). */
  amount: number;
  /** Snapshotted commission % — null when the bill predates commission tracking. */
  commissionPct: number | null;
  /** Earned commission — null when it cannot be known ("not recorded"). */
  commission: number | null;
  /** This line's share of the bill's tip, split by value. */
  tip: number;
  payment: string;
  customer: string;
  /** Who rang the bill up — NOT the stylist. Null when never recorded. */
  cashier: string | null;
  /** Which device wrote the bill. Null on bills from before multi-device. */
  device: string | null;
  /** Bill status at export time (always "paid" here — cancelled drop out). */
  status: string;
  /** Stylist for THIS line — the same per-line value the views render. */
  stylist: string;
};

export type DayTotal = {
  day: number;
  services: number;
  value: number;
  commission: number;
  tip: number;
  /** Lines whose commission was never recorded (old bills). */
  unrecorded: number;
  lines: EarnedLine[];
};

export type Earnings = {
  services: number;
  value: number;
  commission: number;
  tip: number;
  unrecorded: number;
  /** Ascending by IST day. */
  days: DayTotal[];
};

/**
 * Earnings for one stylist inside a range, computed from stored bills.
 * `bills` may be the whole bills table — filtering happens here.
 */
export function computeEarnings(bills: Bill[], stylist: StylistRef | null, range: Range): Earnings {
  const byDay = new Map<number, DayTotal>();

  for (const b of bills) {
    if (b.status !== "paid") continue;
    if (b.createdAt < range.start || b.createdAt >= range.end) continue;

    const serviceLines = b.lines.filter((l) => l.kind === "service");
    const mine = serviceLines.filter((l) => lineMatches(l, stylist));
    if (!mine.length) continue;

    // Tip follows service value across the bill's service lines.
    const serviceValue = serviceLines.reduce((a, l) => a + l.price * l.qty, 0);
    const tip = Math.max(b.tip || 0, 0);
    const payment = b.payments.map((p) => p.mode).join(" + ");
    const day = istDayStart(b.createdAt);

    const bucket = byDay.get(day) ?? {
      day,
      services: 0,
      value: 0,
      commission: 0,
      tip: 0,
      unrecorded: 0,
      lines: [],
    };

    for (const l of mine) {
      const amount = l.price * l.qty;
      const pct = typeof l.commissionPct === "number" ? l.commissionPct : null;
      const commission =
        typeof l.commissionAmount === "number"
          ? l.commissionAmount
          : pct !== null
            ? r2((amount * pct) / 100)
            : null;
      bucket.lines.push({
        billId: b.id ?? 0,
        billNumber: b.number,
        at: b.createdAt,
        day,
        service: l.name,
        qty: l.qty,
        rate: l.price,
        amount,
        commissionPct: pct,
        commission,
        tip: serviceValue > 0 ? r2((tip * amount) / serviceValue) : 0,
        payment,
        customer: b.customerName ?? "Walk-in",
        cashier: b.cashierName ?? null,
        device: b.deviceName?.trim() || null,
        status: b.status,
        // The line's own stylist, resolved the same way the bill details and
        // receipt resolve it — one rule everywhere so the numbers match.
        stylist: l.stylistName ?? l.stylistId?.toString() ?? "",
      });
      bucket.services += 1;
      bucket.value += amount;
      if (commission === null) bucket.unrecorded += 1;
      else bucket.commission += commission;
      bucket.tip += serviceValue > 0 ? (tip * amount) / serviceValue : 0;
    }
    byDay.set(day, bucket);
  }

  const days = [...byDay.values()].sort((a, b) => a.day - b.day);
  for (const d of days) {
    d.value = r2(d.value);
    d.commission = r2(d.commission);
    d.tip = r2(d.tip);
  }
  return {
    services: days.reduce((a, d) => a + d.services, 0),
    value: r2(days.reduce((a, d) => a + d.value, 0)),
    commission: r2(days.reduce((a, d) => a + d.commission, 0)),
    tip: r2(days.reduce((a, d) => a + d.tip, 0)),
    unrecorded: days.reduce((a, d) => a + d.unrecorded, 0),
    days,
  };
}

/** Flatten a computed range to its lines, newest first — shared by views/CSV. */
export function flatLines(e: Earnings): EarnedLine[] {
  return [...e.days].reverse().flatMap((d) => [...d.lines].reverse());
}

/* --------------------------------- CSV ---------------------------------- */

/**
 * IST formatters shared by every export.
 *
 * Excel mis-parses ISO timestamps under some locales, so exports use the
 * salon's own conventions instead: DD/MM/YYYY and a zero-padded 24-hour
 * HH:mm:ss. Both are computed from the epoch value via the Asia/Kolkata
 * zone, never from the browser's local zone.
 */
export const istDate = (ms: number) =>
  new Date(ms).toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" }); // DD/MM/YYYY

export const istTime = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }); // HH:mm:ss, zero-padded, 24h

/** ISO-8601 with the explicit IST offset — stored on each bill at save time. */
export const istIso = (ms: number) => `${new Date(ms).toISOString().replace("Z", "+05:30")}`;

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * UTF-8 BOM + CRLF CSV with every field safely quoted.
 *
 * The BOM is what makes Excel read ₹ and accented service names as UTF-8
 * instead of mojibake. Quoting every cell (not just those needing it) is the
 * only way to keep leading zeros, leading `=`/`+`/`-` and stray quotes from
 * being reinterpreted as formulas by Excel.
 */
export function toCsvFile(header: string[], rows: (string | number | null)[][]): string {
  const q = (v: string | number | null) => `"${(v === null ? "" : String(v)).replace(/"/g, '""')}"`;
  const body = [header.map(q).join(","), ...rows.map((r) => r.map(q).join(","))];
  return `\uFEFF${body.join("\r\n")}\r\n`;
}

export const CSV_HEADER = [
  "Stylist",
  "Cashier",
  "Device",
  "Bill No",
  "Date",
  "Time",
  "Service",
  "Qty",
  "Rate",
  "Amount",
  "Commission %",
  "Commission amount",
  "Tip share",
  "Payment mode",
  "Customer",
  "Status",
];

const csvRow = (l: EarnedLine) => [
  l.stylist,
  l.cashier ?? "not recorded",
  l.device ?? "not recorded",
  l.billNumber,
  istDate(l.at),
  istTime(l.at),
  l.service,
  l.qty,
  l.rate,
  l.amount,
  l.commissionPct === null ? "not recorded" : l.commissionPct,
  l.commission === null ? "not recorded" : l.commission,
  l.tip,
  l.payment,
  l.customer,
  l.status,
];

/**
 * Per-line earnings CSV (one row per attributed service line).
 * Cancelled bills never reach here — computeEarnings only counts `paid`.
 */
export function earningsToCsv(rows: EarnedLine[]): string {
  return toCsvFile(CSV_HEADER, rows.map(csvRow));
}
