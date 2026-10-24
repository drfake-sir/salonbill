import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { db, logAudit } from "@/lib/db";
import { hashPin, isValidNewPin } from "@/lib/pins";
import { removeDemoData } from "@/lib/demoData";

/**
 * Owner-only first-run "Set up your salon" screen (rendered inside OwnerOnly
 * by AppShell while `settings.onboarded` is false).
 *
 * Two jobs, both required before the salon leaves setup:
 *  1. set a NEW owner PIN (6-8 digits, PBKDF2-hashed) — so the seeded default
 *     PIN can never stay in use;
 *  2. optionally remove the seeded demo staff/services/customers in one step
 *     (backup first, refuses if real bills exist) — the same action Settings
 *     offers afterwards as "Remove demo data".
 */
export function SetupScreen() {
  const settings = useLiveQuery(() => db.settings.get(1));
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);

  const valid = isValidNewPin(pin);

  const finish = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      // Hashed before storage; the settings row syncs like any other change.
      await db.settings.update(1, { ownerPin: await hashPin(pin), onboarded: true });
      await logAudit("setup.finish", "");
      setPin("");
      toast.success("Salon set up — your new owner PIN is active");
    } catch (e) {
      console.error(e);
      toast.error("Could not save the setup — please try again");
    } finally {
      setBusy(false);
    }
  };

  const runRemoveDemo = async () => {
    if (removing) return;
    setRemoving(true);
    try {
      const r = await removeDemoData();
      if (r.ok) {
        const n =
          r.removed.stylists.length + r.removed.services.length + r.removed.customers.length;
        toast.success(
          `Demo data removed · ${r.removed.stylists.length} staff, ` +
            `${r.removed.services.length} services, ${r.removed.customers.length} customers ` +
            `(${n} rows) — backup downloaded first`,
        );
      } else if (r.reason === "real-bills") {
        toast.error("This salon has real bills — demo data was NOT removed.");
      } else if (r.reason === "backup-failed") {
        toast.error("Could not save a safety backup — nothing was removed.");
      } else if (r.reason === "no-demo") {
        toast.info("No demo data found on this device.");
      }
      // "declined" → silent
    } catch (e) {
      console.error(e);
      toast.error("Could not remove demo data — nothing was changed.");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="mx-auto grid min-h-[70vh] max-w-md place-items-center">
      <div className="w-full rounded-3xl bg-card p-6 shadow-soft">
        <div className="mb-4 grid size-14 place-items-center rounded-2xl bg-gold-soft text-accent-foreground">
          <Sparkles />
        </div>
        <h1 className="text-xl font-extrabold">Set up your salon</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Two quick steps: set your own owner PIN (the default one can't stay in use), and remove
          the demo staff, services and customers we seeded for the trial.
        </p>

        <section className="mt-5 space-y-3">
          <h2 className="font-bold">1 · New owner PIN</h2>
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
            inputMode="numeric"
            autoComplete="off"
            placeholder="New owner PIN (6-8 digits)"
            aria-label="New owner PIN"
            className="tap w-full rounded-xl border border-input bg-card px-4 py-3 text-center text-2xl font-bold tracking-[0.4em] outline-none focus:ring-2 focus:ring-ring"
          />
          <p className="text-xs text-muted-foreground">
            Stored as a salted PBKDF2 hash and synced to every device. You'll sign in with it from
            now on.
          </p>
        </section>

        <section className="mt-5 space-y-2 rounded-2xl bg-secondary p-4">
          <h2 className="font-bold">2 · Demo data</h2>
          <p className="text-sm text-muted-foreground">
            A local backup is downloaded first, and removal is refused if any real bill exists.
            Deletions sync to every device as normal tombstones.
          </p>
          <button
            onClick={() => void runRemoveDemo()}
            disabled={removing}
            className="tap flex w-full items-center justify-center gap-2 rounded-xl bg-card px-4 py-2.5 font-semibold shadow-soft disabled:opacity-60"
          >
            <Trash2 className="size-4" />
            {removing ? "Removing…" : "Remove demo data"}
          </button>
        </section>

        <button
          onClick={() => void finish()}
          disabled={!valid || busy}
          className="tap mt-5 w-full rounded-xl bg-accent py-3 font-semibold text-accent-foreground disabled:opacity-60"
        >
          {busy ? "Saving…" : "Finish setup"}
        </button>
        {!valid && pin.length > 0 && (
          <p className="mt-2 text-center text-xs text-destructive">
            Owner PIN must be 6-8 digits to finish setup.
          </p>
        )}
        {settings === undefined && (
          <p className="mt-2 text-center text-xs text-muted-foreground">Loading your salon…</p>
        )}
      </div>
    </div>
  );
}
