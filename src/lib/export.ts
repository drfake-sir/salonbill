/**
 * Owner export helpers (device-local backups).
 *
 * Three artefacts:
 *  - full JSON backup (restore format — Settings → Restore accepts it)
 *  - bills CSV (spreadsheet for the accountant / GST)
 *  - monthly off-platform copy (both files, to be emailed / Drive'd)
 */
import { db, logAudit, deviceLabel, type Bill } from "./db";
import { istDate, istTime, toCsvFile } from "./earnings";

/** Device-local markers (localStorage) for backup hygiene reminders. */
export const META_KEYS = {
  offsite: "sb-offsite-export-at",
  drill: "sb-restore-drill-at",
} as const;

export function getMeta(key: string): number | null {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function setMeta(key: string, at: number) {
  try {
    localStorage.setItem(key, String(at));
  } catch {
    /* private mode */
  }
}

/** Trigger a download of an in-memory text file. */
export function downloadText(filename: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Every bill (paid + cancelled) as a spreadsheet CSV.
 *
 * This is the ONLY export that contains cancelled bills, so an accountant can
 * see what was reversed; earnings exports deliberately exclude them. Columns
 * mirror the earnings CSV where they overlap so the two files can be joined
 * on Bill No.
 */
export function billsToCsv(bills: Bill[]): string {
  const header = [
    "Bill No",
    "Date",
    "Time",
    "Customer",
    "Phone",
    "Cashier",
    "Device",
    "Status",
    "Items",
    "Subtotal",
    "Discount",
    "CGST",
    "SGST",
    "Tip",
    "Total",
    "Payment mode",
    "Cancelled reason",
    "Cancelled by",
    "Cancelled at",
  ];
  const rows = bills.map((b) => [
    b.number,
    istDate(b.createdAt),
    istTime(b.createdAt),
    b.customerName ?? "Walk-in",
    b.customerPhone ?? "",
    b.cashierName ?? "not recorded",
    deviceLabel(b),
    b.status,
    b.lines
      .map((l) => `${l.name} x${l.qty}${l.stylistName ? ` (${l.stylistName})` : ""}`)
      .join("; "),
    b.subtotal,
    b.discount,
    b.cgst,
    b.sgst,
    b.tip,
    b.total,
    b.payments.map((p) => `${p.mode} ${p.amount}`).join(" + "),
    b.cancelReason ?? "",
    b.cancelledBy ?? "",
    b.cancelledAt ? `${istDate(b.cancelledAt)} ${istTime(b.cancelledAt)}` : "",
  ]);
  return toCsvFile(header, rows);
}

/** Dump every table in the restore format. */
export async function snapshotAll(): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {};
  for (const t of db.tables) data[t.name] = await t.toArray();
  return data;
}

export const dateSlug = () => new Date().toISOString().slice(0, 10);

/** Full JSON backup download (the restore format). Returns bills count. */
export async function downloadLocalBackup(): Promise<number> {
  const data = await snapshotAll();
  const bills = (data["bills"] as unknown[] | undefined)?.length ?? 0;
  downloadText(`salonbill-backup-${dateSlug()}.json`, JSON.stringify(data), "application/json");
  await logAudit("backup.download", "manual");
  return bills;
}

/** Bills-only CSV download (includes cancelled bills). Returns rows exported. */
export async function downloadBillsCsv(): Promise<number> {
  const bills = await db.bills.where("status").notEqual("held").toArray();
  downloadText(`salonbill-bills-${dateSlug()}.csv`, billsToCsv(bills), "text/csv;charset=utf-8");
  await logAudit("export.bills-csv", `${bills.length} bills`);
  return bills.length;
}

/**
 * The monthly off-platform copy: JSON + CSV together, recorded so Settings can
 * remind the owner when 30 days pass without one. The owner then emails the
 * files to themselves / drops them in Google Drive — a copy that survives
 * losing the Cloudflare account entirely.
 */
export async function downloadMonthlyCopy(): Promise<{ bills: number }> {
  const data = await snapshotAll();
  const all = await db.bills.where("status").notEqual("held").toArray();
  const slug = dateSlug();
  downloadText(`salonbill-monthly-${slug}.json`, JSON.stringify(data), "application/json");
  downloadText(`salonbill-monthly-${slug}-bills.csv`, billsToCsv(all), "text/csv;charset=utf-8");
  setMeta(META_KEYS.offsite, Date.now());
  await logAudit("export.offsite", `${all.length} bills`);
  return { bills: all.length };
}
