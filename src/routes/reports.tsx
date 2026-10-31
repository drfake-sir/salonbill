import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import { Download, FileText, Share2 } from "lucide-react";

import { db, type Bill, type Settings, type Stylist } from "@/lib/db";
import { OwnerOnly } from "@/components/PinGate";
import {
  rangeDays,
  rangeThisMonth,
  rangeThisWeek,
  rangeToday,
  rangeThisYear,
  type Range,
} from "@/lib/earnings";
import { buildReport, istDateKey, parseIstDateKey, type ReportFigures } from "@/lib/reports";
import { buildReportPdf, reportPdfFilename, shareReportPdf } from "@/lib/pdf";

/*
 * Owner Reports — one page of "how did we do", for any period.
 *
 * The ranges, the IST day boundaries and the per-stylist attribution all come
 * from lib/reports, which reuses Earnings' own helpers, so these figures can
 * never drift from what Earnings shows. Cancelled and held bills are excluded
 * exactly as Earnings excludes them, and commission is never displayed here.
 */

export const Route = createFileRoute("/reports")({
  head: () => ({
    meta: [
      { title: "Reports — SalonBill" },
      {
        name: "description",
        content: "Owner report: sales, bills, payment split and per-stylist sales for any period.",
      },
    ],
  }),
  component: () => (
    <OwnerOnly>
      <ReportsPage />
    </OwnerOnly>
  ),
});

const EMPTY_BILLS: Bill[] = [];
const EMPTY_STYLISTS: Stylist[] = [];

type PeriodKey = "today" | "week" | "month" | "year" | "custom";

const PERIODS: { key: PeriodKey; label: string; range: (now: number) => Range }[] = [
  { key: "today", label: "Today", range: rangeToday },
  { key: "week", label: "This week", range: rangeThisWeek },
  { key: "month", label: "This month", range: rangeThisMonth },
  { key: "year", label: "This year", range: rangeThisYear },
];

const istDayInput = (ms: number) =>
  new Date(ms).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD

function ReportsPage() {
  const bills = useLiveQuery(() => db.bills.toArray(), [], EMPTY_BILLS);
  const stylists = useLiveQuery(() => db.stylists.toArray(), [], EMPTY_STYLISTS);
  const settings = useLiveQuery(() => db.settings.get(1));

  const [now, setNow] = useState(() => Date.now());
  // Roll the presets over at midnight / when the app comes back to foreground.
  useEffect(() => {
    const t = () => setNow(Date.now());
    document.addEventListener("visibilitychange", t);
    window.addEventListener("focus", t);
    return () => {
      document.removeEventListener("visibilitychange", t);
      window.removeEventListener("focus", t);
    };
  }, []);

  const [key, setKey] = useState<PeriodKey>("today");
  const [from, setFrom] = useState(() => istDayInput(now));
  const [to, setTo] = useState(() => istDayInput(now));
  const [busy, setBusy] = useState<"pdf" | "share" | null>(null);

  const { range, label } = useMemo(() => {
    const preset = PERIODS.find((p) => p.key === key);
    const r = preset
      ? preset.range(now)
      : (() => {
          const f = parseIstDateKey(from);
          const t = parseIstDateKey(to);
          return f !== null && t !== null ? rangeDays(f, t) : rangeToday(now);
        })();
    const title = preset ? preset.label : "Custom";
    return { range: r, label: `${title} · ${istDateKey(r.start)} to ${istDateKey(r.end - 1)}` };
  }, [key, from, to, now]);

  const figures: ReportFigures = useMemo(
    () => buildReport(bills, range, stylists, label),
    [bills, range, stylists, label],
  );

  const withSettings = async (kind: "pdf" | "share", run: (s: Settings) => Promise<void>) => {
    if (busy) return;
    if (!settings) {
      toast.error("Settings are still loading — try again in a moment");
      return;
    }
    setBusy(kind);
    try {
      await run(settings);
    } catch (e) {
      console.error(e);
      toast.error("Could not build the report — please try again");
    } finally {
      setBusy(null);
    }
  };

  /** Clean A4 PDF, named SalonBill-Report-<from>-to-<to>.pdf. */
  const downloadPdf = () =>
    withSettings("pdf", async (s) => {
      const blob = await buildReportPdf(figures, s);
      const filename = reportPdfFilename(figures.fromKey, figures.toKey);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast.success(`Report saved · ${filename}`);
    });

  /** Native share sheet where the device offers one, plain download elsewhere. */
  const share = () =>
    withSettings("share", async (s) => {
      const r = await shareReportPdf(figures, s);
      if (r === "shared") toast.success("Report shared");
      else if (r === "downloaded")
        toast.success("No share sheet here — the report was downloaded instead");
    });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">
          {settings?.salonName ? `${settings.salonName} · ` : ""}Owner only — sales and services,
          without commission figures. Cancelled and held bills are left out.
        </p>
      </div>

      {/* -------------------------------- ranges -------------------------------- */}
      <section className="space-y-3 rounded-3xl bg-card p-5 shadow-soft">
        <div className="flex flex-wrap gap-2">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setKey(p.key)}
              className={`tap rounded-xl px-4 py-2 text-sm font-semibold ${
                key === p.key ? "bg-primary text-primary-foreground" : "bg-secondary"
              }`}
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={() => setKey("custom")}
            className={`tap rounded-xl px-4 py-2 text-sm font-semibold ${
              key === "custom" ? "bg-primary text-primary-foreground" : "bg-secondary"
            }`}
          >
            Custom
          </button>
        </div>
        {key === "custom" && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">From</span>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="tap rounded-xl border border-input bg-card px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">To</span>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="tap rounded-xl border border-input bg-card px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{label}</p>
      </section>

      {/* -------------------------------- figures ------------------------------- */}
      <section className="grid gap-4 rounded-3xl bg-card p-5 shadow-soft sm:grid-cols-2">
        <div className="rounded-2xl bg-secondary px-4 py-4">
          <div className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">
            Total sales
          </div>
          <div className="mt-1 text-3xl font-extrabold tracking-tight">
            {new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(
              figures.sales,
            )}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            What customers paid, GST and tip included
          </div>
        </div>
        <div className="rounded-2xl bg-secondary px-4 py-4">
          <div className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">
            Bills
          </div>
          <div className="mt-1 text-3xl font-extrabold tracking-tight">{figures.bills}</div>
          <div className="mt-1 text-xs text-muted-foreground">Paid bills in this period</div>
        </div>

        <div className="sm:col-span-2">
          <h2 className="mb-2 font-bold">Payment split</h2>
          {figures.payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No paid bills in this period.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {figures.payments.map((p) => (
                  <tr key={p.mode} className="border-b border-border last:border-0">
                    <td className="py-2">{p.mode}</td>
                    <td className="py-2 text-right tabular-nums">
                      {new Intl.NumberFormat("en-IN", {
                        style: "currency",
                        currency: "INR",
                      }).format(p.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="rounded-3xl bg-card p-5 shadow-soft">
        <h2 className="mb-2 font-bold">Sales &amp; services by stylist</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
              <th className="py-2 font-semibold">Stylist</th>
              <th className="py-2 text-right font-semibold">Services</th>
              <th className="py-2 text-right font-semibold">Sales</th>
            </tr>
          </thead>
          <tbody>
            {figures.stylists.map((s) => (
              <tr key={s.id} className="border-b border-border last:border-0">
                <td className="py-2">{s.name}</td>
                <td className="py-2 text-right tabular-nums">{s.services}</td>
                <td className="py-2 text-right tabular-nums">
                  {new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(
                    s.sales,
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-muted-foreground">
          Sales is the pre-tax value of services each stylist did — commission is not shown in
          reports.
        </p>
      </section>

      {/* --------------------------------- export -------------------------------- */}
      <section className="flex flex-wrap gap-3 rounded-3xl bg-card p-5 shadow-soft">
        <button
          onClick={() => void downloadPdf()}
          disabled={busy !== null}
          className="tap flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 font-semibold text-accent-foreground disabled:opacity-50"
        >
          <Download className="size-4" /> {busy === "pdf" ? "Building…" : "Download PDF"}
        </button>
        <button
          onClick={() => void share()}
          disabled={busy !== null}
          className="tap flex items-center gap-2 rounded-xl bg-secondary px-5 py-2.5 font-semibold disabled:opacity-50"
        >
          <Share2 className="size-4" /> {busy === "share" ? "Sharing…" : "Share"}
        </button>
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <FileText className="size-4" />
          {reportPdfFilename(figures.fromKey, figures.toKey)}
        </span>
      </section>
    </div>
  );
}
