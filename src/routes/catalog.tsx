import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Plus, Percent } from "lucide-react";
import { toast } from "sonner";
import { db, logAudit, type Product, type Service, type Stylist } from "@/lib/db";
import { OwnerOnly } from "@/components/PinGate";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { bulkProblem, planBulk, type BulkMode } from "@/lib/bulkPrice";

export const Route = createFileRoute("/catalog")({
  head: () => ({
    meta: [
      { title: "Catalog — SalonBill" },
      { name: "description", content: "Edit salon services, prices, products and stylists." },
      { property: "og:title", content: "Catalog — SalonBill" },
      { property: "og:description", content: "Owner-editable services, products and stylists." },
    ],
  }),
  component: () => (
    <OwnerOnly>
      <Catalog />
    </OwnerOnly>
  ),
});

/* ----------------------------- shared pieces ----------------------------- */

const input =
  "h-11 min-w-0 rounded-xl border border-input bg-card px-3 outline-none focus:ring-2 focus:ring-ring";

/**
 * Every button in a row: exactly 44px tall, label centred horizontally and
 * vertically, never wrapping and never clipped — so Disable / Delete /
 * Earnings can never differ in height or shape (an <a> used to sit taller
 * than the <button>s next to it).
 */
const btnCls =
  "tap inline-flex h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-xl px-3 text-sm font-semibold";
const btn = `${btnCls} bg-secondary`;
const btnAccent = `${btnCls} bg-accent text-accent-foreground`;
const btnDanger = `${btnCls} bg-destructive/10 text-destructive`;

/**
 * ONE grid template per list, shared verbatim by the title row and every data
 * row, with fixed tracks for everything but the name — so a caption like
 * "used in 3 bills" (which used to sit inside the button row) can never push
 * the price/duration boxes sideways or away from their titles.
 *
 * Grid only at lg (1024px) and up: below that the side rail plus the fixed
 * tracks leaves the name column too narrow to be usable, so rows fall back to
 * the card layout (name → caption → labelled fields side by side → one button
 * row) where the per-field labels label themselves and no title row renders.
 */
const colTpl = {
  services: "lg:grid-cols-[minmax(0,1fr)_6rem_7.5rem_5.5rem_5.5rem_7.5rem]",
  products: "lg:grid-cols-[minmax(0,1fr)_6rem_5rem_6.5rem_5.5rem_5.5rem_7.5rem]",
  stylists: "lg:grid-cols-[minmax(0,1fr)_7.5rem_6rem_5.5rem_5.5rem_6rem_7.5rem]",
} as const;
const headCls =
  "hidden gap-2 border-b border-border/60 px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground lg:grid";
/** Titles must never wrap ("Commission %" stays on one line). */
const headCell = "whitespace-nowrap";

/** One labelled field: the label is VISIBLE below lg (where rows are cards
 *  and label themselves) and always present for assistive tech / tests via
 *  aria-label on the input. Add forms pass `always` — their labels show at
 *  every width, because there is no title row to take over. */
function Field({
  label,
  children,
  className = "",
  always = false,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  always?: boolean;
}) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span
        className={`mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground ${always ? "" : "lg:hidden"}`}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

/** Debounce for field edits: one write ~600ms after typing stops. */
const AUTO_SAVE_MS = 600;

/** Per-card auto-save status: "Saving…" → "Saved ✓" → fades out (~2s).
 * The slot is ALWAYS rendered at a fixed width (text-right), so the status
 * can never move or resize the name box next to it while it changes.
 */
function SaveStatus({ status }: { status: "saving" | "saved" | "fading" | "idle" }) {
  const idle = status === "idle";
  return (
    <span
      data-testid="save-status"
      aria-live="polite"
      className={`w-16 shrink-0 text-right text-xs font-semibold transition-opacity duration-500 ${
        status === "saving" || idle ? "text-muted-foreground" : "text-success"
      } ${status === "fading" ? "opacity-0" : "opacity-100"}`}
    >
      {idle ? "" : status === "saving" ? "Saving…" : "Saved ✓"}
    </span>
  );
}

/**
 * Wraps one auto-save write with the card's Saving/Saved/error cycle, plus
 * `schedule()` — the debounce every field edit goes through.
 *
 * Rules it enforces: one write ~AUTO_SAVE_MS after typing stops (never per
 * keystroke, never two writes for one burst), and callers skip scheduling
 * entirely when the value is unchanged, so focus/blur without an edit stays
 * write-free.
 */
function useCardSave() {
  const [status, setStatus] = useState<"saving" | "saved" | "fading" | "idle">("idle");
  const t1 = useRef<number | undefined>(undefined);
  const t2 = useRef<number | undefined>(undefined);
  const timers = useRef(new Map<string, number>());
  useEffect(
    () => () => {
      clearTimeout(t1.current);
      clearTimeout(t2.current);
      for (const t of timers.current.values()) clearTimeout(t);
      timers.current.clear();
    },
    [],
  );
  const run = async (job: () => Promise<unknown>) => {
    clearTimeout(t1.current);
    clearTimeout(t2.current);
    setStatus("saving");
    try {
      await job();
      setStatus("saved");
      t1.current = window.setTimeout(() => setStatus("fading"), 1500);
      t2.current = window.setTimeout(() => setStatus("idle"), 2000);
    } catch (e) {
      console.error("catalog save failed", e);
      setStatus("idle");
      toast.error("Could not save — please try again");
    }
  };
  /** Debounced edit: `AUTO_SAVE_MS` after the last keystroke, exactly one write. */
  const schedule = (key: string, job: () => Promise<unknown>) => {
    const prev = timers.current.get(key);
    if (prev !== undefined) clearTimeout(prev);
    timers.current.set(
      key,
      window.setTimeout(() => {
        timers.current.delete(key);
        void run(job);
      }, AUTO_SAVE_MS),
    );
  };
  return { status, run, schedule };
}

/* ------------------------------ add forms -------------------------------- */

type AddKind = "service" | "product" | "stylist";

/**
 * The ONLY place a new row is created — on Save. Cancel (or an empty name)
 * creates nothing, so there are never blank "New service" rows to clean up.
 * Defaults match what the old instant rows used (GST 18%, commission 10%).
 */
function AddForm({
  kind,
  categoryId,
  onDone,
}: {
  kind: AddKind;
  categoryId?: number | undefined;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [duration, setDuration] = useState("30");
  const [stock, setStock] = useState("0");
  const [low, setLow] = useState("2");
  const [phone, setPhone] = useState("");
  const [commission, setCommission] = useState("10");

  const numVal = (v: string, { int = false } = {}) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return int ? Math.floor(n) : n;
  };
  const valid =
    name.trim().length > 0 &&
    (kind === "service"
      ? numVal(price) !== null && numVal(duration) !== null
      : kind === "product"
        ? numVal(price) !== null &&
          numVal(stock, { int: true }) !== null &&
          numVal(low, { int: true }) !== null
        : numVal(commission) !== null && Number(commission) <= 100);

  const save = async () => {
    if (!valid) {
      toast.error(
        kind === "stylist"
          ? "Name and a commission of 0–100% are needed"
          : "Name and values of zero or more are needed",
      );
      return;
    }
    try {
      if (kind === "service") {
        await db.services.add({
          name: name.trim(),
          categoryId: categoryId!,
          price: numVal(price)!,
          duration: numVal(duration)!,
          gstRate: 18,
          commissionPct: 10,
          active: true,
        });
      } else if (kind === "product") {
        await db.products.add({
          name: name.trim(),
          price: numVal(price)!,
          stock: numVal(stock, { int: true })!,
          lowStock: numVal(low, { int: true })!,
          gstRate: 18,
          active: true,
        });
      } else {
        await db.stylists.add({
          name: name.trim(),
          phone: phone.trim(),
          commissionPct: Math.min(100, numVal(commission)!),
          active: true,
        });
      }
      onDone();
    } catch (e) {
      console.error("catalog add failed", e);
      toast.error("Could not add — please try again");
    }
  };

  const label =
    kind === "service" ? "Service name" : kind === "product" ? "Product name" : "Stylist name";
  // Short reason shown next to Save while it is disabled.
  const reason = !name.trim()
    ? "Enter a name"
    : kind === "service"
      ? numVal(price) === null
        ? "Enter a price"
        : numVal(duration) === null
          ? "Enter a duration"
          : ""
      : kind === "product"
        ? numVal(price) === null
          ? "Enter a price"
          : numVal(stock, { int: true }) === null || numVal(low, { int: true }) === null
            ? "Enter stock numbers"
            : ""
        : numVal(commission) === null || Number(commission) > 100
          ? "Commission must be 0–100%"
          : "";
  return (
    <div className="mt-3 rounded-2xl border border-dashed border-border bg-secondary/40 p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label={label} always>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label={label}
            placeholder={label}
            className={`${input} w-full`}
            autoFocus
          />
        </Field>
        {kind !== "stylist" ? (
          <Field label="Price (₹)" always>
            <input
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              aria-label="Price (₹)"
              placeholder="0"
              className={`${input} w-full`}
            />
          </Field>
        ) : null}
        {kind === "service" && (
          <Field label="Duration (min)" always>
            <input
              type="number"
              min={0}
              inputMode="numeric"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              aria-label="Duration (min)"
              placeholder="30"
              className={`${input} w-full`}
            />
          </Field>
        )}
        {kind === "product" && (
          <>
            <Field label="Stock" always>
              <input
                type="number"
                min={0}
                inputMode="numeric"
                value={stock}
                onChange={(e) => setStock(e.target.value)}
                aria-label="Stock"
                placeholder="0"
                className={`${input} w-full`}
              />
            </Field>
            <Field label="Low-stock alert" always>
              <input
                type="number"
                min={0}
                inputMode="numeric"
                value={low}
                onChange={(e) => setLow(e.target.value)}
                aria-label="Low-stock alert"
                placeholder="2"
                className={`${input} w-full`}
              />
            </Field>
          </>
        )}
        {kind === "stylist" && (
          <>
            <Field label="Phone (optional)" always>
              <input
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                aria-label="Phone (optional)"
                placeholder=""
                className={`${input} w-full`}
              />
            </Field>
            <Field label="Commission %" always>
              <input
                type="number"
                min={0}
                max={100}
                inputMode="numeric"
                value={commission}
                onChange={(e) => setCommission(e.target.value)}
                aria-label="Commission %"
                placeholder="10"
                className={`${input} w-full`}
              />
            </Field>
          </>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {reason && (
          <span
            data-testid="add-reason"
            className="mr-auto text-xs font-medium text-muted-foreground"
          >
            {reason}
          </span>
        )}
        <button onClick={onDone} className={btn}>
          Cancel
        </button>
        <button
          onClick={() => void save()}
          disabled={!valid}
          className={`${btnAccent} disabled:opacity-60`}
        >
          Save
        </button>
      </div>
    </div>
  );
}

/* --------------------------- delete / disable ---------------------------- */

type PendingDelete = {
  kind: AddKind;
  id: number;
  name: string;
  /** How many issued (saved) bills still reference this item. */
  count: number;
};

/**
 * Delete confirmation. Items that appear in saved bills (and therefore in
 * Earnings and exports) are never hard-deleted from here — the dialog offers
 * "Disable instead" and explains why. Unused items delete on confirm; the
 * plain Dexie delete() runs the "deleting" hooks in db.ts, so the change
 * syncs to every device as an ordinary tombstone.
 */
function DeleteDialog({
  pending,
  onCancel,
  onDisable,
  onDelete,
}: {
  pending: PendingDelete | null;
  onCancel: () => void;
  onDisable: (p: PendingDelete) => void;
  onDelete: (p: PendingDelete) => void;
}) {
  const used = (pending?.count ?? 0) > 0;
  const what =
    pending?.kind === "stylist" ? "stylist" : pending?.kind === "product" ? "product" : "service";
  return (
    <Dialog open={!!pending} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {used ? `Disable “${pending?.name}” instead?` : `Delete “${pending?.name}”?`}
          </DialogTitle>
          <DialogDescription>
            {used ? (
              <>
                This {what} is used in{" "}
                <strong>
                  {pending?.count} saved bill
                  {pending?.count === 1 ? "" : "s"}
                </strong>{" "}
                — it shows up in Earnings and in your exports. Deleting would break that history.
                Disabling keeps every past bill intact and only hides it from new bills.
              </>
            ) : (
              <>
                It does not appear in any saved bill, Earnings row or export. Deleting removes it
                everywhere and syncs to every other device.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-end">
          <button onClick={onCancel} className={btn}>
            {used ? "Keep it" : "Cancel"}
          </button>
          {used ? (
            <button onClick={() => pending && onDisable(pending)} className={btnAccent}>
              Disable instead
            </button>
          ) : (
            <button
              onClick={() => pending && onDelete(pending)}
              className="tap shrink-0 rounded-xl bg-destructive px-4 text-sm font-semibold text-destructive-foreground"
            >
              Delete
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------ bulk price ------------------------------- */

/**
 * Re-price a whole category. The preview IS the computation: what you see in
 * the list (`Men's Haircut 300 → 330`) is exactly what `apply` writes, one
 * `db.services.update()` per row, so the normal updating hooks enqueue every
 * change for sync. Bills are never touched — their lines keep the price
 * snapshot taken when they were saved.
 */
function BulkPriceDialog({
  categoryId,
  categoryName,
  services,
  onClose,
}: {
  categoryId: number;
  categoryName: string;
  services: Service[];
  onClose: () => void;
}) {
  const [dir, setDir] = useState<"up" | "down">("up");
  const [unit, setUnit] = useState<"pct" | "inr">("pct");
  const [amount, setAmount] = useState("");
  const [rounding, setRounding] = useState<1 | 5>(1);
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [busy, setBusy] = useState(false);

  const parsed = Number(amount);
  const mode: BulkMode = {
    dir,
    unit,
    amount: amount.trim() !== "" && Number.isFinite(parsed) ? parsed : 0,
    rounding,
    includeDisabled,
  };
  const plan = planBulk(
    services.map((s) => ({ id: s.id!, name: s.name, price: s.price, active: s.active })),
    mode,
  );
  const problem = bulkProblem(mode, plan);
  const skipped =
    services.length - services.filter((s) => includeDisabled || s.active !== false).length;

  const apply = async () => {
    if (problem || busy) return;
    setBusy(true);
    try {
      for (const l of plan) await db.services.update(l.id, { price: l.to });
      await logAudit(
        "service.bulk",
        `${categoryName}: ${dir === "up" ? "+" : "−"}${amount}${unit === "pct" ? "%" : "₹"} → ${plan.length} prices (nearest ₹${rounding})`,
      );
      toast.success(`Updated ${plan.length} prices`);
      onClose();
    } catch (e) {
      console.error("bulk price failed", e);
      toast.error("Could not update the prices — please try again");
    } finally {
      setBusy(false);
    }
  };

  const seg = (active: boolean) =>
    `tap inline-flex h-11 flex-1 items-center justify-center whitespace-nowrap rounded-xl px-3 text-sm font-semibold ${
      active ? "bg-primary text-primary-foreground" : "bg-secondary"
    }`;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Bulk price — {categoryName}</DialogTitle>
          <DialogDescription>
            Increase or decrease every price in this category. Nothing is written until you tap
            Apply, and saved bills keep the prices they were billed at.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setDir("up")}
              aria-pressed={dir === "up"}
              className={seg(dir === "up")}
            >
              Increase
            </button>
            <button
              onClick={() => setDir("down")}
              aria-pressed={dir === "down"}
              className={seg(dir === "down")}
            >
              Decrease
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setUnit("pct")}
              aria-pressed={unit === "pct"}
              className={seg(unit === "pct")}
            >
              %
            </button>
            <button
              onClick={() => setUnit("inr")}
              aria-pressed={unit === "inr"}
              className={seg(unit === "inr")}
            >
              ₹
            </button>
          </div>

          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {unit === "pct" ? "Percent" : "Amount (₹)"}
            </span>
            <input
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label={unit === "pct" ? "Percent" : "Amount (₹)"}
              placeholder={unit === "pct" ? "e.g. 10" : "e.g. 20"}
              autoFocus
              className={`${input} w-full`}
            />
          </label>

          <div>
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Rounding
            </span>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setRounding(1)}
                aria-pressed={rounding === 1}
                className={seg(rounding === 1)}
              >
                Nearest ₹1
              </button>
              <button
                onClick={() => setRounding(5)}
                aria-pressed={rounding === 5}
                className={seg(rounding === 5)}
              >
                Nearest ₹5
              </button>
            </div>
          </div>

          <label className="flex cursor-pointer items-center gap-2.5 text-sm">
            <Checkbox
              checked={includeDisabled}
              onCheckedChange={(v) => setIncludeDisabled(v === true)}
              aria-label="Include disabled services"
              className="size-5"
            />
            Include disabled services ({services.filter((s) => s.active === false).length})
          </label>

          <div className="rounded-2xl bg-secondary p-3">
            <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
              Preview · {plan.length} service{plan.length === 1 ? "" : "s"}
            </div>
            {plan.length ? (
              <ul data-testid="bulk-preview" className="max-h-40 space-y-1 overflow-y-auto text-sm">
                {plan.map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate">{l.name}</span>
                    <span className="shrink-0 tabular-nums">
                      {l.from} → {l.to}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing to change yet.</p>
            )}
            {skipped > 0 && !includeDisabled && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                {skipped} disabled service{skipped === 1 ? "" : "s"} skipped
              </p>
            )}
          </div>

          {problem && (
            <p data-testid="bulk-problem" className="text-sm font-medium text-destructive">
              {problem}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-end">
          <button onClick={onClose} className={btn}>
            Cancel
          </button>
          <button
            onClick={() => void apply()}
            disabled={!!problem || busy}
            className={`${btnAccent} disabled:opacity-60`}
          >
            {busy ? "Applying…" : `Apply to ${plan.length} service${plan.length === 1 ? "" : "s"}`}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------- rows ---------------------------------- */

export function ServiceRow({
  s,
  usedCount,
  onDeleteClick,
}: {
  s: Service;
  usedCount: number;
  onDeleteClick: () => void;
}) {
  const { status, run, schedule } = useCardSave();
  // Controlled price box: typing never fights the stored value, while a price
  // changed SOMEWHERE ELSE (bulk price dialog, another device's sync) is
  // adopted immediately — the old `defaultValue` input kept showing the price
  // from page load until a full reload.
  const [priceText, setPriceText] = useState(() => String(s.price));
  const [prevPrice, setPrevPrice] = useState(s.price);
  if (prevPrice !== s.price) {
    setPrevPrice(s.price);
    if (priceText === String(prevPrice)) setPriceText(String(s.price));
  }
  return (
    <div
      className={`grid grid-cols-1 gap-2 border-b border-border/50 px-1 py-3 last:border-0 lg:items-center lg:gap-2 lg:py-2 ${colTpl.services} ${s.active ? "" : "opacity-60"}`}
    >
      {/* 1 — name: first row of the card, first track of the grid */}
      <div className="order-1 flex min-w-0 items-center gap-2 lg:order-none">
        <input
          defaultValue={s.name}
          aria-label="Service name"
          onChange={(e) => {
            const v = e.target.value.trim();
            if (v && v !== s.name) schedule("name", () => db.services.update(s.id!, { name: v }));
          }}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (!v) e.currentTarget.value = s.name; // blank names never stick
          }}
          className={`${input} min-w-0 flex-1`}
        />
        <SaveStatus status={status} />
      </div>
      {/* 3 — labelled fields: side by side on cards, one fixed track each at lg */}
      <div className="order-3 grid grid-cols-2 gap-2 lg:order-none lg:contents">
        <Field label="Price (₹)">
          <input
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={priceText}
            aria-label="Price (₹)"
            placeholder="0"
            onChange={(e) => {
              const raw = e.target.value;
              setPriceText(raw);
              const v = Number(raw);
              if (raw === "" || !Number.isFinite(v) || v < 0) return; // wait for a valid value
              if (v === s.price) return; // unchanged → no write
              schedule("price", async () => {
                await db.services.update(s.id!, { price: v });
                await logAudit("service.price", `${s.name}: ${s.price} → ${v}`);
              });
            }}
            onBlur={() => {
              const v = Number(priceText);
              if (priceText.trim() === "" || !Number.isFinite(v) || v < 0) {
                setPriceText(String(s.price)); // never leave an invalid box
                toast.error("Price must be zero or more");
              }
            }}
            className={`${input} w-full`}
          />
        </Field>
        <Field label="Duration (min)">
          <input
            type="number"
            min={0}
            inputMode="numeric"
            defaultValue={s.duration > 0 ? s.duration : ""}
            aria-label="Duration (min)"
            placeholder="min"
            onChange={(e) => {
              const raw = e.target.value;
              const n = raw === "" ? 0 : Number(raw);
              if (!Number.isFinite(n) || n < 0) return;
              if (n === s.duration) return; // unchanged → no write
              schedule("duration", () => db.services.update(s.id!, { duration: n }));
            }}
            onBlur={(e) => {
              const n = Number(e.target.value || 0);
              if (!Number.isFinite(n) || n < 0) e.currentTarget.value = String(s.duration);
            }}
            className={`${input} w-full`}
          />
        </Field>
      </div>
      {/* 4 — one button row on cards, one fixed track each at lg */}
      <div className="order-4 flex items-center gap-2 lg:order-none lg:contents">
        <button
          onClick={() => void run(() => db.services.update(s.id!, { active: !s.active }))}
          className={btn}
        >
          {s.active ? "Disable" : "Enable"}
        </button>
        <button onClick={onDeleteClick} className={btnDanger}>
          Delete
        </button>
      </div>
      {/* 2 — caption under the name on cards, its own fixed track at lg */}
      {usedCount > 0 && (
        <span className="order-2 text-[11px] text-muted-foreground lg:order-none">
          used in {usedCount} bill{usedCount === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}

function ProductRow({
  p,
  usedCount,
  onDeleteClick,
}: {
  p: Product;
  usedCount: number;
  onDeleteClick: () => void;
}) {
  const { status, run, schedule } = useCardSave();
  // Same external-change adoption as the service row — see the price box note.
  const [priceText, setPriceText] = useState(() => String(p.price));
  const [prevPrice, setPrevPrice] = useState(p.price);
  if (prevPrice !== p.price) {
    setPrevPrice(p.price);
    if (priceText === String(prevPrice)) setPriceText(String(p.price));
  }
  return (
    <div
      className={`grid grid-cols-1 gap-2 border-b border-border/50 px-1 py-3 last:border-0 lg:items-center lg:gap-2 lg:py-2 ${colTpl.products} ${p.active ? "" : "opacity-60"}`}
    >
      <div className="order-1 flex min-w-0 items-center gap-2 lg:order-none">
        <input
          defaultValue={p.name}
          aria-label="Product name"
          onChange={(e) => {
            const v = e.target.value.trim();
            if (v && v !== p.name) schedule("name", () => db.products.update(p.id!, { name: v }));
          }}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (!v) e.currentTarget.value = p.name;
          }}
          className={`${input} min-w-0 flex-1`}
        />
        <SaveStatus status={status} />
      </div>
      <div className="order-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:order-none lg:contents">
        <Field label="Price (₹)">
          <input
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={priceText}
            aria-label="Price (₹)"
            placeholder="0"
            onChange={(e) => {
              const raw = e.target.value;
              setPriceText(raw);
              const v = Number(raw);
              if (raw === "" || !Number.isFinite(v) || v < 0) return;
              if (v === p.price) return;
              schedule("price", () => db.products.update(p.id!, { price: v }));
            }}
            onBlur={() => {
              const v = Number(priceText);
              if (priceText.trim() === "" || !Number.isFinite(v) || v < 0) {
                setPriceText(String(p.price));
                toast.error("Price must be zero or more");
              }
            }}
            className={`${input} w-full`}
          />
        </Field>
        <Field label="Stock">
          <input
            type="number"
            min={0}
            inputMode="numeric"
            defaultValue={p.stock}
            aria-label="Stock"
            onChange={(e) => {
              const n = Math.floor(Number(e.target.value));
              if (!Number.isFinite(n) || n < 0) return;
              if (n === p.stock) return;
              schedule("stock", () => db.products.update(p.id!, { stock: n }));
            }}
            onBlur={(e) => {
              const n = Math.floor(Number(e.target.value));
              if (!Number.isFinite(n) || n < 0) e.currentTarget.value = String(p.stock);
            }}
            className={`${input} w-full ${p.stock <= p.lowStock ? "border-destructive text-destructive" : ""}`}
          />
        </Field>
        <Field label="Low-stock alert">
          <input
            type="number"
            min={0}
            inputMode="numeric"
            defaultValue={p.lowStock}
            aria-label="Low-stock alert"
            onChange={(e) => {
              const n = Math.floor(Number(e.target.value));
              if (!Number.isFinite(n) || n < 0) return;
              if (n === p.lowStock) return;
              schedule("low", () => db.products.update(p.id!, { lowStock: n }));
            }}
            onBlur={(e) => {
              const n = Math.floor(Number(e.target.value));
              if (!Number.isFinite(n) || n < 0) e.currentTarget.value = String(p.lowStock);
            }}
            className={`${input} w-full`}
          />
        </Field>
      </div>
      <div className="order-4 flex items-center gap-2 lg:order-none lg:contents">
        <button
          onClick={() => void run(() => db.products.update(p.id!, { active: !p.active }))}
          className={btn}
        >
          {p.active ? "Disable" : "Enable"}
        </button>
        <button onClick={onDeleteClick} className={btnDanger}>
          Delete
        </button>
      </div>
      {usedCount > 0 && (
        <span className="order-2 text-[11px] text-muted-foreground lg:order-none">
          used in {usedCount} bill{usedCount === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}

function StylistRow({
  s,
  usedCount,
  onDeleteClick,
}: {
  s: Stylist;
  usedCount: number;
  onDeleteClick: () => void;
}) {
  const { status, run, schedule } = useCardSave();
  return (
    <div
      className={`grid grid-cols-1 gap-2 border-b border-border/50 px-1 py-3 last:border-0 lg:items-center lg:gap-2 lg:py-2 ${colTpl.stylists} ${s.active ? "" : "opacity-60"}`}
    >
      <div className="order-1 flex min-w-0 items-center gap-2 lg:order-none">
        <input
          defaultValue={s.name}
          aria-label="Name"
          onChange={(e) => {
            const v = e.target.value.trim();
            if (v && v !== s.name) schedule("name", () => db.stylists.update(s.id!, { name: v }));
          }}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (!v) e.currentTarget.value = s.name;
          }}
          className={`${input} min-w-0 flex-1`}
        />
        <SaveStatus status={status} />
      </div>
      <div className="order-3 grid grid-cols-2 gap-2 lg:order-none lg:contents">
        <Field label="Phone (optional)">
          <input
            inputMode="tel"
            defaultValue={s.phone}
            aria-label="Phone (optional)"
            onChange={(e) => {
              const v = e.target.value.trim();
              if (v !== s.phone) schedule("phone", () => db.stylists.update(s.id!, { phone: v }));
            }}
            className={`${input} w-full`}
          />
        </Field>
        <Field label="Commission %">
          <input
            type="number"
            min={0}
            max={100}
            inputMode="numeric"
            defaultValue={s.commissionPct}
            aria-label="Commission %"
            onChange={(e) => {
              const n = Number(e.target.value);
              if (!Number.isFinite(n) || n < 0 || n > 100) return;
              if (n === s.commissionPct) return;
              schedule("commission", () => db.stylists.update(s.id!, { commissionPct: n }));
            }}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (!Number.isFinite(n) || n < 0 || n > 100)
                e.currentTarget.value = String(s.commissionPct);
            }}
            className={`${input} w-full`}
          />
        </Field>
      </div>
      <div className="order-4 flex items-center gap-2 lg:order-none lg:contents">
        <button
          onClick={() => void run(() => db.stylists.update(s.id!, { active: !s.active }))}
          className={btn}
        >
          {s.active ? "Disable" : "Enable"}
        </button>
        <button onClick={onDeleteClick} className={btnDanger}>
          Delete
        </button>
        <Link to="/earnings" search={{ stylist: s.id ?? 0 }} className={btnAccent}>
          Earnings
        </Link>
      </div>
      {usedCount > 0 && (
        <span className="order-2 text-[11px] text-muted-foreground lg:order-none">
          used in {usedCount} bill{usedCount === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}

/* -------------------------------- screen --------------------------------- */

export function Catalog() {
  const cats = useLiveQuery(() => db.categories.orderBy("order").toArray(), []) ?? [];
  const services = useLiveQuery(() => db.services.toArray(), []) ?? [];
  const products = useLiveQuery(() => db.products.toArray(), []) ?? [];
  const stylists = useLiveQuery(() => db.stylists.toArray(), []) ?? [];
  // Issued bills only (held drafts are device-local and not history).
  const issued = useLiveQuery(() => db.bills.where("status").notEqual("held").toArray(), []) ?? [];
  const [tab, setTab] = useState<"services" | "products" | "stylists">("services");
  const [adding, setAdding] = useState<{ kind: AddKind; categoryId?: number } | null>(null);
  const [pending, setPending] = useState<PendingDelete | null>(null);
  const [bulkCat, setBulkCat] = useState<{ id: number; name: string } | null>(null);

  // One pass: how many saved bills reference each item (services/products by
  // line refId, stylists by line attribution or as cashier). Anything > 0 is
  // part of Earnings/export history → deleting is refused, disabling offered.
  const counts = (() => {
    const svc = new Map<number, number>();
    const prod = new Map<number, number>();
    const sty = new Map<number, number>();
    for (const b of issued) {
      const seenS = new Set<number>();
      const seenP = new Set<number>();
      const seenY = new Set<number>();
      for (const l of b.lines ?? []) {
        if (l.kind === "service" && typeof l.refId === "number" && !seenS.has(l.refId)) {
          seenS.add(l.refId);
          svc.set(l.refId, (svc.get(l.refId) ?? 0) + 1);
        }
        if (l.kind === "product" && typeof l.refId === "number" && !seenP.has(l.refId)) {
          seenP.add(l.refId);
          prod.set(l.refId, (prod.get(l.refId) ?? 0) + 1);
        }
        if (typeof l.stylistId === "number" && !seenY.has(l.stylistId)) {
          seenY.add(l.stylistId);
          sty.set(l.stylistId, (sty.get(l.stylistId) ?? 0) + 1);
        }
      }
      if (typeof b.cashierId === "number" && !seenY.has(b.cashierId)) {
        sty.set(b.cashierId, (sty.get(b.cashierId) ?? 0) + 1);
      }
    }
    return { svc, prod, sty };
  })();

  /**
   * Bulk price used to be `prompt("…by %")` + a direct Dexie `modify()`:
   * the numbers DID change in the database, but every price box is an
   * uncontrolled `defaultValue` input, so the list kept rendering the old
   * value until a full reload — and with no preview, no confirmation and an
   * unhandled rejection path, any failure was silent too. It is now a dialog
   * that shows exactly what will change before it writes it.
   */
  const askDelete = (kind: AddKind, id: number | undefined, name: string, count: number) => {
    if (id === undefined) return;
    setPending({ kind, id, name, count });
  };
  const doDelete = async (p: PendingDelete) => {
    setPending(null);
    try {
      // Plain per-row Dexie delete → the "deleting" hooks in db.ts enqueue the
      // row → the outbox pushes `op: "del"` — an ordinary tombstone.
      if (p.kind === "service") await db.services.delete(p.id);
      else if (p.kind === "product") await db.products.delete(p.id);
      else await db.stylists.delete(p.id);
      await logAudit(`${p.kind}.delete`, p.name);
      toast.success(`${p.name} deleted`);
    } catch (e) {
      console.error("catalog delete failed", e);
      toast.error("Could not delete — please try again");
    }
  };
  const doDisable = async (p: PendingDelete) => {
    setPending(null);
    try {
      if (p.kind === "service") await db.services.update(p.id, { active: false });
      else if (p.kind === "product") await db.products.update(p.id, { active: false });
      else await db.stylists.update(p.id, { active: false });
      toast.success(`${p.name} disabled — history stays intact`);
    } catch (e) {
      console.error("catalog disable failed", e);
      toast.error("Could not disable — please try again");
    }
  };

  const addBtn = (kind: AddKind, categoryId?: number, label = "Add") => (
    <button
      onClick={() => setAdding(categoryId === undefined ? { kind } : { kind, categoryId })}
      className="tap flex h-11 shrink-0 items-center gap-1 rounded-xl bg-accent px-3 text-sm font-semibold text-accent-foreground"
    >
      <Plus className="size-4" />
      {label}
    </button>
  );

  const emptyRow = (text: string, kind: AddKind, categoryId?: number) => (
    <div className="rounded-2xl border border-dashed p-6 text-center">
      <p className="text-sm text-muted-foreground">{text}</p>
      <div className="mt-3 flex justify-center">{addBtn(kind, categoryId)}</div>
    </div>
  );

  return (
    <div className="pb-32 md:pb-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-extrabold tracking-tight">Catalog</h1>
        <div className="flex rounded-2xl bg-card p-1 shadow-soft">
          {(["services", "products", "stylists"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`tap rounded-xl px-4 text-sm font-semibold capitalize ${tab === t ? "bg-primary text-primary-foreground" : ""}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {tab === "services" && (
        <div className="space-y-6">
          {cats.map((c) => {
            const rows = services.filter((s) => s.categoryId === c.id);
            return (
              <section key={c.id} className="rounded-3xl bg-card p-4 shadow-soft sm:p-5">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-lg font-bold">{c.name}</h2>
                  <div className="flex gap-2">
                    <button onClick={() => setBulkCat({ id: c.id!, name: c.name })} className={btn}>
                      <Percent className="size-4" />
                      Bulk price
                    </button>
                    {adding?.categoryId !== c.id && rows.length > 0 && addBtn("service", c.id)}
                  </div>
                </div>
                {rows.length > 0 && (
                  <div className={`${headCls} ${colTpl.services}`}>
                    <span className={headCell}>Service name</span>
                    <span className={headCell}>Price (₹)</span>
                    <span className={headCell}>Duration (min)</span>
                    <span className={headCell}>Disable</span>
                    <span className={headCell}>Delete</span>
                    <span />
                  </div>
                )}
                {adding?.kind === "service" && adding.categoryId === c.id && (
                  <AddForm kind="service" categoryId={c.id} onDone={() => setAdding(null)} />
                )}
                {rows.length ? (
                  <div>
                    {rows.map((s) => (
                      <ServiceRow
                        key={s.id}
                        s={s}
                        usedCount={counts.svc.get(s.id!) ?? 0}
                        onDeleteClick={() =>
                          askDelete("service", s.id, s.name, counts.svc.get(s.id!) ?? 0)
                        }
                      />
                    ))}
                  </div>
                ) : (
                  !(adding?.kind === "service" && adding.categoryId === c.id) &&
                  emptyRow("No services yet", "service", c.id)
                )}
              </section>
            );
          })}
          <button
            onClick={() => {
              const name = prompt("Category name?");
              if (name) db.categories.add({ name, order: cats.length });
            }}
            className="tap w-full rounded-3xl border-2 border-dashed py-3 text-muted-foreground"
          >
            + Add category
          </button>
        </div>
      )}

      {tab === "products" && (
        <section className="rounded-3xl bg-card p-4 shadow-soft sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-bold">Products</h2>
            {adding?.kind !== "product" &&
              products.length > 0 &&
              addBtn("product", undefined, "Add product")}
          </div>
          {products.length > 0 && (
            <div className={`${headCls} ${colTpl.products}`}>
              <span className={headCell}>Product name</span>
              <span className={headCell}>Price (₹)</span>
              <span className={headCell}>Stock</span>
              <span className={headCell}>Low-stock alert</span>
              <span className={headCell}>Disable</span>
              <span className={headCell}>Delete</span>
              <span />
            </div>
          )}
          {adding?.kind === "product" && <AddForm kind="product" onDone={() => setAdding(null)} />}
          {products.length ? (
            <div>
              {products.map((p) => (
                <ProductRow
                  key={p.id}
                  p={p}
                  usedCount={counts.prod.get(p.id!) ?? 0}
                  onDeleteClick={() =>
                    askDelete("product", p.id, p.name, counts.prod.get(p.id!) ?? 0)
                  }
                />
              ))}
            </div>
          ) : (
            !(adding?.kind === "product") && emptyRow("No products yet", "product")
          )}
        </section>
      )}

      {tab === "stylists" && (
        <section className="rounded-3xl bg-card p-4 shadow-soft sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-bold">Stylists</h2>
            {adding?.kind !== "stylist" &&
              stylists.length > 0 &&
              addBtn("stylist", undefined, "Add stylist")}
          </div>
          {stylists.length > 0 && (
            <div className={`${headCls} ${colTpl.stylists}`}>
              <span className={headCell}>Name</span>
              <span className={headCell}>Phone</span>
              <span className={headCell}>Commission %</span>
              <span className={headCell}>Disable</span>
              <span className={headCell}>Delete</span>
              <span className={headCell}>Earnings</span>
              <span />
            </div>
          )}
          {adding?.kind === "stylist" && <AddForm kind="stylist" onDone={() => setAdding(null)} />}
          {stylists.length ? (
            <div>
              {stylists.map((s) => (
                <StylistRow
                  key={s.id}
                  s={s}
                  usedCount={counts.sty.get(s.id!) ?? 0}
                  onDeleteClick={() =>
                    askDelete("stylist", s.id, s.name, counts.sty.get(s.id!) ?? 0)
                  }
                />
              ))}
            </div>
          ) : (
            !(adding?.kind === "stylist") && emptyRow("No stylists yet", "stylist")
          )}
        </section>
      )}

      <DeleteDialog
        pending={pending}
        onCancel={() => setPending(null)}
        onDisable={(p) => void doDisable(p)}
        onDelete={(p) => void doDelete(p)}
      />
      {bulkCat && (
        <BulkPriceDialog
          categoryId={bulkCat.id}
          categoryName={bulkCat.name}
          services={services.filter((s) => s.categoryId === bulkCat.id)}
          onClose={() => setBulkCat(null)}
        />
      )}
    </div>
  );
}
