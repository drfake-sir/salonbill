import { describe, expect, it } from "vitest";

import { computeEarnings, earningsToCsv, istDate, istIso, istTime, flatLines } from "./earnings";
import { billsToCsv, shouldRemindSundayBackup } from "./export";
import { applyCancel, deviceLabel, type Bill, type BillLine } from "./db";

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
  // 2026-04-15 19:00:51 IST (= 13:30:51 UTC) — a Wednesday evening.
  createdAt: Date.UTC(2026, 3, 15, 13, 30, 51),
  status: "paid",
  cashierName: "Priya",
  deviceName: "Counter",
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

const ALL = { start: Date.UTC(2026, 0, 1), end: Date.UTC(2027, 0, 1) };
const karthik = { id: 1, name: "Karthik" };
const priya = { id: 2, name: "Priya" };

const rows = (bills: Bill[], stylist: { id?: number; name: string } | null) =>
  flatLines(computeEarnings(bills, stylist, ALL));

/** Proper CSV parser — a naive comma split cannot read quoted fields. */
function parseCsvLine(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quoted) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const cells = (csv: string) =>
  csv
    .replace(/^\uFEFF/, "")
    .split("\r\n")
    .filter((r) => r !== "")
    .map(parseCsvLine);

/** Row 0 is the header, row 1+ the body. Fail loudly if the CSV is short. */
const headerOf = (csv: string): string[] => {
  const h = cells(csv)[0];
  if (!h) throw new Error("CSV has no header row");
  return h;
};
const bodyOf = (csv: string): string[][] => {
  const body = cells(csv).slice(1);
  if (!body.length) throw new Error("CSV has no data rows");
  return body;
};
const rowOf = (csv: string, i = 0): string[] => {
  const r = bodyOf(csv)[i];
  if (!r) throw new Error(`CSV has no data row ${i}`);
  return r;
};
/** Value in a named column — never relies on a hard-coded index. */
const col = (row: string[], header: string[], name: string): string => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`CSV has no column ${name}`);
  const v = row[i];
  if (v === undefined) throw new Error(`Row is missing column ${name}`);
  return v;
};

/* -------------------------------- date/time ------------------------------ */

describe("CSV date and time format", () => {
  it("formats the date as DD/MM/YYYY", () => {
    // 15 Apr 2026 19:00:51 IST
    expect(istDate(Date.UTC(2026, 3, 15, 13, 30, 51))).toBe("15/04/2026");
    // 05 Jan 2026 06:30:00 IST
    expect(istDate(Date.UTC(2026, 0, 5, 1, 0, 0))).toBe("05/01/2026");
  });

  it("formats the time as zero-padded 24-hour HH:mm:ss", () => {
    // The reported bug printed "19:0:51" — no padding, and a 2-digit hour
    // with 1-digit minutes/seconds.
    expect(istTime(Date.UTC(2026, 3, 15, 13, 30, 51))).toBe("19:00:51");
  });

  it("zero-pads a single-digit hour, minute and second", () => {
    // 2026-01-05 09:05:07 IST = 03:35:07 UTC
    expect(istTime(Date.UTC(2026, 0, 5, 3, 35, 7))).toBe("09:05:07");
  });

  it("never emits 24:xx for midnight", () => {
    // 2026-01-05 00:00:00 IST = 2026-01-04 18:30:00 UTC
    expect(istTime(Date.UTC(2026, 0, 4, 18, 30, 0))).toBe("00:00:00");
  });

  it("reads the clock in IST, not the machine's local zone", () => {
    // 18:30 UTC on 15 Apr is 00:00 IST on the 16th — the DATE must roll over
    // too, proving both formatters use Asia/Kolkata.
    const ms = Date.UTC(2026, 3, 15, 18, 30, 0);
    expect(istDate(ms)).toBe("16/04/2026");
    expect(istTime(ms)).toBe("00:00:00");
  });

  it("stores the save instant as ISO with an explicit IST offset", () => {
    expect(istIso(Date.UTC(2026, 3, 15, 13, 30, 51))).toBe("2026-04-15T13:30:51.000+05:30");
  });
});

/* -------------------------------- columns -------------------------------- */

describe("earnings CSV columns", () => {
  it("emits the required header in order", () => {
    expect(headerOf(earningsToCsv(rows([bill()], karthik)))).toEqual([
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
    ]);
  });

  it("carries cashier, device and status per line", () => {
    const b = bill();
    const csv = earningsToCsv(rows([b], karthik));
    const head = headerOf(csv);
    const row = rowOf(csv);
    expect(col(row, head, "Stylist")).toBe("Karthik");
    expect(col(row, head, "Cashier")).toBe("Priya"); // NOT the stylist
    expect(col(row, head, "Device")).toBe("Counter");
    expect(col(row, head, "Bill No")).toBe(b.number);
    expect(col(row, head, "Date")).toBe("15/04/2026");
    expect(col(row, head, "Time")).toBe("19:00:51");
    expect(col(row, head, "Status")).toBe("paid");
  });

  it("says 'not recorded' rather than inventing cashier or device", () => {
    const old = bill({ cashierName: undefined, deviceName: undefined });
    const csv = earningsToCsv(rows([old], karthik));
    const head = headerOf(csv);
    const row = rowOf(csv);
    expect(col(row, head, "Cashier")).toBe("not recorded");
    expect(col(row, head, "Device")).toBe("not recorded");
  });

  it("quotes and escapes commas and quotes in service names", () => {
    const b = bill({
      lines: [line({ name: 'Hair, "L\'Oréal" & Spa', stylistId: 1, stylistName: "Karthik" })],
    });
    const raw = earningsToCsv(rows([b], karthik));
    expect(raw).toContain('"Hair, ""L\'Oréal"" & Spa"');
    // Round-trips to the original text.
    expect(col(rowOf(raw), headerOf(raw), "Service")).toBe('Hair, "L\'Oréal" & Spa');
  });

  it("starts with a UTF-8 BOM so Excel reads ₹ correctly", () => {
    expect(earningsToCsv(rows([bill()], karthik)).charCodeAt(0)).toBe(0xfeff);
  });

  it("uses CRLF line endings and terminates the file", () => {
    const csv = earningsToCsv(rows([bill()], karthik));
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.includes("\n") && !csv.includes("\r\n")).toBe(false);
  });
});

/* ------------------------- owner vs stylist export ------------------------ */

describe("owner export vs stylist export", () => {
  const multi = bill({
    number: "SB-0500",
    lines: [
      line({
        name: "Keratin",
        stylistId: 1,
        stylistName: "Karthik",
        price: 1000,
        commissionAmount: 100,
      }),
      line({
        name: "Facial",
        stylistId: 2,
        stylistName: "Priya",
        price: 800,
        commissionAmount: 96,
      }),
    ],
  });

  const pair = (csv: string) => {
    const head = headerOf(csv);
    return bodyOf(csv).map((r) => [col(r, head, "Stylist"), col(r, head, "Service")]);
  };

  it("owner (salon-wide) export includes every stylist's lines", () => {
    // flatLines is newest-first, so the second line of the bill leads.
    expect(pair(earningsToCsv(rows([multi], null)))).toEqual([
      ["Priya", "Facial"],
      ["Karthik", "Keratin"],
    ]);
  });

  it("each line carries ITS OWN stylist in the owner export", () => {
    const stylistsInOrder = bodyOf(earningsToCsv(rows([multi], null))).map((r) =>
      col(r, headerOf(earningsToCsv(rows([multi], null))), "Stylist"),
    );
    expect(stylistsInOrder).toEqual(["Priya", "Karthik"]);
  });

  it("a stylist's own export contains only their own lines", () => {
    const csv = earningsToCsv(rows([multi], priya));
    const head = headerOf(csv);
    const body = bodyOf(csv);
    expect(body).toHaveLength(1); // header stripped by bodyOf
    expect(col(body[0]!, head, "Stylist")).toBe("Priya");
    expect(col(body[0]!, head, "Service")).toBe("Facial");
    expect(pair(csv).some(([, svc]) => svc === "Keratin")).toBe(false);
  });

  it("a stylist's export totals match what their earnings card shows", () => {
    const e = computeEarnings([multi], karthik, ALL);
    const csv = earningsToCsv(flatLines(e));
    expect(Number(col(rowOf(csv), headerOf(csv), "Amount"))).toBe(e.value);
    expect(Number(col(rowOf(csv), headerOf(csv), "Commission amount"))).toBe(e.commission);
  });
});

/* ------------------------------ cancelled bills --------------------------- */

describe("cancelled bills", () => {
  it("are excluded from earnings exports", () => {
    const b = bill({ status: "cancelled" });
    expect(rows([b], null)).toHaveLength(0);
    expect(earningsToCsv(rows([b], null))).not.toContain("SB-");
  });

  it("appear in the bills export with Status = cancelled", () => {
    const b = applyCancel(bill({ number: "SB-0777" }), "Customer changed mind", "Owner", 1);
    const csv = billsToCsv([b]);
    const head = headerOf(csv);
    const row = rowOf(csv);
    expect(col(row, head, "Status")).toBe("cancelled");
    expect(col(row, head, "Cancelled reason")).toBe("Customer changed mind");
    expect(col(row, head, "Cancelled by")).toBe("Owner");
  });

  it("a paid bill's export says paid, not cancelled", () => {
    const csv = billsToCsv([bill({ number: "SB-0778" })]);
    const head = headerOf(csv);
    expect(col(rowOf(csv), head, "Status")).toBe("paid");
    expect(col(rowOf(csv), head, "Cancelled reason")).toBe("");
  });
});

/* --------------------------- append-only cancel --------------------------- */

describe("cancel keeps the original row", () => {
  it("changes only status and the cancellation stamp", () => {
    const b = bill({ number: "SB-0900", tip: 50, total: 350, customerName: "Meena" });
    const frozen = JSON.parse(JSON.stringify(b)) as Bill;
    const cancelled = applyCancel(b, "Refund given", "Owner", 1700000000000);

    // Every original field survives untouched.
    expect(cancelled.lines).toEqual(frozen.lines);
    expect(cancelled.total).toBe(frozen.total);
    expect(cancelled.subtotal).toBe(frozen.subtotal);
    expect(cancelled.payments).toEqual(frozen.payments);
    expect(cancelled.customerName).toBe(frozen.customerName);
    expect(cancelled.cashierName).toBe(frozen.cashierName);
    expect(cancelled.deviceName).toBe(frozen.deviceName);
    expect(cancelled.createdAt).toBe(frozen.createdAt);
    expect(cancelled.number).toBe(frozen.number);
    expect(cancelled.tip).toBe(frozen.tip);

    // Only the stamp is added.
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelReason).toBe("Refund given");
    expect(cancelled.cancelledBy).toBe("Owner");
    expect(cancelled.cancelledAt).toBe(1700000000000);

    // The original object is not mutated.
    expect(b).toEqual(frozen);
  });
});

/* ---------------------------- device/cashier stamp ------------------------ */

describe("device and cashier stamp", () => {
  it("keeps cashier and device as separate fields", () => {
    const b = bill({ cashierName: "Priya", deviceName: "Owner phone" });
    const csv = billsToCsv([b]);
    const head = headerOf(csv);
    expect(col(rowOf(csv), head, "Cashier")).toBe("Priya");
    expect(col(rowOf(csv), head, "Device")).toBe("Owner phone");
  });

  it("labels a bill with no recorded device as Unknown device", () => {
    expect(deviceLabel(bill({ deviceName: undefined }))).toBe("Unknown device");
    expect(deviceLabel(bill({ deviceName: "   " }))).toBe("Unknown device");
    expect(deviceLabel(bill({ deviceName: "Counter" }))).toBe("Counter");
  });

  it("exports Unknown device instead of borrowing another device's name", () => {
    const csv = billsToCsv([bill({ deviceName: undefined })]);
    expect(col(rowOf(csv), headerOf(csv), "Device")).toBe("Unknown device");
  });
});

/* --------------------------- Sunday backup reminder ---------------------- */

describe("shouldRemindSundayBackup", () => {
  // 2026-04-19 21:00 IST = 15:30 UTC — a Sunday evening in the salon's zone.
  const sundayEvening = Date.UTC(2026, 3, 19, 15, 30);
  const monday = sundayEvening + 4 * 3600_000; // 01:00 IST Monday

  it("never shows outside Sunday", () => {
    expect(shouldRemindSundayBackup(monday, null)).toBe(false);
    expect(shouldRemindSundayBackup(sundayEvening - 24 * 3600_000, null)).toBe(false); // Sat
  });

  it("shows on Sunday when no backup exists yet", () => {
    expect(shouldRemindSundayBackup(sundayEvening, null)).toBe(true);
  });

  it("stays up until a backup is downloaded, then clears for the rest of the day", () => {
    // Downloaded earlier the same IST day → silence.
    expect(shouldRemindSundayBackup(sundayEvening, sundayEvening - 3600_000)).toBe(false);
    // Downloaded on a PREVIOUS day → up again next Sunday.
    expect(shouldRemindSundayBackup(sundayEvening, sundayEvening - 24 * 3600_000)).toBe(true);
  });

  it("decides on IST, not the machine or UTC zone", () => {
    // Sat 19:00 UTC = Sun 00:30 IST → already Sunday for the salon → show.
    expect(shouldRemindSundayBackup(Date.UTC(2026, 3, 18, 19, 0), null)).toBe(true);
    // Sun 20:00 UTC = Mon 01:30 IST → Sunday is over for the salon → hide,
    // even though the UTC calendar still says Sunday.
    expect(shouldRemindSundayBackup(Date.UTC(2026, 3, 19, 20, 0), null)).toBe(false);
  });
});
