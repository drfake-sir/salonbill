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
const btn = "tap shrink-0 rounded-xl bg-secondary px-3 text-sm font-semibold";
const btnAccent =
  "tap shrink-0 rounded-xl bg-accent px-3 text-sm font-semibold text-accent-foreground";
const btnDanger =
  "tap shrink-0 rounded-xl bg-destructive/10 px-3 text-sm font-semibold text-destructive";
const colTpl = {
  services: "sm:grid-cols-[minmax(0,1fr)_6rem_6rem_auto]",
  products: "sm:grid-cols-[minmax(0,1fr)_6rem_5rem_6.5rem_auto]",
  stylists: "sm:grid-cols-[minmax(0,1fr)_7.5rem_5.5rem_auto]",
} as const;
const headCls =
  "hidden gap-2 border-b border-border/60 px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground sm:grid";

/** One labelled field: the label is VISIBLE on phones (hidden on wide rows,
 *  where the column header above labels the same box) and always present for
 *  assistive tech / tests via aria-label on the input. */
function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground sm:hidden">
        {label}
      </span>
      {children}
    </label>
  );
}

/** Per-card auto-save status: "Saving…" → "Saved ✓" → fades out (~2s). */
function SaveStatus({ status }: { status: "saving" | "saved" | "fading" | "idle" }) {
  if (status === "idle") return null;
  return (
    <span
      data-testid="save-status"
      aria-live="polite"
      className={`shrink-0 text-xs font-semibold transition-opacity duration-500 ${
        status === "saving" ? "text-muted-foreground" : "text-success"
      } ${status === "fading" ? "opacity-0" : "opacity-100"}`}
    >
      {status === "saving" ? "Saving…" : "Saved ✓"}
    </span>
  );
}

/** Wraps one auto-save write with the card's Saving/Saved/error cycle. */
function useCardSave() {
  const [status, setStatus] = useState<"saving" | "saved" | "fading" | "idle">("idle");
  const t1 = useRef<number | undefined>(undefined);
  const t2 = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(t1.current);
      clearTimeout(t2.current);
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
  return { status, run };
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
  return (
    <div className="mt-3 rounded-2xl border border-dashed border-border bg-secondary/40 p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label={label}>
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
          <Field label="Price (₹)">
            <input
              type="number"
              min={0}
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
          <Field label="Duration (min)">
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
            <Field label="Stock">
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
            <Field label="Low-stock alert">
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
            <Field label="Phone (optional)">
              <input
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                aria-label="Phone (optional)"
                placeholder=""
                className={`${input} w-full`}
              />
            </Field>
            <Field label="Commission %">
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
      <div className="mt-3 flex flex-wrap justify-end gap-2">
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

/* --------------------------------- rows ---------------------------------- */

function ServiceRow({
  s,
  usedCount,
  onDeleteClick,
}: {
  s: Service;
  usedCount: number;
  onDeleteClick: () => void;
}) {
  const { status, run } = useCardSave();
  const setPrice = async (price: number) => {
    if (price === s.price) return;
    if (!Number.isFinite(price) || price < 0) {
      toast.error("Price must be zero or more");
      return;
    }
    await run(async () => {
      await db.services.update(s.id!, { price });
      await logAudit("service.price", `${s.name}: ${s.price} → ${price}`);
    });
  };
  return (
    <div
      className={`grid grid-cols-1 gap-2 border-b border-border/50 px-1 py-3 last:border-0 sm:items-center sm:gap-2 sm:py-2 ${colTpl.services} ${s.active ? "" : "opacity-60"}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <input
          defaultValue={s.name}
          aria-label="Service name"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (!v) {
              e.currentTarget.value = s.name; // blank names never stick
              return;
            }
            if (v !== s.name) void run(() => db.services.update(s.id!, { name: v }));
          }}
          className={`${input} min-w-0 flex-1`}
        />
        <SaveStatus status={status} />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:contents">
        <Field label="Price (₹)">
          <input
            type="number"
            min={0}
            inputMode="decimal"
            defaultValue={s.price}
            aria-label="Price (₹)"
            onBlur={(e) => void setPrice(Number(e.target.value))}
            className={`${input} w-full`}
          />
        </Field>
        <Field label="Duration (min)">
          <input
            type="number"
            min={0}
            inputMode="numeric"
            defaultValue={s.duration}
            aria-label="Duration (min)"
            onBlur={(e) => {
              const v = Math.max(0, Number(e.target.value));
              if (Number.isFinite(v)) void run(() => db.services.update(s.id!, { duration: v }));
            }}
            className={`${input} w-full`}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <button
          onClick={() => void run(() => db.services.update(s.id!, { active: !s.active }))}
          className={btn}
        >
          {s.active ? "Disable" : "Enable"}
        </button>
        <button onClick={onDeleteClick} className={btnDanger}>
          Delete
        </button>
        {usedCount > 0 && (
          <span className="w-full text-[11px] text-muted-foreground sm:w-auto">
            used in {usedCount} bill{usedCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
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
  const { status, run } = useCardSave();
  return (
    <div
      className={`grid grid-cols-1 gap-2 border-b border-border/50 px-1 py-3 last:border-0 sm:items-center sm:gap-2 sm:py-2 ${colTpl.products} ${p.active ? "" : "opacity-60"}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <input
          defaultValue={p.name}
          aria-label="Product name"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (!v) {
              e.currentTarget.value = p.name;
              return;
            }
            if (v !== p.name) void run(() => db.products.update(p.id!, { name: v }));
          }}
          className={`${input} min-w-0 flex-1`}
        />
        <SaveStatus status={status} />
      </div>
      <div className="grid grid-cols-3 gap-1.5 sm:contents">
        <Field label="Price (₹)">
          <input
            type="number"
            min={0}
            inputMode="decimal"
            defaultValue={p.price}
            aria-label="Price (₹)"
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0)
                void run(() => db.products.update(p.id!, { price: v }));
              else toast.error("Price must be zero or more");
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
            onBlur={(e) => {
              const v = Math.max(0, Math.floor(Number(e.target.value)));
              if (Number.isFinite(v)) void run(() => db.products.update(p.id!, { stock: v }));
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
            onBlur={(e) => {
              const v = Math.max(0, Math.floor(Number(e.target.value)));
              if (Number.isFinite(v)) void run(() => db.products.update(p.id!, { lowStock: v }));
            }}
            className={`${input} w-full`}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <button
          onClick={() => void run(() => db.products.update(p.id!, { active: !p.active }))}
          className={btn}
        >
          {p.active ? "Disable" : "Enable"}
        </button>
        <button onClick={onDeleteClick} className={btnDanger}>
          Delete
        </button>
        {usedCount > 0 && (
          <span className="w-full text-[11px] text-muted-foreground sm:w-auto">
            used in {usedCount} bill{usedCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
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
  const { status, run } = useCardSave();
  return (
    <div
      className={`grid grid-cols-1 gap-2 border-b border-border/50 px-1 py-3 last:border-0 sm:items-center sm:gap-2 sm:py-2 ${colTpl.stylists} ${s.active ? "" : "opacity-60"}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <input
          defaultValue={s.name}
          aria-label="Name"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (!v) {
              e.currentTarget.value = s.name;
              return;
            }
            if (v !== s.name) void run(() => db.stylists.update(s.id!, { name: v }));
          }}
          className={`${input} min-w-0 flex-1`}
        />
        <SaveStatus status={status} />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:contents">
        <Field label="Phone (optional)">
          <input
            inputMode="tel"
            defaultValue={s.phone}
            aria-label="Phone (optional)"
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== s.phone) void run(() => db.stylists.update(s.id!, { phone: v }));
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
            onBlur={(e) => {
              const v = Math.min(100, Math.max(0, Number(e.target.value) || 0));
              void run(() => db.stylists.update(s.id!, { commissionPct: v }));
            }}
            className={`${input} w-full`}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
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
        {usedCount > 0 && (
          <span className="w-full text-[11px] text-muted-foreground sm:w-auto">
            used in {usedCount} bill{usedCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
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

  const bulk = async (categoryId: number) => {
    const pct = Number(prompt("Change prices in this category by % (e.g. 10 or -5)"));
    if (!Number.isFinite(pct) || !pct) return;
    await db.services
      .where("categoryId")
      .equals(categoryId)
      .modify((s) => {
        s.price = Math.max(0, Math.round(s.price * (1 + pct / 100)));
      });
    await logAudit("service.bulk", `category ${categoryId}: ${pct}%`);
    toast.success(`Prices updated by ${pct}%`);
  };

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
      className="tap flex shrink-0 items-center gap-1 rounded-xl bg-accent px-3 text-sm font-semibold text-accent-foreground"
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
                    <button
                      onClick={() => void bulk(c.id!)}
                      className={`tap flex items-center gap-1 ${btn}`}
                    >
                      <Percent className="size-4" />
                      Bulk price
                    </button>
                    {adding?.categoryId !== c.id && rows.length > 0 && addBtn("service", c.id)}
                  </div>
                </div>
                <div className={`${headCls} ${colTpl.services}`}>
                  <span>Service name</span>
                  <span>Price (₹)</span>
                  <span>Duration (min)</span>
                  <span />
                </div>
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
          <div className={`${headCls} ${colTpl.products}`}>
            <span>Product name</span>
            <span>Price (₹)</span>
            <span>Stock</span>
            <span>Low-stock alert</span>
            <span />
          </div>
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
          <div className={`${headCls} ${colTpl.stylists}`}>
            <span>Name</span>
            <span>Phone</span>
            <span>Commission %</span>
            <span />
          </div>
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
    </div>
  );
}
