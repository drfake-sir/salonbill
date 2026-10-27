import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { logAudit } from "@/lib/db";
import {
  NO_REMOVAL,
  findDemoRows,
  removeDemoData,
  type DemoScan,
  type RemoveSelection,
} from "@/lib/demoData";

/**
 * "Remove demo data" as THREE separate, unticked-by-default actions.
 *
 * Nothing is ever removed because this card exists: each box has to be ticked
 * by hand, the Remove button is disabled until at least one is ticked, and the
 * selected action still gets its own confirmation, its automatic local backup
 * first, and the real-bills refusal — the same guards as before, just scoped
 * to what the owner actually chose. Deletions ride the normal per-row Dexie
 * path, so they sync as ordinary tombstones.
 *
 * Used by BOTH the first-run setup screen and Settings → Demo data, so the
 * two can never drift apart.
 */

const ACTIONS: {
  key: keyof RemoveSelection;
  label: string;
  hint: string;
  testid: string;
}[] = [
  {
    key: "customers",
    label: "Remove demo customers (fake people)",
    hint: "The six trial customers seeded on a new install.",
    testid: "remove-customers",
  },
  {
    key: "staff",
    label: "Remove starter staff",
    hint: "The seeded stylists — Karthik, Priya, Arun, Divya.",
    testid: "remove-staff",
  },
  {
    key: "catalog",
    label: "Clear starter services and products",
    hint: "The seeded price list. Rows you added or renamed are kept.",
    testid: "remove-catalog",
  },
];

export function DemoCleanup() {
  const [sel, setSel] = useState<RemoveSelection>(NO_REMOVAL);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<DemoScan | null>(null);
  const [realBills, setRealBills] = useState(false);
  const ticked = ACTIONS.some((a) => sel[a.key]);

  // Read-only preflight: show how much of each kind is actually still here,
  // and warn up front (not just via toast) when real bills block removal.
  const refresh = useCallback(async () => {
    try {
      const r = await findDemoRows();
      setFound(r.scan);
      setRealBills(r.realBills);
    } catch (e) {
      console.error("demo preflight failed", e);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const countFor = (k: keyof RemoveSelection): number | null => {
    if (!found) return null;
    if (k === "customers") return found.customers.length;
    if (k === "staff") return found.stylists.length;
    return found.services.length + found.products.length;
  };

  const run = async () => {
    if (busy || !ticked) return;
    setBusy(true);
    try {
      const r = await removeDemoData(sel);
      if (r.ok) {
        const bits: string[] = [];
        if (sel.staff) bits.push(`${r.removed.stylists.length} staff`);
        if (sel.catalog)
          bits.push(`${r.removed.services.length} services, ${r.removed.products.length} products`);
        if (sel.customers) bits.push(`${r.removed.customers.length} customers`);
        // Same audit trail Settings used to write by hand: one row per run.
        await logAudit("demo.remove", bits.join(", "));
        toast.success(`Removed ${bits.join(", ")} — backup downloaded first`);
        setSel(NO_REMOVAL); // boxes go back to unticked
        await refresh(); // counts go back to what is really left
      } else if (r.reason === "real-bills") {
        toast.error("This salon has real bills — demo data was NOT removed.");
      } else if (r.reason === "backup-failed") {
        toast.error("Could not save a safety backup — nothing was removed.");
      } else if (r.reason === "no-demo") {
        toast.info("None of that is on this device any more.");
      }
      // "declined" / "nothing-selected" → silent
    } catch (e) {
      console.error("demo cleanup failed", e);
      toast.error("Could not remove the demo data — nothing was changed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Tick only what you want gone. Each removal is confirmed, a local backup is downloaded first,
        and it is refused if any real bill exists. Deletions sync to every device as normal
        tombstones.
      </p>
      {realBills && (
        <p
          data-testid="demo-real-bills"
          className="rounded-xl bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive"
        >
          This salon already has real bills, so demo removal will be refused. Nothing here can touch
          your bills.
        </p>
      )}
      <ul className="space-y-2.5">
        {ACTIONS.map((a) => {
          const n = countFor(a.key);
          const where =
            n === null ? "" : n === 0 ? " · none left on this device" : ` · ${n} still here`;
          return (
            <li key={a.key}>
              <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                <Checkbox
                  checked={sel[a.key]}
                  onCheckedChange={(v) => setSel((s) => ({ ...s, [a.key]: v === true }))}
                  aria-label={a.label}
                  data-testid={a.testid}
                  className="mt-0.5 size-5"
                />
                <span className="min-w-0">
                  <span className="block font-medium">{a.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {a.hint}
                    <span data-testid={`${a.testid}-count`}>{where}</span>
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <button
        onClick={() => void run()}
        disabled={!ticked || busy}
        data-testid="remove-demo-run"
        className="tap flex w-full items-center justify-center gap-2 rounded-xl bg-secondary px-4 py-2.5 font-semibold disabled:opacity-60"
      >
        <Trash2 className="size-4" />
        {busy ? "Removing…" : "Remove the ticked items"}
      </button>
    </div>
  );
}
