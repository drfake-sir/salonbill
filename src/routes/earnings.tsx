import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ChevronDown, Download, X } from "lucide-react";
import { toast } from "sonner";
import { db, type Bill, type Stylist } from "@/lib/db";
import { inr } from "@/lib/billing";
import { useOwner, useSession } from "@/lib/lock";
import { PinPad } from "@/components/PinGate";
import { downloadText } from "@/lib/export";
import {
  computeEarnings,
  earningsToCsv,
  CSV_HEADER,
  flatLines,
  rangeDays,
  rangeLastMonth,
  rangeLastWeek,
  rangeThisMonth,
  rangeThisWeek,
  rangeToday,
  rangeThisYear,
  rangeYesterday,
  type Earnings,
  type Range,
  type StylistRef,
} from "@/lib/earnings";

export const Route = createFileRoute("/earnings")({
  head: () => ({
    meta: [
      { title: "Earnings — SalonBill" },
      {
        name: "description",
        content: "Per-stylist earnings: services, value, commission and tips for any period.",
      },
    ],
  }),
  validateSearch: (search: Record<string, unknown>): { stylist?: number | undefined } => ({
    stylist: Number(search["stylist"]) || undefined,
  }),
  component: EarningsPage,
});

/* --------------------------------- model --------------------------------- */

type PeriodKey =
  "today" | "week" | "month" | "year" | "yesterday" | "lastweek" | "lastmonth" | "custom";

const CARD_PERIODS: { key: PeriodKey; label: string; range: (now: number) => Range }[] = [
  { key: "today", label: "Today", range: rangeToday },
  { key: "week", label: "This week", range: rangeThisWeek },
  { key: "month", label: "This month", range: rangeThisMonth },
  { key: "year", label: "This year", range: rangeThisYear },
];

const SHORTCUTS: { key: PeriodKey; label: string; range: (now: number) => Range }[] = [
  { key: "yesterday", label: "Yesterday", range: rangeYesterday },
  { key: "lastweek", label: "Last week", range: rangeLastWeek },
  { key: "lastmonth", label: "Last month", range: rangeLastMonth },
];

const FLASH_KEY = "sb-earnings-flash";
const FLASH_SEEN_KEY = "sb-earnings-flash-seen";

/* Stable fallbacks so the live-query results stay referentially stable for
   the memos below (loading state uses these constants, not fresh arrays). */
const EMPTY_BILLS: Bill[] = [];
const EMPTY_STYLISTS: Stylist[] = [];

const istDayInput = (ms: number) =>
  new Date(ms).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
const istDateLabel = (ms: number) =>
  new Date(ms).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
const istTimeLabel = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
  });

/* --------------------------------- page ---------------------------------- */

function EarningsPage() {
  const session = useSession();
  const search = Route.useSearch();
  const deepLink = search["stylist"];
  // Staff sessions are hard-wired to their own numbers; the ?stylist= deep
  // link (from Catalog) only applies to owners. No session at all (legacy
  // installs without staff PINs) falls back to the owner PIN pad.
  if (!session)
    return (
      <div className="grid min-h-[70vh] place-items-center">
        <p className="max-w-xs text-center text-sm text-muted-foreground">
          Sign in with your staff PIN to see your earnings, or the owner PIN to see every stylist.
        </p>
        <PinPad />
      </div>
    );
  if (session.role === "owner") return <EarningsView forced={null} deepLinkStylist={deepLink} />;
  return (
    <EarningsView
      forced={{ id: session.staffId, name: session.name }}
      deepLinkStylist={undefined}
    />
  );
}

function EarningsView({
  forced,
  deepLinkStylist,
}: {
  forced: StylistRef | null;
  deepLinkStylist?: number | undefined;
}) {
  const bills = useLiveQuery(() => db.bills.toArray(), [], EMPTY_BILLS);
  const stylists = useLiveQuery(() => db.stylists.toArray(), [], EMPTY_STYLISTS);
  const owner = useOwner();

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

  const [selected, setSelected] = useState<number | "all">(
    deepLinkStylist && stylists.some((s) => s.id === deepLinkStylist) ? deepLinkStylist : "all",
  );
  useEffect(() => {
    if (deepLinkStylist && stylists.some((s) => s.id === deepLinkStylist))
      setSelected(deepLinkStylist);
  }, [deepLinkStylist, stylists]);

  const [activeKey, setActiveKey] = useState<PeriodKey>("today");
  const [from, setFrom] = useState(() => istDayInput(now));
  const [to, setTo] = useState(() => istDayInput(now));
  const [openDay, setOpenDay] = useState<number | null>(null);

  const range: Range = useMemo(() => {
    const preset = CARD_PERIODS.concat(SHORTCUTS).find((p) => p.key === activeKey);
    if (preset) return preset.range(now);
    const f = Date.parse(`${from}T00:00:00+05:30`);
    const t = Date.parse(`${to}T00:00:00+05:30`);
    if (!Number.isFinite(f) || !Number.isFinite(t)) return rangeToday(now);
    return rangeDays(f, t);
  }, [activeKey, from, to, now]);

  const ref: StylistRef | null = useMemo(() => {
    if (forced) return forced; // staff: always only themselves
    if (selected === "all") return null; // owner salon-wide view
    const s = stylists.find((x) => x.id === selected);
    return s ? { id: s.id, name: s.name } : null;
  }, [forced, selected, stylists]);

  const active: Earnings = useMemo(() => computeEarnings(bills, ref, range), [bills, ref, range]);
  const cards = useMemo(
    () => CARD_PERIODS.map((p) => ({ ...p, e: computeEarnings(bills, ref, p.range(now)) })),
    [bills, ref, now],
  );
  const comparison = useMemo(
    () =>
      owner
        ? stylists
            .filter((s) => s.active !== false)
            .map((s) => ({ s, e: computeEarnings(bills, { id: s.id, name: s.name }, range) }))
        : [],
    [owner, stylists, bills, range],
  );

  /* --------------------- post-save "+₹" flash notice --------------------- */
  const [flash, setFlash] = useState<{ at: number; billId?: number; number: string } | null>(null);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(FLASH_KEY);
      setFlash(raw ? (JSON.parse(raw) as { at: number; billId?: number; number: string }) : null);
    } catch {
      setFlash(null);
    }
  }, []);
  const flashBill = useLiveQuery(
    async () => (flash?.billId ? db.bills.get(flash.billId) : undefined),
    [flash?.billId],
    undefined,
  );
  const flashSeen = Number(localStorage.getItem(FLASH_SEEN_KEY) ?? 0);
  const flashEarned = useMemo(() => {
    if (!flash || flash.at <= flashSeen || !flashBill) return 0;
    const e = computeEarnings([flashBill], ref, rangeToday(now));
    return e.commission + e.tip;
  }, [flash, flashSeen, flashBill, ref, now]);

  /* --------------------------------- CSV ---------------------------------- */
  const exportCsv = () => {
    if (!owner) return;
    const slug = `${istDateLabel(range.start).replace(/\s/g, "-")}-to-${istDateLabel(range.end - 1).replace(/\s/g, "-")}`;
    try {
      if (selected === "all") {
        // Salon-wide: one file containing every stylist, with each line
        // carrying ITS OWN stylist (from the line, not the label), so a
        // multi-stylist bill contributes one row per stylist — exactly the
        // rows the comparison table above totals.
        const parts = stylists.map((s) =>
          earningsToCsv(flatLines(computeEarnings(bills, { id: s.id, name: s.name }, range))),
        );
        // Strip the BOM from every part but the first, and drop the repeated
        // header row, then re-assemble into one file.
        const body = parts.flatMap((p, i) =>
          p
            .replace(/^\uFEFF/, "")
            .split("\r\n")
            .slice(1)
            .filter(Boolean),
        );
        const one = parts[0] ? `\uFEFF${parts[0].replace(/^\uFEFF/, "").split("\r\n")[0]}` : "";
        downloadText(
          `earnings-all-stylists-${slug}.csv`,
          body.length ? `${one}\r\n${body.join("\r\n")}\r\n` : `${one}\r\n`,
          "text/csv;charset=utf-8",
        );
      } else {
        const s = stylists.find((x) => x.id === selected);
        if (!s) return;
        // A stylist's own export contains only their own lines.
        downloadText(
          `earnings-${s.name.replace(/\s+/g, "-")}-${slug}.csv`,
          earningsToCsv(flatLines(computeEarnings(bills, { id: s.id, name: s.name }, range))),
          "text/csv;charset=utf-8",
        );
      }
      toast.success("Earnings CSV downloaded");
    } catch (e) {
      console.error(e);
      toast.error("Could not build the CSV");
    }
  };

  /* -------------------------------- render -------------------------------- */
  const selectedName =
    selected === "all"
      ? "All stylists"
      : (stylists.find((s) => s.id === selected)?.name ?? "All stylists");
  const days = [...active.days].reverse(); // newest first

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">
          {forced ? "My earnings" : "Earnings"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {forced ? forced.name : selectedName} · commission from saved bills
        </p>
      </div>

      {/* owner: stylist picker */}
      {owner && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          <button
            onClick={() => setSelected("all")}
            className={`tap shrink-0 rounded-full px-4 py-2 text-sm font-semibold ${selected === "all" ? "bg-primary text-primary-foreground" : "bg-card shadow-soft"}`}
          >
            All stylists
          </button>
          {stylists
            .filter((s) => s.active !== false)
            .map((s) => (
              <button
                key={s.id}
                onClick={() => setSelected(s.id!)}
                className={`tap shrink-0 rounded-full px-4 py-2 text-sm font-semibold ${selected === s.id ? "bg-primary text-primary-foreground" : "bg-card shadow-soft"}`}
              >
                {s.name}
              </button>
            ))}
        </div>
      )}

      {/* period cards */}
      <div className="grid grid-cols-2 gap-3">
        {cards.map((c) => {
          const isToday = c.key === "today";
          const flashHere = isToday && flashEarned > 0;
          return (
            <button
              key={c.key}
              onClick={() => setActiveKey(c.key)}
              className={`tap rounded-2xl p-4 text-left ${activeKey === c.key ? "bg-primary text-primary-foreground shadow-lift" : "bg-card shadow-soft"}`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold opacity-80">{c.label}</span>
                {flashHere && (
                  <span className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-bold text-success">
                    +{inr(flashEarned)}
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label="Dismiss"
                      onClick={(e) => {
                        e.stopPropagation();
                        localStorage.setItem(FLASH_SEEN_KEY, String(flash?.at ?? Date.now()));
                        setFlash(null);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && setFlash(null)}
                      className="grid size-4 place-items-center opacity-70"
                    >
                      <X className="size-3" />
                    </span>
                  </span>
                )}
              </div>
              <div className="mt-1 text-2xl font-extrabold tabular-nums">{inr(c.e.commission)}</div>
              <div
                className={`mt-0.5 text-xs ${activeKey === c.key ? "opacity-80" : "text-muted-foreground"}`}
              >
                {c.e.services} services · {inr(c.e.value)}
              </div>
            </button>
          );
        })}
      </div>

      {/* shortcuts */}
      <div className="flex flex-wrap items-center gap-2">
        {SHORTCUTS.map((s) => (
          <button
            key={s.key}
            onClick={() => setActiveKey(s.key)}
            className={`tap rounded-full px-4 py-2 text-sm font-semibold ${activeKey === s.key ? "bg-primary text-primary-foreground" : "bg-secondary"}`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* custom range — its own row so native date inputs never squeeze the
          chips and push the page wider than the phone */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <input
          type="date"
          value={from}
          max={to}
          onChange={(e) => {
            setFrom(e.target.value);
            setActiveKey("custom");
          }}
          aria-label="From date"
          className="tap h-10 w-full min-w-0 rounded-xl border border-input bg-card px-2 text-sm outline-none"
        />
        <span className="shrink-0 text-sm text-muted-foreground">→</span>
        <input
          type="date"
          value={to}
          min={from}
          onChange={(e) => {
            setTo(e.target.value);
            setActiveKey("custom");
          }}
          aria-label="To date"
          className="tap h-10 w-full min-w-0 rounded-xl border border-input bg-card px-2 text-sm outline-none"
        />
      </div>

      {/* selected-period summary */}
      <section className="rounded-3xl bg-card p-5 shadow-soft">
        <div className="text-sm font-semibold text-muted-foreground">
          {istDateLabel(range.start)} – {istDateLabel(range.end - 1)} ·{" "}
          {forced ? forced.name : selectedName}
        </div>
        <div className="mt-1 text-4xl font-extrabold tabular-nums">{inr(active.commission)}</div>
        <div className="text-sm text-muted-foreground">commission earned</div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-2xl bg-secondary p-3">
            <div className="text-lg font-extrabold tabular-nums">{active.services}</div>
            <div className="text-xs text-muted-foreground">services</div>
          </div>
          <div className="rounded-2xl bg-secondary p-3">
            <div className="text-lg font-extrabold tabular-nums">{inr(active.value)}</div>
            <div className="text-xs text-muted-foreground">service value</div>
          </div>
          <div className="rounded-2xl bg-secondary p-3">
            <div className="text-lg font-extrabold tabular-nums">{inr(active.tip)}</div>
            <div className="text-xs text-muted-foreground">tips</div>
          </div>
        </div>
        {active.unrecorded > 0 && (
          <p className="mt-3 rounded-xl bg-gold-soft px-3 py-2 text-xs font-medium">
            Commission not recorded for {active.unrecorded}{" "}
            {active.unrecorded === 1 ? "service" : "services"} (billed before earnings tracking) —
            excluded from the commission total.
          </p>
        )}
        {owner && (
          <button
            onClick={exportCsv}
            className="tap mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-secondary px-4 py-3 font-semibold"
          >
            <Download className="size-4" />
            Export {selectedName} CSV
          </button>
        )}
      </section>

      {/* owner: per-stylist comparison for the selected period */}
      {owner && (
        <section className="rounded-3xl bg-card p-5 shadow-soft">
          <h2 className="mb-3 font-bold">Stylist comparison</h2>
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
              <span>Stylist</span>
              <span className="w-10 text-right">Svc</span>
              <span className="w-16 text-right">Value</span>
              <span className="w-16 text-right">Comm.</span>
            </div>
            {comparison.map(({ s, e }) => (
              <button
                key={s.id}
                onClick={() => setSelected(s.id!)}
                className="grid w-full grid-cols-[1fr_auto_auto_auto] items-center gap-2 rounded-xl bg-secondary px-3 py-2 text-sm"
              >
                <span className="truncate text-left font-medium">{s.name}</span>
                <span className="w-10 text-right tabular-nums">{e.services}</span>
                <span className="w-16 text-right tabular-nums">{inr(e.value)}</span>
                <span className="w-16 text-right font-bold tabular-nums">{inr(e.commission)}</span>
              </button>
            ))}
            {!comparison.length && <p className="text-sm text-muted-foreground">No staff yet.</p>}
          </div>
        </section>
      )}

      {/* daily breakdown */}
      <section className="rounded-3xl bg-card p-5 shadow-soft">
        <h2 className="mb-3 font-bold">Daily breakdown</h2>
        {!days.length && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No services in this period.
          </p>
        )}
        <div className="space-y-2">
          {days.map((d) => {
            const open = openDay === d.day;
            return (
              <div key={d.day} className="overflow-hidden rounded-2xl bg-secondary">
                <button
                  onClick={() => setOpenDay(open ? null : d.day)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{istDateLabel(d.day)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {d.services} services · {inr(d.value)}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-extrabold tabular-nums">{inr(d.commission)}</span>
                    {d.tip > 0 && (
                      <span className="block text-xs text-muted-foreground">+{inr(d.tip)} tip</span>
                    )}
                  </span>
                  <ChevronDown
                    className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
                  />
                </button>
                {open && (
                  <div className="space-y-2 border-t bg-card px-4 py-3 text-sm">
                    {d.lines
                      .slice()
                      .reverse()
                      .map((l, i) => (
                        <div
                          key={`${l.billId}-${i}`}
                          className="flex items-start justify-between gap-3"
                        >
                          <div className="min-w-0">
                            <div className="font-medium">
                              {l.service}{" "}
                              <span className="text-muted-foreground">
                                × {l.qty} @ {inr(l.rate)}
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {l.billNumber} · {istTimeLabel(l.at)} · {l.payment} · {l.customer}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              Cashier: {l.cashier ?? "not recorded"} · Device:{" "}
                              {l.device ?? "not recorded"}
                            </div>
                          </div>
                          <div className="shrink-0 text-right tabular-nums">
                            {l.commission === null ? (
                              <span className="text-xs font-medium text-muted-foreground">
                                commission not recorded
                              </span>
                            ) : (
                              <>
                                <span className="font-bold">{inr(l.commission)}</span>
                                <span className="text-xs text-muted-foreground">
                                  {" "}
                                  ({l.commissionPct}%)
                                </span>
                              </>
                            )}
                            {l.tip > 0 && (
                              <div className="text-xs text-muted-foreground">+{inr(l.tip)} tip</div>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
