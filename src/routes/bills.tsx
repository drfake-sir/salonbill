import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  BarChart3,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Lock,
  MessageCircle,
  Printer,
  Ban,
} from "lucide-react";
import { toast } from "sonner";
import { db, cancelBill, deviceLabel, type Bill } from "@/lib/db";
import { inr } from "@/lib/billing";
import { shareBillPdf } from "@/lib/pdf";
import { printBill } from "@/lib/print";
import { useOwner, useSession } from "@/lib/lock";
import { ReceiptView } from "@/components/ReceiptView";
import { PrintPortal } from "@/components/PrintPortal";
import { PinPad } from "@/components/PinGate";

export const Route = createFileRoute("/bills")({
  head: () => ({
    meta: [
      { title: "Past Bills — SalonBill" },
      { name: "description", content: "Browse, reprint and cancel past salon bills." },
      { property: "og:title", content: "Past Bills — SalonBill" },
      { property: "og:description", content: "Reprint or cancel any past bill." },
    ],
  }),
  component: Bills,
});

function Bills() {
  const bills = useLiveQuery(
    () =>
      db.bills
        .orderBy("createdAt")
        .reverse()
        .filter((b) => b.status !== "held")
        .toArray(),
    [],
  );
  const settings = useLiveQuery(() => db.settings.get(1));
  const stylists = useLiveQuery(() => db.stylists.toArray(), []) ?? [];
  const owner = useOwner();
  const session = useSession();
  const [printing, setPrinting] = useState<Bill | null>(null);
  // Bills whose line-by-line split-up is open.
  const [openId, setOpenId] = useState<number | null>(null);

  const reprint = (b: Bill) => printBill(setPrinting, b);

  const share = async (b: Bill) => {
    if (!settings) return;
    if (!b.customerPhone) {
      toast.error("This bill has no customer phone number");
      return;
    }
    try {
      const r = await shareBillPdf(b, settings, stylists);
      if (r === "shared") toast.success("Bill PDF shared on WhatsApp");
      else if (r === "downloaded")
        toast.info("Bill PDF saved — attach it in the customer's WhatsApp chat", {
          duration: 6000,
        });
    } catch (e) {
      console.error(e);
      toast.error("Could not create the bill PDF");
    }
  };

  const cancel = async (b: Bill) => {
    if (!owner) {
      toast.error("Unlock with owner PIN (Settings) to cancel bills");
      return;
    }
    const reason = prompt(`Reason for cancelling ${b.number}?`);
    if (!reason) return;
    try {
      // cancelBill restores product stock atomically, only from "paid", and
      // keeps the original row (status + stamp only — nothing is deleted).
      await cancelBill(b.id!, reason.trim(), session?.name);
      toast.success(`${b.number} cancelled · stock restored`);
    } catch (e) {
      console.error(e);
      toast.error("Could not cancel this bill");
    }
  };

  return (
    <div>
      <h1 className="mb-6 text-2xl font-extrabold tracking-tight">Past bills</h1>
      <MonthlyTotals owner={owner} bills={bills ?? []} />
      {bills && !bills.length && (
        <div className="rounded-3xl bg-card p-12 text-center text-muted-foreground shadow-soft">
          <div className="mb-2 text-4xl">🧾</div>No bills yet — your first sale will appear here.
        </div>
      )}
      <div className="space-y-2">
        {bills?.map((b) => {
          const open = openId === b.id;
          return (
            <div key={b.id} className="overflow-hidden rounded-2xl bg-card shadow-soft">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
                <button
                  onClick={() => setOpenId(open ? null : (b.id ?? null))}
                  className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2 text-left"
                  aria-expanded={open}
                >
                  <div className="w-full shrink-0 font-bold sm:w-24">{b.number}</div>
                  <div className="min-w-0 flex-1 basis-40">
                    <div className="truncate font-medium">{b.customerName ?? "Walk-in"}</div>
                    <div className="truncate text-sm text-muted-foreground">
                      {new Date(b.createdAt).toLocaleString("en-IN", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                      · {b.payments.map((p) => p.mode).join(" + ")}
                    </div>
                  </div>
                  {b.status === "cancelled" && (
                    <span className="shrink-0 rounded-full bg-destructive/10 px-3 py-1 text-xs font-semibold text-destructive">
                      Cancelled
                    </span>
                  )}
                  <div
                    className={`shrink-0 text-lg font-bold tabular-nums ${b.status === "cancelled" ? "line-through opacity-50" : ""}`}
                  >
                    {inr(b.total)}
                  </div>
                  <ChevronDown
                    className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
                  />
                </button>
                <div className="ml-auto flex shrink-0 gap-2">
                  <button
                    onClick={() => void share(b)}
                    className="tap grid w-11 place-items-center rounded-xl bg-secondary text-success"
                    aria-label="Send bill PDF on WhatsApp"
                  >
                    <MessageCircle className="size-4" />
                  </button>
                  <button
                    onClick={() => reprint(b)}
                    className="tap grid w-11 place-items-center rounded-xl bg-secondary"
                    aria-label="Reprint"
                  >
                    <Printer className="size-4" />
                  </button>
                  {b.status === "paid" && (
                    <button
                      onClick={() => cancel(b)}
                      className="tap grid w-11 place-items-center rounded-xl bg-secondary text-destructive"
                      aria-label="Cancel"
                    >
                      <Ban className="size-4" />
                    </button>
                  )}
                </div>
              </div>

              {open && (
                <div className="border-t px-4 pb-4 pt-3 text-sm">
                  <div className="mb-2 font-semibold text-muted-foreground">Services & items</div>
                  <div className="space-y-1.5">
                    {b.lines.map((l) => (
                      <div key={l.key} className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {l.name}{" "}
                            <span className="text-muted-foreground">
                              × {l.qty} @ {inr(l.price)}
                            </span>
                          </div>
                          {l.stylistName && (
                            <div className="text-xs text-muted-foreground">by {l.stylistName}</div>
                          )}
                        </div>
                        <div className="shrink-0 tabular-nums">{inr(l.price * l.qty)}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 space-y-1 border-t pt-2 text-muted-foreground">
                    <div className="flex justify-between">
                      <span>Subtotal</span>
                      <span className="tabular-nums text-foreground">{inr(b.subtotal)}</span>
                    </div>
                    {b.discount > 0 && (
                      <div className="flex justify-between">
                        <span>
                          Discount{b.discountType === "pct" ? ` (${b.discountValue}%)` : ""}
                        </span>
                        <span className="tabular-nums text-foreground">−{inr(b.discount)}</span>
                      </div>
                    )}
                    {(b.cgst > 0 || b.sgst > 0) && (
                      <>
                        <div className="flex justify-between">
                          <span>CGST</span>
                          <span className="tabular-nums text-foreground">{inr(b.cgst)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>SGST</span>
                          <span className="tabular-nums text-foreground">{inr(b.sgst)}</span>
                        </div>
                      </>
                    )}
                    {b.tip > 0 && (
                      <div className="flex justify-between">
                        <span>Tip</span>
                        <span className="tabular-nums text-foreground">{inr(b.tip)}</span>
                      </div>
                    )}
                  </div>
                  <div className="mt-2 flex justify-between border-t pt-2 font-bold">
                    <span>Total</span>
                    <span className="tabular-nums">{inr(b.total)}</span>
                  </div>
                  <div className="mt-3 rounded-xl bg-secondary p-3 text-muted-foreground">
                    <div>
                      <span className="font-semibold text-foreground">Paid</span> ·{" "}
                      {b.payments.map((p) => `${p.mode} ${inr(p.amount)}`).join(" + ")}
                    </div>
                    <div>
                      <span className="font-semibold text-foreground">Time</span> ·{" "}
                      {new Date(b.createdAt).toLocaleString("en-IN", {
                        dateStyle: "full",
                        timeStyle: "short",
                      })}
                    </div>
                    {b.cashierName && (
                      <div>
                        <span className="font-semibold text-foreground">Cashier</span> ·{" "}
                        {b.cashierName}
                      </div>
                    )}
                    <div>
                      <span className="font-semibold text-foreground">Device</span> ·{" "}
                      {deviceLabel(b)}
                    </div>
                    {b.status === "cancelled" && b.cancelReason && (
                      <div>
                        <span className="font-semibold text-destructive">Cancelled</span> ·{" "}
                        {b.cancelReason}
                        {b.cancelledBy && <> — by {b.cancelledBy}</>}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <PrintPortal>
        {printing && settings && (
          <ReceiptView bill={printing} settings={settings} stylists={stylists} />
        )}
      </PrintPortal>
    </div>
  );
}

/**
 * Owner-only month summary: revenue split by payment mode, by cashier and
 * by service — plus discounts, GST, tips and cancellations. Staff see a
 * locked card (owner PIN required), matching the owner-only rules for
 * exports and bill cancellation.
 */
function MonthlyTotals({ owner, bills }: { owner: boolean; bills: Bill[] }) {
  const [open, setOpen] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const [offset, setOffset] = useState(0); // 0 = current month

  const now = new Date();
  const cursor = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  const start = cursor.getTime();
  const end = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1).getTime();
  const label = cursor.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  const inMonth = bills.filter((b) => b.createdAt >= start && b.createdAt < end);
  const paid = inMonth.filter((b) => b.status === "paid");
  const cancelled = inMonth.filter((b) => b.status === "cancelled");
  const sum = (f: (b: Bill) => number) => paid.reduce((a, b) => a + f(b), 0);

  const byMode = new Map<string, number>();
  const byCashier = new Map<string, { count: number; total: number }>();
  const byService = new Map<string, { qty: number; total: number }>();
  for (const b of paid) {
    for (const p of b.payments) byMode.set(p.mode, (byMode.get(p.mode) ?? 0) + p.amount);
    const c = b.cashierName ?? "Unassigned";
    const ce = byCashier.get(c) ?? { count: 0, total: 0 };
    byCashier.set(c, { count: ce.count + 1, total: ce.total + b.total });
    for (const l of b.lines) {
      const se = byService.get(l.name) ?? { qty: 0, total: 0 };
      byService.set(l.name, { qty: se.qty + l.qty, total: se.total + l.price * l.qty });
    }
  }
  const topServices = [...byService.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 5);
  const paidTotal = sum((b) => b.total);
  const cgstSgst = sum((b) => b.cgst + b.sgst);

  const stat = (k: string, v: string) => (
    <div className="rounded-2xl bg-secondary p-3">
      <div className="text-xs font-medium text-muted-foreground">{k}</div>
      <div className="mt-0.5 text-lg font-extrabold tabular-nums">{v}</div>
    </div>
  );

  return (
    <div className="mb-6 overflow-hidden rounded-3xl bg-card shadow-soft">
      <button
        onClick={() => {
          if (owner) setOpen((o) => !o);
          else {
            setShowPin(true);
            setOpen(true);
          }
        }}
        className="tap flex w-full items-center gap-3 px-5 py-4 text-left"
        aria-expanded={open}
      >
        <span className="grid size-9 place-items-center rounded-xl bg-accent-soft text-accent-foreground">
          <BarChart3 className="size-5" />
        </span>
        <span className="flex-1">
          <span className="block font-bold">Monthly totals</span>
          <span className="block text-sm text-muted-foreground">
            {label} · {inr(paidTotal)} across {paid.length} bills
          </span>
        </span>
        {!owner && (
          <span className="flex items-center gap-1 rounded-full bg-secondary px-3 py-1 text-xs font-semibold text-muted-foreground">
            <Lock className="size-3.5" /> Owner only
          </span>
        )}
        <ChevronDown
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && !owner && (
        <div className="border-t px-5 pb-5 pt-4">
          <p className="mb-3 text-sm text-muted-foreground">
            Unlock with the owner PIN to view monthly totals.
          </p>
          {showPin && <PinPad onOk={() => setShowPin(false)} />}
        </div>
      )}

      {open && owner && (
        <div className="space-y-4 border-t px-5 pb-5 pt-4">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setOffset((o) => o + 1)}
              className="tap grid size-9 place-items-center rounded-xl bg-secondary"
              aria-label="Previous month"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="font-bold">{label}</span>
            <button
              onClick={() => setOffset((o) => Math.max(0, o - 1))}
              disabled={offset === 0}
              className="tap grid size-9 place-items-center rounded-xl bg-secondary disabled:opacity-40"
              aria-label="Next month"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {stat("Bills", String(paid.length))}
            {stat("Revenue", inr(paidTotal))}
            {stat("Discounts", `−${inr(sum((b) => b.discount))}`)}
            {stat("GST collected", inr(cgstSgst))}
            {stat("Tips", inr(sum((b) => b.tip)))}
            {stat("Cancelled", String(cancelled.length))}
            {stat("Avg bill", inr(paid.length ? Math.round(paidTotal / paid.length) : 0))}
            {stat("Walk-ins", String(paid.filter((b) => !b.customerName).length))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                Payment split
              </div>
              {byMode.size ? (
                <div className="space-y-1.5">
                  {[...byMode.entries()].map(([mode, amt]) => (
                    <div
                      key={mode}
                      className="flex justify-between rounded-xl bg-secondary px-3 py-2 text-sm"
                    >
                      <span className="font-medium">{mode}</span>
                      <span className="tabular-nums">
                        {inr(amt)}{" "}
                        <span className="text-muted-foreground">
                          ({paidTotal ? Math.round((amt / paidTotal) * 100) : 0}%)
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No paid bills this month.</p>
              )}
            </div>
            <div>
              <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                By cashier
              </div>
              <div className="space-y-1.5">
                {[...byCashier.entries()].map(([name, c]) => (
                  <div
                    key={name}
                    className="flex justify-between rounded-xl bg-secondary px-3 py-2 text-sm"
                  >
                    <span className="font-medium">{name}</span>
                    <span className="tabular-nums">
                      {c.count} bills · {inr(c.total)}
                    </span>
                  </div>
                ))}
                {!byCashier.size && <p className="text-sm text-muted-foreground">No bills yet.</p>}
              </div>
            </div>
          </div>

          {topServices.length > 0 && (
            <div>
              <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                Top services
              </div>
              <div className="space-y-1.5">
                {topServices.map(([name, s]) => (
                  <div
                    key={name}
                    className="flex justify-between rounded-xl bg-secondary px-3 py-2 text-sm"
                  >
                    <span className="font-medium">{name}</span>
                    <span className="tabular-nums">
                      × {s.qty} · {inr(s.total)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
