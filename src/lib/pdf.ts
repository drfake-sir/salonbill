import type { Bill, Settings, Stylist } from "./db";
import { inr, waLink, billWaText } from "./billing";

/*
 * Client-side PDF invoices.
 *
 * The receipt is laid out as a fixed off-screen HTML card with inline hex
 * styles and captured with html2canvas-pro (the plain html2canvas cannot
 * parse the oklch() colours our Tailwind theme computes on body), then
 * composed into a single tall page with jsPDF. jspdf/html2canvas-pro/qrcode
 * are loaded lazily so the billing screen's initial bundle stays small.
 */

const NAVY = "#22304f";
const GOLD = "#d9a02c";
const INK = "#1c2438";
const MUTED = "#6b7488";
const LINE = "#dfe3ec";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

/** Deterministic, filesystem-safe PDF filename for a bill. */
export function pdfFilename(b: Bill): string {
  const name = (b.customerName ?? "")
    .trim()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "");
  return `${b.number}${name ? `-${name}` : ""}.pdf`.replace(/\s+/g, "-");
}

function invoiceHtml(bill: Bill, stylists: Stylist[], qrDataUrl: string | null): string {
  const r = bill.receipt;
  const stylistName = (stylistId?: number) =>
    stylists.find((s) => s.id === stylistId)?.name ?? null;

  const rows = bill.lines
    .map(
      (l) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid ${LINE};vertical-align:top;">
          <div style="font-size:15px;font-weight:600;color:${INK};">${esc(l.name)}</div>
          ${stylistName(l.stylistId) ? `<div style="font-size:12px;color:${MUTED};margin-top:2px;">by ${esc(stylistName(l.stylistId)!)}${l.kind === "product" ? " · retail product" : ""}</div>` : ""}
        </td>
        <td style="padding:10px 0;border-bottom:1px solid ${LINE};text-align:center;font-size:14px;color:${INK};white-space:nowrap;">${l.qty}</td>
        <td style="padding:10px 0;border-bottom:1px solid ${LINE};text-align:right;font-size:14px;color:${MUTED};white-space:nowrap;">${inr(l.price)}</td>
        <td style="padding:10px 0;border-bottom:1px solid ${LINE};text-align:right;font-size:15px;font-weight:700;color:${INK};white-space:nowrap;">${inr(l.price * l.qty)}</td>
      </tr>`,
    )
    .join("");

  const sumRow = (label: string, value: string, bold = false) => `
    <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:14px;${
      bold ? `font-weight:700;color:${INK};` : `color:${MUTED};`
    }"><span>${label}</span><span style="tabular-nums:1;">${value}</span></div>`;

  const totals = `
    ${sumRow("Subtotal", inr(bill.subtotal))}
    ${bill.discount > 0 ? sumRow(`Discount${bill.discountType === "pct" ? ` (${bill.discountValue}%)` : ""}`, `− ${inr(bill.discount)}`) : ""}
    ${r?.gstOn ? sumRow("CGST", inr(bill.cgst)) + sumRow("SGST", inr(bill.sgst)) : ""}
    ${bill.tip > 0 ? sumRow("Tip", inr(bill.tip)) : ""}`;

  const payments = bill.payments
    .map((p) => `${p.mode}${p.amount !== bill.total ? ` · ${inr(p.amount)}` : ""}`)
    .join(" + ");

  return `
  <div style="width:640px;background:#ffffff;font-family:'Plus Jakarta Sans',system-ui,-apple-system,sans-serif;color:${INK};box-sizing:border-box;">
    <div style="background:${NAVY};padding:30px 36px 26px;">
      <div style="font-size:27px;font-weight:800;color:#ffffff;letter-spacing:-0.02em;">${esc(r?.salonName ?? "SalonBill")}</div>
      ${r?.address ? `<div style="font-size:13px;color:#b9c2d6;margin-top:6px;line-height:1.5;">${esc(r.address)}</div>` : ""}
      ${r?.phone ? `<div style="font-size:13px;color:#b9c2d6;">Ph: ${esc(r.phone)}</div>` : ""}
      ${r?.gstOn && r.gstin ? `<div style="font-size:13px;color:#b9c2d6;">GSTIN: ${esc(r.gstin)}</div>` : ""}
    </div>
    <div style="height:6px;background:linear-gradient(90deg,${GOLD},#b87e14);"></div>

    <div style="padding:26px 36px 34px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <div style="font-size:20px;font-weight:800;letter-spacing:-0.01em;">Bill ${esc(bill.number)}</div>
        <div style="font-size:13px;color:${MUTED};">${fmtDate(bill.createdAt)}</div>
      </div>

      <div style="background:#f5f7fb;border-radius:12px;padding:14px 18px;margin-top:16px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-size:11px;font-weight:700;color:${MUTED};letter-spacing:0.12em;text-transform:uppercase;">Billed to</div>
          <div style="font-size:16px;font-weight:700;margin-top:3px;">${esc(bill.customerName ?? "Walk-in customer")}</div>
        </div>
        ${bill.customerPhone ? `<div style="font-size:14px;color:${MUTED};">${esc(bill.customerPhone)}</div>` : ""}
      </div>

      ${
        bill.status === "cancelled"
          ? `
      <div style="margin-top:16px;background:#fdecec;border:1px solid #f3b8b8;color:#a33;border-radius:10px;padding:10px 16px;font-size:14px;font-weight:700;">
        CANCELLED${bill.cancelReason ? ` — ${esc(bill.cancelReason)}` : ""}
      </div>`
          : ""
      }

      <table style="width:100%;border-collapse:collapse;margin-top:18px;">
        <thead>
          <tr>
            <th style="text-align:left;font-size:11px;font-weight:700;color:${MUTED};letter-spacing:0.12em;text-transform:uppercase;padding-bottom:8px;">Service</th>
            <th style="text-align:center;font-size:11px;font-weight:700;color:${MUTED};letter-spacing:0.12em;text-transform:uppercase;padding-bottom:8px;">Qty</th>
            <th style="text-align:right;font-size:11px;font-weight:700;color:${MUTED};letter-spacing:0.12em;text-transform:uppercase;padding-bottom:8px;">Rate</th>
            <th style="text-align:right;font-size:11px;font-weight:700;color:${MUTED};letter-spacing:0.12em;text-transform:uppercase;padding-bottom:8px;">Amount</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      <div style="display:flex;justify-content:space-between;gap:24px;margin-top:22px;">
        <div style="font-size:13px;color:${MUTED};line-height:1.7;">
          <div><b style="color:${INK};">Payment</b> · ${esc(payments)}</div>
          <div><b style="color:${INK};">Date</b> · ${fmtDate(bill.createdAt)}</div>
          ${bill.cashierName ? `<div><b style="color:${INK};">Cashier</b> · ${esc(bill.cashierName)}</div>` : ""}
        </div>
        <div style="flex:1;max-width:300px;">
          ${totals}
          <div style="margin-top:10px;background:${NAVY};color:#ffffff;border-radius:12px;padding:13px 18px;display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:13px;font-weight:700;letter-spacing:0.1em;">TOTAL</span>
            <span style="font-size:23px;font-weight:800;">${inr(bill.total)}</span>
          </div>
        </div>
      </div>

      <div style="margin-top:28px;border-top:1px dashed ${LINE};padding-top:20px;text-align:center;">
        ${
          qrDataUrl
            ? `
        <div style="margin-bottom:8px;"><img src="${qrDataUrl}" width="86" height="86" alt="Review QR" /></div>
        <div style="font-size:12px;color:${MUTED};margin-bottom:10px;">Scan to review us on Google</div>`
            : ""
        }
        ${r?.footer ? `<div style="font-size:15px;font-weight:700;color:${INK};">${esc(r.footer)}</div>` : ""}
      </div>
    </div>
  </div>`;
}

/** Render the invoice off-screen and return it as a PDF blob. */
export async function buildBillPdf(
  bill: Bill,
  settings: Settings,
  stylists: Stylist[],
): Promise<Blob> {
  const [{ jsPDF }, { default: html2canvas }, QRCode] = await Promise.all([
    import("jspdf"),
    import("html2canvas-pro"),
    import("qrcode"),
  ]);

  const reviewUrl = bill.receipt?.reviewUrl ?? settings.reviewUrl;
  let qrDataUrl: string | null = null;
  if (reviewUrl) {
    try {
      qrDataUrl = await QRCode.toDataURL(reviewUrl, {
        margin: 1,
        width: 240,
        color: { dark: NAVY },
      });
    } catch {
      qrDataUrl = null; // QR is decorative — never fail the invoice over it
    }
  }

  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;background:#fff;z-index:-1;pointer-events:none;";
  host.innerHTML = invoiceHtml(bill, stylists, qrDataUrl);
  document.body.appendChild(host);

  try {
    const card = host.firstElementChild as HTMLElement;
    const canvas = await html2canvas(card, { scale: 2, backgroundColor: "#ffffff" });
    const png = canvas.toDataURL("image/png");

    // A5 width, height grows with the bill so long item lists never clip.
    const pageW = 148;
    const margin = 8;
    const imgW = pageW - margin * 2;
    const imgH = (canvas.height / canvas.width) * imgW;
    const doc = new jsPDF({
      orientation: "portrait",
      unit: "mm",
      format: [pageW, Math.max(210, imgH + margin * 2)],
    });
    doc.addImage(png, "PNG", margin, margin, imgW, imgH, undefined, "FAST");
    return doc.output("blob");
  } finally {
    host.remove();
  }
}

export type ShareResult = "shared" | "downloaded" | "cancelled";

/**
 * Build the bill PDF and hand it to the customer:
 *  - phones/tablets: native share sheet (Web Share API v2) — the staff picks
 *    WhatsApp and the customer, and the PDF arrives as a real attachment;
 *  - desktop / unsupported: the PDF is downloaded and the WhatsApp chat is
 *    opened so staff can attach it with one drag.
 */
export async function shareBillPdf(
  bill: Bill,
  settings: Settings,
  stylists: Stylist[],
): Promise<ShareResult> {
  const blob = await buildBillPdf(bill, settings, stylists);
  const filename = pdfFilename(bill);
  const file = new File([blob], filename, { type: "application/pdf" });

  const nav = navigator as Navigator & { canShare?: (d?: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], text: `Bill ${bill.number} — thank you! 🙏` });
      return "shared";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
      // NotAllowedError (gesture expired) or no WhatsApp target: fall through.
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);

  // Open the customer's chat in a new tab so the downloaded PDF can be
  // attached right away. If the popup is blocked we stay on the POS screen —
  // never hijack the billing tab away to WhatsApp.
  if (bill.customerPhone) {
    const chat = waLink(bill.customerPhone, billWaText(bill, settings));
    if (chat) window.open(chat, "_blank", "noopener");
  }
  return "downloaded";
}
