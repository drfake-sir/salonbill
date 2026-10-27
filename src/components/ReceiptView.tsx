import { QRCodeSVG } from "qrcode.react";
import type { Bill, Settings, Stylist } from "@/lib/db";
import { deviceLabel } from "@/lib/db";
import { inr } from "@/lib/billing";

export function ReceiptView({
  bill,
  settings,
  stylists,
}: {
  bill: Bill;
  settings: Settings;
  stylists: Stylist[];
}) {
  const w = settings.paper === "58mm" ? "58mm" : "80mm";
  // Prefer the snapshot taken when the bill was saved so reprints never change;
  // older bills (saved before snapshots existed) fall back to current settings.
  const r = bill.receipt ?? {
    salonName: settings.salonName,
    address: settings.address,
    phone: settings.phone,
    gstOn: settings.gstOn,
    gstin: settings.gstin,
    footer: settings.footer,
    reviewUrl: settings.reviewUrl,
  };
  const sty = (l: Bill["lines"][number]) =>
    l.stylistName ?? stylists.find((s) => s.id === l.stylistId)?.name;
  const row = "flex justify-between gap-2";
  return (
    <div
      style={{
        width: w,
        fontFamily: "ui-monospace, monospace",
        fontSize: settings.paper === "58mm" ? 10 : 12,
        color: "#000",
        background: "#fff",
        padding: "4mm",
      }}
    >
      <style>{`@page { size: ${w} auto; margin: 0 }`}</style>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: "1.35em", fontWeight: 800 }}>{r.salonName}</div>
        {/* Empty lines (address, GSTIN, review QR, footer) are never printed. */}
        {r.address && <div>{r.address}</div>}
        <div>Ph: {r.phone}</div>
        {r.gstOn && r.gstin && <div>GSTIN: {r.gstin}</div>}
      </div>
      <hr style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />
      <div className={row}>
        <span>Bill: {bill.number}</span>
        <span>
          {new Date(bill.createdAt).toLocaleString("en-IN", {
            dateStyle: "short",
            timeStyle: "short",
          })}
        </span>
      </div>
      {bill.customerName && (
        <div>
          Customer: {bill.customerName} {bill.customerPhone}
        </div>
      )}
      {bill.cashierName && <div>Billed by: {bill.cashierName}</div>}
      <div>Device: {deviceLabel(bill)}</div>
      {bill.status === "cancelled" && (
        <div style={{ fontWeight: 800, textAlign: "center" }}>*** CANCELLED ***</div>
      )}
      <hr style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />
      {bill.lines.map((l) => (
        <div key={l.key} style={{ marginBottom: 3 }}>
          <div className={row}>
            <span>
              {l.name} x{l.qty}
            </span>
            <span>{inr(l.price * l.qty)}</span>
          </div>
          {sty(l) && <div style={{ fontSize: "0.85em" }}> by {sty(l)}</div>}
        </div>
      ))}
      <hr style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />
      <div className={row}>
        <span>Subtotal</span>
        <span>{inr(bill.subtotal)}</span>
      </div>
      {bill.discount > 0 && (
        <div className={row}>
          <span>Discount</span>
          <span>-{inr(bill.discount)}</span>
        </div>
      )}
      {r.gstOn && (
        <>
          <div className={row}>
            <span>CGST</span>
            <span>{inr(bill.cgst)}</span>
          </div>
          <div className={row}>
            <span>SGST</span>
            <span>{inr(bill.sgst)}</span>
          </div>
        </>
      )}
      {bill.tip > 0 && (
        <div className={row}>
          <span>Tip</span>
          <span>{inr(bill.tip)}</span>
        </div>
      )}
      <div className={row} style={{ fontSize: "1.6em", fontWeight: 800, margin: "4px 0" }}>
        <span>TOTAL</span>
        <span>{inr(bill.total)}</span>
      </div>
      <div>Paid: {bill.payments.map((p) => `${p.mode} ${inr(p.amount)}`).join(" + ")}</div>
      <hr style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />
      {r.reviewUrl && (
        <div style={{ textAlign: "center" }}>
          <QRCodeSVG value={r.reviewUrl} size={84} />
          <div>Review us on Google</div>
        </div>
      )}
      {r.footer && <div style={{ textAlign: "center", marginTop: 4 }}>{r.footer}</div>}
    </div>
  );
}
