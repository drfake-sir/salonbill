import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Search,
  Minus,
  Plus,
  Check,
  ChevronDown,
  Pause,
  Printer,
  Save,
  UserPlus,
  X,
  Clock,
  FileX2,
} from "lucide-react";
import { toast } from "sonner";
import {
  db,
  commitSale,
  StockShortageError,
  getTabId,
  saveDraft,
  loadDraft,
  clearDraft,
  listOrphanDrafts,
  deleteDraftById,
  pruneDrafts,
  getDeviceName,
  type Bill,
  type BillLine,
  type Draft,
  type Payment,
  type ReceiptInfo,
} from "@/lib/db";
import { computeTotals, inr, typedCustomerName } from "@/lib/billing";
import { PHONE_ERROR, isPhoneShaped, isValidPhone, normalizePhoneInput } from "@/lib/phoneInput";
import { defaultStylistIdFor, stylistNameFor, unattributedServiceLines } from "@/lib/attribution";
import {
  applyServedBy,
  isCustomStylist,
  markStylistPick,
  missingStylistMessage,
  stylistForNewLine,
  type CustomStylistKeys,
} from "@/lib/servedBy";
import { istIso } from "@/lib/earnings";
import { printBill } from "@/lib/print";
import { shareBillPdf } from "@/lib/pdf";
import { useSession } from "@/lib/lock";
import { ReceiptView } from "@/components/ReceiptView";
import { PrintPortal } from "@/components/PrintPortal";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Quick Billing — SalonBill" },
      {
        name: "description",
        content: "Bill salon services and products in seconds, fully offline.",
      },
      { property: "og:title", content: "Quick Billing — SalonBill" },
      { property: "og:description", content: "Offline-first billing for Indian salons." },
    ],
  }),
  component: Billing,
});

const MODES: Payment["mode"][] = ["Cash", "UPI", "Card", "Wallet"];

function Billing() {
  const session = useSession();
  const settings = useLiveQuery(() => db.settings.get(1));
  const cats = useLiveQuery(() => db.categories.orderBy("order").toArray(), []) ?? [];
  const services = useLiveQuery(() => db.services.filter((s) => s.active).toArray(), []) ?? [];
  const products = useLiveQuery(() => db.products.filter((p) => p.active).toArray(), []) ?? [];
  const stylists = useLiveQuery(() => db.stylists.filter((s) => s.active).toArray(), []) ?? [];
  const customers = useLiveQuery(() => db.customers.toArray(), []) ?? [];
  const held = useLiveQuery(() => db.bills.where("status").equals("held").toArray(), []) ?? [];

  const [tab, setTab] = useState<number | "products" | "all">("all");
  const [q, setQ] = useState("");
  const [lines, setLines] = useState<BillLine[]>([]);
  const [discType, setDiscType] = useState<"flat" | "pct">("pct");
  const [disc, setDisc] = useState(0);
  const [tip, setTip] = useState(0);
  const [mode, setMode] = useState<Payment["mode"]>("Cash");
  const [cust, setCust] = useState<{ id?: number | undefined; name: string; phone: string } | null>(
    null,
  );
  const [custQ, setCustQ] = useState("");
  const [heldId, setHeldId] = useState<number | undefined>();
  const [printing, setPrinting] = useState<Bill | null>(null);
  const [sheet, setSheet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [orphans, setOrphans] = useState<Draft[]>([]);
  /** "Served by" chip — one stylist for the whole bill (UI state only). */
  const [servedBy, setServedBy] = useState<number | null>(null);
  /** Lines whose stylist was picked individually — chips never clobber them. */
  const [customStylists, setCustomStylists] = useState<CustomStylistKeys>(() => new Set<string>());
  /** Discount / Tip start collapsed into one row; tap to expand. */
  const [discOpen, setDiscOpen] = useState(false);
  /** Which line's stylist CHIP menu is open (a small tap target, not a form). */
  const [stylistFor, setStylistFor] = useState<string | null>(null);
  /** Scroll shadows on the item list — on only when more lines are hidden. */
  const [shadowTop, setShadowTop] = useState(false);
  const [shadowBottom, setShadowBottom] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const tabId = useMemo(() => getTabId(), []);
  // Re-entrancy guard: a second tap (or F9 held down) while the first save is in
  // flight must not create a second bill. React state alone updates too late.
  const savingRef = useRef(false);

  const totals = computeTotals(lines, discType, disc, !!settings?.gstOn, tip);

  const items = useMemo(() => {
    const term = q.toLowerCase();
    const svc = services.filter(
      (s) => (tab === "all" || s.categoryId === tab) && s.name.toLowerCase().includes(term),
    );
    const prod =
      tab === "products" || (tab === "all" && term)
        ? products.filter((p) => p.name.toLowerCase().includes(term))
        : [];
    return [
      ...(tab === "products"
        ? []
        : svc.map((s) => ({
            kind: "service" as const,
            id: s.id!,
            name: s.name,
            price: s.price,
            sub: `${s.duration} min`,
            gst: s.gstRate,
            com: s.commissionPct,
          }))),
      ...prod.map((p) => ({
        kind: "product" as const,
        id: p.id!,
        name: p.name,
        price: p.price,
        sub: `${p.stock} in stock`,
        gst: p.gstRate,
        com: 0,
      })),
    ];
  }, [services, products, tab, q]);

  /**
   * Who performs a new service line.
   *
   * A signed-in STYLIST gets their own identity on every line they add — that
   * is the person who did the work. The OWNER gets NO default: they are not
   * performing the service, so they must pick a stylist per line, and saving
   * is blocked below until they do. (The old code fell back to
   * `stylists[0]?.id`, which is whatever row Dexie returned first — always
   * Karthik — and silently billed every service to them regardless of who was
   * signed in.)
   */
  const defaultStylistId = defaultStylistIdFor(session);

  const add = (it: (typeof items)[number]) => {
    setLines((ls) => {
      const ex = ls.find((l) => l.kind === it.kind && l.refId === it.id);
      // Same service tapped twice → quantity visibly goes up (easy to spot and undo).
      if (ex) return ls.map((l) => (l === ex ? { ...l, qty: l.qty + 1 } : l));
      return [
        ...ls,
        {
          key: crypto.randomUUID(),
          kind: it.kind,
          refId: it.id,
          name: it.name,
          price: it.price,
          qty: 1,
          gstRate: it.gst,
          commissionPct: it.com,
          // A chosen "Served by" chip owns every new line on this bill.
          stylistId:
            it.kind === "service" ? stylistForNewLine(servedBy, defaultStylistId) : undefined,
        },
      ];
    });
  };
  const upd = (key: string, p: Partial<BillLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)).filter((l) => l.qty > 0));
  const removeLine = (key: string) => setLines((ls) => ls.filter((l) => l.key !== key));

  /** Tap a chip → that stylist serves every non-customised line of the bill. */
  const pickServedBy = (id: number) => {
    setServedBy(id);
    setLines((ls) => applyServedBy(ls, customStylists, id));
  };

  /** Keep the item-list scroll shadows in sync with the scroll position. */
  const syncShadows = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setShadowTop(el.scrollTop > 2);
    setShadowBottom(el.scrollTop + el.clientHeight < el.scrollHeight - 2);
  }, []);

  const reset = () => {
    setLines([]);
    setDisc(0);
    setTip(0);
    setCust(null);
    setCustQ("");
    setHeldId(undefined);
    setMode("Cash");
    setSheet(false);
    // Next bill needs a conscious "Served by" choice — it affects pay.
    setServedBy(null);
    setCustomStylists(new Set<string>());
    setDiscOpen(false);
    clearDraft(tabId).catch(() => {});
  };

  /** Bill body without id/number — numbering happens atomically inside commitSale. */
  const build = (status: Bill["status"]): Omit<Bill, "id" | "number"> => {
    const at = Date.now();
    return {
      createdAt: at,
      // ISO with the IST offset, for exports. createdAt stays the epoch master
      // so range maths and sorting are unaffected.
      createdAtIso: istIso(at),
      status,
      // Cashier: WHO RANG THE SALE UP (signed-in session). Stylist is per line
      // and is whoever performed the service — never the same field.
      cashierId: session?.staffId,
      cashierName: session?.name,
      // Which phone/tablet wrote this bill — set once, per device.
      deviceName: getDeviceName() || undefined,
      customerId: cust?.id,
      // A name typed with no phone never becomes a customer record, but it
      // still rides on the bill — trimmed, capped, and shown instead of
      // "Walk-in" everywhere the bill is read.
      customerName: cust?.name ?? typedCustomerName(custQ),
      customerPhone: cust?.phone,
      lines: lines.map((l) => ({
        ...l,
        // Commission snapshot: frozen at save time so later rate changes can
        // never rewrite historical earnings.
        commissionAmount: Math.round(l.price * l.qty * l.commissionPct) / 100,
        // Stylist name resolved from the chosen id. Only set for lines that
        // actually carry an id, so an unattributed line can never claim a name.
        stylistName: stylistNameFor(stylists, l),
      })),
      discountType: discType,
      discountValue: disc,
      ...totals,
      payments: [{ mode, amount: totals.total }],
      // Snapshot salon details at save time so reprints never drift when settings change.
      receipt: settings
        ? ({
            salonName: settings.salonName,
            address: settings.address,
            phone: settings.phone,
            gstOn: settings.gstOn,
            gstin: settings.gstin,
            footer: settings.footer,
            reviewUrl: settings.reviewUrl,
          } satisfies ReceiptInfo)
        : undefined,
    };
  };

  /** Build the bill PDF and hand it to the customer on WhatsApp. */
  const sendPdf = async (b: Bill) => {
    if (!settings) return;
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

  const save = async (action: "save" | "print") => {
    if (savingRef.current) return; // ignore repeated Save taps / F9 auto-repeat
    if (!lines.length) {
      toast.error("Add a service first");
      return;
    }
    // A phone number typed into the customer field must be COMPLETE: a
    // half-typed number is neither saved nor silently dropped.
    if (isPhoneShaped(custQ) && !isValidPhone(custQ)) {
      toast.error(PHONE_ERROR);
      return;
    }
    // Every service line must name the stylist who performed it. Earnings,
    // the receipt and the CSV all read this field, so an unattributed line
    // would silently vanish from someone's pay. The owner has no default.
    const unattributed = unattributedServiceLines(lines);
    if (unattributed.length) {
      // The message points at "Served by" — the fastest fix on a phone.
      toast.error(missingStylistMessage(unattributed.length, unattributed[0]?.name));
      return;
    }
    if (!settings) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const newCustomer =
        cust && !cust.id && cust.phone ? { name: cust.name, phone: cust.phone } : undefined;
      const bill = await commitSale({ draft: build("paid"), heldId, newCustomer });
      await clearDraft(tabId);
      // Tell the Earnings screen about this save so the stylist's Today card
      // can flash a "+₹amount" notice. Purely additive — billing never depends
      // on it (earnings are always recomputed from stored bills).
      try {
        sessionStorage.setItem(
          "sb-earnings-flash",
          JSON.stringify({ at: Date.now(), billId: bill.id, number: bill.number }),
        );
      } catch {
        /* private mode */
      }
      toast.success(`${bill.number} saved · ${inr(bill.total)}`);
      reset();
      if (action === "print" || settings.autoPrint) printBill(setPrinting, bill);

      // Saved without printing → the PDF goes to the customer's WhatsApp right
      // away. Printed → offer it as a one-tap option instead, since the
      // customer may still want a digital copy.
      if (!bill.customerPhone) {
        if (action === "save")
          toast.info("Add the customer's phone number to send the bill on WhatsApp");
      } else if (action === "save") {
        void sendPdf(bill);
      } else {
        toast(`Send ${bill.number} to ${bill.customerName ?? "the customer"} on WhatsApp too?`, {
          action: { label: "Send PDF", onClick: () => void sendPdf(bill) },
          duration: 12000,
        });
      }
    } catch (e) {
      if (e instanceof StockShortageError) {
        const detail = e.shortages
          .map((s) => `${s.name}: ${s.wanted} requested, ${s.available} left`)
          .join(" · ");
        toast.error(`Not enough stock — ${detail}`, { duration: 6000 });
      } else {
        console.error(e);
        toast.error("Could not save the bill. Nothing was written — please try again.");
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const hold = async () => {
    if (!lines.length) return;
    const customerId =
      cust && !cust.id && cust.phone
        ? ((await db.customers.add({
            name: cust.name,
            phone: cust.phone,
            createdAt: Date.now(),
          })) as number)
        : cust?.id;
    if (heldId) await db.bills.delete(heldId);
    await db.bills.add({
      ...build("held"),
      customerId,
      number: `HOLD-${Date.now().toString(36).toUpperCase()}`,
    });
    toast("Bill on hold");
    reset();
  };

  const resume = (b: Bill) => {
    if (lines.length) {
      toast.error("Clear or hold the current bill first");
      return;
    }
    setLines(b.lines);
    setDiscType(b.discountType);
    setDisc(b.discountValue);
    setTip(b.tip);
    setCust(
      b.customerName
        ? { id: b.customerId, name: b.customerName, phone: b.customerPhone ?? "" }
        : null,
    );
    setHeldId(b.id);
    // Restore the payment mode the bill was held with — otherwise resuming a
    // held UPI/Card/Wallet bill silently reverts the UI (and the saved bill)
    // to Cash.
    setMode(b.payments[0]?.mode ?? "Cash");
    // This is a fresh bill as far as attribution goes.
    setServedBy(null);
    setCustomStylists(new Set<string>());
  };

  const resumeDraft = async (d: Draft) => {
    if (lines.length) {
      toast.error("Clear the current bill first");
      return;
    }
    setLines(d.lines);
    setDiscType(d.discountType);
    setDisc(d.discountValue);
    setTip(d.tip);
    setMode(d.mode);
    setCust(
      d.customerName
        ? { id: d.customerId, name: d.customerName, phone: d.customerPhone ?? "" }
        : null,
    );
    setHeldId(d.heldId);
    setServedBy(null);
    setCustomStylists(new Set<string>());
    await deleteDraftById(d.id!);
    setOrphans((os) => os.filter((o) => o.id !== d.id));
    toast.success("Unsaved bill restored");
  };

  // Draft autosave: persist the in-progress bill (debounced) so refresh/close never loses it.
  useEffect(() => {
    if (!lines.length && !cust) return;
    const t = setTimeout(() => {
      saveDraft({
        tabId,
        lines,
        discountType: discType,
        discountValue: disc,
        tip,
        mode,
        customerId: cust?.id,
        customerName: cust?.name ?? typedCustomerName(custQ),
        customerPhone: cust?.phone,
        heldId,
      }).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [lines, discType, disc, tip, mode, cust, custQ, heldId, tabId]);

  // On load: recover this tab's draft and surface drafts left by closed tabs.
  useEffect(() => {
    (async () => {
      try {
        await pruneDrafts();
        const mine = await loadDraft(tabId);
        if (mine?.lines.length) {
          setLines(mine.lines);
          setDiscType(mine.discountType);
          setDisc(mine.discountValue);
          setTip(mine.tip);
          setMode(mine.mode);
          setCust(
            mine.customerName
              ? { id: mine.customerId, name: mine.customerName, phone: mine.customerPhone ?? "" }
              : null,
          );
          setHeldId(mine.heldId);
          toast.info("Unfinished bill restored");
        }
        setOrphans(await listOrphanDrafts(tabId));
      } catch {
        /* drafts are best-effort recovery */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault();
        document.getElementById("svc-search")?.focus();
      }
      if (e.key === "F9") {
        e.preventDefault();
        save("print");
      }
      if (e.key === "F8") {
        e.preventDefault();
        hold();
      }
      if (e.key === "Escape") {
        if (stylistFor) setStylistFor(null);
        else if (sheet) setSheet(false);
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  // Prevent background scroll while the mobile bill sheet is open.
  useEffect(() => {
    document.body.style.overflow = sheet ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [sheet]);

  const custMatches =
    custQ.length >= 2
      ? customers
          .filter(
            (c) => c.phone.includes(custQ) || c.name.toLowerCase().includes(custQ.toLowerCase()),
          )
          .slice(0, 5)
      : [];
  const itemQty = lines.reduce((a, l) => a + l.qty, 0);

  // Recompute the list shadows whenever the bill's contents change size or
  // the sheet opens (the list only exists while the sheet is visible).
  useEffect(() => {
    syncShadows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines.length, sheet]);
  const panel = (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 items-center justify-between gap-2">
        {/* One line: what this is + how many items, with Clear and close. */}
        <h2 className="min-w-0 truncate text-lg font-bold">
          Current bill - {itemQty} item{itemQty === 1 ? "" : "s"}
        </h2>
        <div className="flex items-center gap-3">
          {lines.length > 0 && (
            <button
              onClick={reset}
              className="tap px-2 text-sm text-muted-foreground hover:text-destructive"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => setSheet(false)}
            aria-label="Close bill"
            className="tap -mr-2 grid size-11 place-items-center rounded-xl text-muted-foreground hover:bg-secondary lg:hidden"
          >
            <X className="size-5" />
          </button>
        </div>
      </div>

      {stylists.length > 0 && (
        <div
          role="group"
          aria-label="Served by"
          className="-mx-1 flex shrink-0 items-center gap-2 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Served by
          </span>
          {stylists.map((s) => {
            const active = s.id !== undefined && servedBy === s.id;
            return (
              <button
                key={s.id}
                onClick={() => s.id !== undefined && pickServedBy(s.id)}
                aria-pressed={active}
                title={`Every line served by ${s.name}`}
                className={`tap min-h-11 shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold ${
                  active ? "bg-primary text-primary-foreground" : "bg-secondary"
                }`}
              >
                {s.name}
              </button>
            );
          })}
        </div>
      )}

      {cust ? (
        // One compact line: name, phone, remove (44px).
        <div className="shrink-0">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Customer name or phone
          </span>
          <div className="flex items-center gap-2 rounded-xl bg-gold-soft py-1 pl-3 pr-1">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{cust.name}</span>
            <span className="shrink-0 text-sm text-muted-foreground">{cust.phone}</span>
            <button
              onClick={() => setCust(null)}
              aria-label="Remove customer"
              className="tap grid size-11 shrink-0 place-items-center"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      ) : (
        <div className="shrink-0">
          <label
            htmlFor="bill-customer"
            className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Customer name or phone
          </label>
          <div className="relative">
            <input
              id="bill-customer"
              aria-label="Customer name or phone"
              value={custQ}
              onChange={(e) => {
                const v = e.target.value;
                // Phone-shaped input is normalised as it is typed or pasted:
                // digits only, a +91 / 91 / 0 prefix stripped, capped at 10.
                // Anything with a letter is a name and passes through as is.
                setCustQ(isPhoneShaped(v) ? normalizePhoneInput(v) : v);
              }}
              placeholder="Customer name or phone"
              maxLength={60}
              inputMode={/^\d+$/.test(custQ) || custQ === "" ? "numeric" : "text"}
              className="tap w-full rounded-2xl border border-input bg-card px-4 py-2.5 outline-none focus:ring-2 focus:ring-ring"
            />
            {custQ.length >= 2 && (
              <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-2xl border bg-popover shadow-lift">
                {custMatches.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setCust(c);
                      setCustQ("");
                    }}
                    className="flex w-full justify-between gap-2 px-4 py-3 text-left hover:bg-secondary"
                  >
                    <span className="truncate">{c.name}</span>
                    <span className="shrink-0 text-muted-foreground">{c.phone}</span>
                  </button>
                ))}
                {/^\d{10}$/.test(custQ) && !custMatches.length && (
                  <button
                    onClick={() => {
                      const name = prompt("Customer name?");
                      if (name) {
                        setCust({ name, phone: custQ });
                        setCustQ("");
                      }
                    }}
                    className="flex w-full items-center gap-2 px-4 py-3 text-primary hover:bg-secondary"
                  >
                    <UserPlus className="size-4" />
                    Add new customer {custQ}
                  </button>
                )}
              </div>
            )}
          </div>
          {isPhoneShaped(custQ) && !isValidPhone(custQ) && (
            <p data-testid="customer-phone-error" className="mt-1 text-xs text-destructive">
              {PHONE_ERROR}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            Add a phone to save the customer and send on WhatsApp
          </p>
          {typedCustomerName(custQ) && (
            <p
              data-testid="saving-as"
              className="mt-0.5 text-xs font-semibold text-accent-foreground"
            >
              Saving as: {typedCustomerName(custQ)}
            </p>
          )}
        </div>
      )}

      {(orphans.length > 0 || held.length > 0) && (
        <div className="flex shrink-0 flex-wrap gap-2">
          {orphans.map((d) => (
            <button
              key={`d${d.id}`}
              onClick={() => resumeDraft(d)}
              className="tap flex items-center gap-2 rounded-full border border-dashed border-gold-soft bg-card px-4 py-2 text-sm font-medium"
            >
              <FileX2 className="size-4" />
              Unsaved bill · {inr(d.lines.reduce((a, l) => a + l.price * l.qty, 0))}
            </button>
          ))}
          {held.map((b) => (
            <button
              key={b.id}
              onClick={() => resume(b)}
              className="tap flex items-center gap-2 rounded-full bg-gold-soft px-4 py-2 text-sm font-medium"
            >
              <Clock className="size-4" />
              {b.customerName ?? "Walk-in"} · {inr(b.total)}
            </button>
          ))}
        </div>
      )}

      <div className="relative flex min-h-24 min-w-0 flex-1 flex-col">
        <div
          ref={listRef}
          onScroll={syncShadows}
          className="-mx-1 min-h-24 flex-1 space-y-2 overflow-y-auto overscroll-contain px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {!lines.length && (
            <div className="grid place-items-center rounded-2xl border border-dashed py-12 text-center text-muted-foreground">
              <div className="mb-2 text-4xl">✂️</div>Tap a service to start
            </div>
          )}
          {lines.map((l) => (
            <div
              key={l.key}
              className="rounded-2xl border bg-card p-2 animate-in fade-in slide-in-from-right-2 duration-200"
            >
              {/* Row 1 — service name and the line's price. */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium leading-tight">{l.name}</span>
                  {isCustomStylist(customStylists, l.key, servedBy) && (
                    <span className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      custom
                    </span>
                  )}
                </div>
                <span className="shrink-0 text-right tabular-nums">
                  <span className="block text-base font-bold leading-tight">
                    {inr(l.price * l.qty)}
                  </span>
                  {l.qty > 1 && (
                    <span className="block text-[11px] text-muted-foreground">
                      {inr(l.price)} × {l.qty}
                    </span>
                  )}
                </span>
              </div>
              {/* Row 2 — stylist, quantity stepper, remove (all 44px targets). */}
              <div className="mt-1 flex items-center gap-2">
                {l.kind === "service" && (
                  <div className="relative min-w-0">
                    {/* Small tappable chip (not a form field): name + caret. */}
                    <button
                      onClick={() => setStylistFor(stylistFor === l.key ? null : l.key)}
                      aria-label={`Stylist for ${l.name}`}
                      aria-expanded={stylistFor === l.key}
                      className="tap flex h-11 min-w-0 max-w-full items-center gap-1 rounded-xl bg-secondary px-3 text-sm font-semibold"
                    >
                      <span className="truncate">
                        {stylists.find((s) => s.id === l.stylistId)?.name ?? "Stylist"}
                      </span>
                      <ChevronDown className="size-3.5 shrink-0 opacity-70" />
                    </button>
                    {stylistFor === l.key && (
                      <div className="absolute left-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-xl border border-border bg-popover shadow-lift">
                        {[
                          { id: undefined as number | undefined, name: "No stylist" },
                          ...stylists.map((s) => ({ id: s.id, name: s.name })),
                        ].map((opt) => (
                          <button
                            key={String(opt.id)}
                            onClick={() => {
                              const id = opt.id;
                              upd(l.key, { stylistId: id });
                              // An individual pick survives later chips and shows "custom".
                              setCustomStylists((c) => markStylistPick(c, l.key, id, servedBy));
                              setStylistFor(null);
                            }}
                            className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm hover:bg-secondary"
                          >
                            <span className="truncate">{opt.name}</span>
                            {(opt.id ?? null) === (l.stylistId ?? null) && (
                              <Check className="size-4 shrink-0 text-success" />
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {l.kind === "product" &&
                  (() => {
                    const stock = products.find((p) => p.id === l.refId)?.stock ?? 0;
                    return (
                      <span
                        className={`min-w-0 flex-1 truncate text-sm ${
                          l.qty >= stock
                            ? "font-semibold text-destructive"
                            : "text-muted-foreground"
                        }`}
                      >
                        {stock} in stock
                      </span>
                    );
                  })()}
                <div className="ml-auto flex shrink-0 items-center rounded-xl bg-secondary">
                  <button
                    className="grid size-11 place-items-center"
                    onClick={() => upd(l.key, { qty: l.qty - 1 })}
                    aria-label="Less"
                  >
                    <Minus className="size-4" />
                  </button>
                  <span className="w-6 text-center font-semibold">{l.qty}</span>
                  <button
                    className="grid size-11 place-items-center"
                    onClick={() => upd(l.key, { qty: l.qty + 1 })}
                    aria-label="More"
                  >
                    <Plus className="size-4" />
                  </button>
                </div>
                <button
                  onClick={() => removeLine(l.key)}
                  aria-label={`Remove ${l.name}`}
                  className="tap grid size-11 shrink-0 place-items-center rounded-xl bg-secondary text-destructive"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
        {/* Light edge shadows: visible only while lines are hidden by the scroll. */}
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-x-0 top-0 h-5 bg-gradient-to-b from-foreground/10 to-transparent transition-opacity ${
            shadowTop ? "opacity-100" : "opacity-0"
          }`}
        />
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-foreground/10 to-transparent transition-opacity ${
            shadowBottom ? "opacity-100" : "opacity-0"
          }`}
        />
      </div>

      {/* space-y-2 / pt-3 (was space-y-3 / pt-4): at 390×844 the footer must
          leave room for at least three full service lines above it. */}
      <div className="sticky bottom-0 z-10 shrink-0 space-y-2 border-t bg-card pt-3">
        {/* Discount / Tip collapsed into one row; tap to expand the inputs. */}
        <div>
          <button
            onClick={() => setDiscOpen((o) => !o)}
            aria-expanded={discOpen}
            aria-label="Discount / Tip"
            className="tap flex h-11 w-full items-center justify-between gap-2 rounded-xl border border-input bg-card px-3 text-sm"
          >
            <span className="shrink-0 font-semibold">Discount / Tip</span>
            <span className="truncate text-muted-foreground">
              {[
                disc > 0 ? `Discount ${discType === "pct" ? `−${disc}%` : `−${inr(disc)}`}` : "",
                tip > 0 ? `Tip ${inr(tip)}` : "",
              ]
                .filter(Boolean)
                .join(" · ") || "Add"}
            </span>
          </button>
          {discOpen && (
            <div className="mt-2 flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <span className="mb-1 block text-xs font-semibold text-muted-foreground">
                  Discount
                </span>
                <div className="flex min-w-0 items-center rounded-xl border border-input bg-card">
                  <input
                    type="number"
                    min={0}
                    inputMode="decimal"
                    value={disc || ""}
                    onChange={(e) => setDisc(Math.max(0, Number(e.target.value) || 0))}
                    aria-label="Discount"
                    autoFocus
                    className="h-11 w-full min-w-0 bg-transparent px-3 outline-none"
                  />
                  <button
                    onClick={() => setDiscType(discType === "pct" ? "flat" : "pct")}
                    aria-label={discType === "pct" ? "Percent" : "Rupees"}
                    className="h-11 min-w-11 shrink-0 rounded-r-xl bg-secondary px-3 font-semibold"
                  >
                    {discType === "pct" ? "%" : "₹"}
                  </button>
                </div>
              </div>
              <div className="w-24 shrink-0">
                <span className="mb-1 block text-xs font-semibold text-muted-foreground">
                  Tip (Rs)
                </span>
                <input
                  type="number"
                  min={0}
                  inputMode="decimal"
                  value={tip || ""}
                  onChange={(e) => setTip(Math.max(0, Number(e.target.value) || 0))}
                  aria-label="Tip (Rs)"
                  className="h-11 w-full rounded-xl border border-input bg-card px-3 outline-none"
                />
              </div>
            </div>
          )}
        </div>
        <div className="space-y-1 text-sm">
          {totals.subtotal > 0 && <Row k="Subtotal" v={inr(totals.subtotal)} />}
          {totals.discount > 0 && <Row k="Discount" v={`−${inr(totals.discount)}`} />}
          {settings?.gstOn && (
            <>
              <Row k="CGST" v={inr(totals.cgst)} />
              <Row k="SGST" v={inr(totals.sgst)} />
            </>
          )}
          {totals.tip > 0 && <Row k="Tip" v={inr(totals.tip)} />}
        </div>
        <div className="flex items-end justify-between">
          <span className="text-muted-foreground">Total</span>
          <span className="text-3xl font-extrabold tabular-nums">{inr(totals.total)}</span>
        </div>
        <div>
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Payment
          </span>
          <div className="grid grid-cols-4 gap-2">
            {MODES.map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                className={`tap flex items-center justify-center gap-1 rounded-xl py-2 text-sm font-semibold ${
                  mode === m ? "bg-primary text-primary-foreground shadow-soft" : "bg-secondary"
                }`}
              >
                {mode === m && <Check className="size-4 shrink-0" />}
                {m}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={hold}
            title="Hold (F8)"
            className="tap flex shrink-0 flex-col items-center justify-center gap-0.5 rounded-2xl bg-secondary px-3 text-xs font-semibold"
          >
            <Pause className="size-5" />
            Hold
          </button>
          <button
            onClick={() => save("save")}
            disabled={saving}
            title="Save & send bill PDF on WhatsApp"
            className="tap flex min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl bg-accent px-3 text-base font-bold text-accent-foreground shadow-lift disabled:opacity-60"
          >
            <Save className="size-5 shrink-0" />
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            onClick={() => save("print")}
            disabled={saving}
            title="Save & print (F9)"
            className="tap flex min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl bg-primary px-3 text-base font-bold text-primary-foreground shadow-lift disabled:opacity-60"
          >
            <Printer className="size-5 shrink-0" />
            Print
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-[1fr_minmax(340px,420px)]">
        <section className="min-w-0">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="truncate text-sm text-muted-foreground">
                {settings?.salonName ?? "SalonBill"}
              </p>
              <h1 className="text-2xl font-extrabold tracking-tight">Quick Billing</h1>
            </div>
            <div className="relative w-full sm:max-w-xs">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                id="svc-search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search  (F2)"
                className="tap w-full rounded-2xl border border-input bg-card py-3 pl-10 pr-3 outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
            {[
              { id: "all" as const, name: "All" },
              ...cats.map((c) => ({ id: c.id!, name: c.name })),
              { id: "products" as const, name: "Products" },
            ].map((c) => (
              <button
                key={String(c.id)}
                onClick={() => setTab(c.id)}
                className={`tap shrink-0 rounded-full px-5 py-2 text-sm font-semibold ${tab === c.id ? "bg-primary text-primary-foreground" : "bg-card shadow-soft"}`}
              >
                {c.name}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {!services.length &&
              Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-28 animate-pulse rounded-2xl bg-card" />
              ))}
            {items.map((it) => (
              <button
                key={it.kind + it.id}
                onClick={() => add(it)}
                className="tap group flex h-28 flex-col justify-between rounded-2xl bg-card p-4 text-left shadow-soft hover:-translate-y-0.5 hover:shadow-lift"
              >
                <span className="line-clamp-2 font-semibold leading-tight">{it.name}</span>
                <span className="flex items-end justify-between gap-2">
                  <span className="truncate text-xs text-muted-foreground">{it.sub}</span>
                  <span className="shrink-0 text-lg font-bold text-primary">{inr(it.price)}</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        <aside className="sticky top-6 hidden h-[calc(100dvh-3rem)] overflow-hidden rounded-3xl bg-card p-5 shadow-soft lg:block">
          {panel}
        </aside>
      </div>

      {lines.length > 0 && (
        <button
          onClick={() => setSheet(true)}
          className="tap fixed inset-x-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-20 flex items-center justify-between rounded-2xl bg-accent px-5 py-3 font-bold text-accent-foreground shadow-lift lg:hidden"
        >
          <span>{itemQty} items</span>
          <span>{inr(totals.total)} →</span>
        </button>
      )}
      {/* Empty cart + held/unsaved bills: without this entry point the pills
          below are unreachable on phones (they only render inside the sheet,
          and the sheet only opens once a service has been tapped — while
          resuming correctly refuses a non-empty bill). */}
      {lines.length === 0 && (held.length > 0 || orphans.length > 0) && (
        <button
          onClick={() => setSheet(true)}
          className="tap fixed inset-x-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-20 flex items-center justify-between rounded-2xl bg-accent px-5 py-3 font-bold text-accent-foreground shadow-lift lg:hidden"
        >
          <span>
            {[
              held.length ? `${held.length} held` : "",
              orphans.length ? `${orphans.length} unsaved` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <span>Resume →</span>
        </button>
      )}
      {sheet && (
        <div
          className="fixed inset-0 z-40 bg-foreground/40 lg:hidden"
          onClick={() => setSheet(false)}
          role="presentation"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col rounded-t-3xl bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] animate-in slide-in-from-bottom duration-200"
          >
            <div className="mx-auto mb-2 h-1.5 w-12 rounded-full bg-border lg:hidden" />
            {/* Scroll the whole panel when it is taller than the sheet (short
                phones, landscape, keyboard open) so the action footer can stay
                pinned and reachable instead of hanging below the viewport.
                overflow-x-hidden keeps the -mx-1 gutters from forcing a 17px
                horizontal scrollbar that would eat vertical space. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {panel}
            </div>
          </div>
        </div>
      )}

      <PrintPortal>
        {printing && settings && (
          <ReceiptView bill={printing} settings={settings} stylists={stylists} />
        )}
      </PrintPortal>
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between text-muted-foreground">
      <span>{k}</span>
      <span className="tabular-nums text-foreground">{v}</span>
    </div>
  );
}
