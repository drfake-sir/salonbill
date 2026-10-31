import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";
import {
  AlertTriangle,
  Cloud,
  Download,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  Smartphone,
  Upload,
} from "lucide-react";
import {
  db,
  getDeviceName,
  logAudit,
  restoreBackup,
  setDeviceName,
  validateBackup,
  type Bill,
  type Settings,
} from "@/lib/db";
import { restoreReport, restoreStarterCatalog } from "@/lib/demoData";
import { printBill } from "@/lib/print";
import { OwnerOnly } from "@/components/PinGate";
import { ReceiptView } from "@/components/ReceiptView";
import { PrintPortal } from "@/components/PrintPortal";
import {
  META_KEYS,
  downloadBillsCsv,
  downloadLocalBackup,
  downloadMonthlyCopy,
  getMeta,
  getMetaText,
  setMeta,
  setMetaText,
  snapshotAll,
} from "@/lib/export";
import { drillSummary, runRestoreDrill } from "@/lib/restoreDrill";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getSyncToken } from "@/lib/syncClient";
import { hashPin, isValidNewPin, verifyPin } from "@/lib/pins";
import { backupNowFn, backupStatusFn } from "@/syncFns";
import {
  canInstall,
  isPrivateBrowsing,
  isStandalone,
  promptInstall,
  storageStatus,
  subscribeInstall,
} from "@/lib/pwa";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — SalonBill" },
      { name: "description", content: "Salon details, GST, receipt and owner PIN settings." },
      { property: "og:title", content: "Settings — SalonBill" },
      { property: "og:description", content: "Configure your salon, GST and receipts." },
    ],
  }),
  component: () => (
    <OwnerOnly>
      <SettingsPage />
    </OwnerOnly>
  ),
});

const sample: Bill = {
  number: "SB-0042",
  createdAt: Date.now(),
  status: "paid" as const,
  customerName: "Lakshmi N",
  customerPhone: "9841234567",
  cashierName: "Priya",
  lines: [
    {
      key: "a",
      kind: "service" as const,
      refId: 1,
      name: "Women's Haircut",
      price: 600,
      qty: 1,
      gstRate: 18,
      commissionPct: 10,
      stylistId: 2,
    },
  ],
  discountType: "flat" as const,
  discountValue: 0,
  subtotal: 600,
  discount: 0,
  cgst: 54,
  sgst: 54,
  tip: 0,
  total: 708,
  payments: [{ mode: "UPI" as const, amount: 708 }],
};

function SettingsPage() {
  const s = useLiveQuery(() => db.settings.get(1));
  const stylists = useLiveQuery(() => db.stylists.toArray(), []) ?? [];
  const [printing, setPrinting] = useState<Bill | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Restore is destructive and replaces data on every device, so the file
  // picker only stages it: the owner must confirm with their owner PIN here.
  const [pending, setPending] = useState<File | null>(null);
  const [restorePin, setRestorePin] = useState("");
  const [restoreErr, setRestoreErr] = useState("");
  const [restoring, setRestoring] = useState(false);
  if (!s) return null;
  const set = (p: Partial<Settings>) => db.settings.update(1, p);
  const field = (label: string, key: keyof Settings) => (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-muted-foreground">{label}</span>
      <input
        defaultValue={String(s[key])}
        onBlur={(e) => set({ [key]: e.target.value })}
        className="tap w-full rounded-xl border border-input bg-card px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
  );
  // `on` is passed explicitly where a missing key must read as ON
  // (showCommission predates the switch — see commissionVisible()).
  const toggle = (
    label: string,
    key: "gstOn" | "autoPrint" | "showCommission",
    on = Boolean(s[key]),
  ) => (
    <button
      onClick={() => set({ [key]: !on })}
      className="tap flex w-full items-center justify-between rounded-xl bg-secondary px-4 py-2.5"
    >
      <span className="font-medium">{label}</span>
      <span
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${on ? "bg-success" : "bg-border"}`}
      >
        <span
          className={`absolute top-1 size-5 rounded-full bg-card shadow-soft transition-all ${on ? "left-6" : "left-1"}`}
        />
      </span>
    </button>
  );

  const setStaffPin = async (id: number, pin: string | undefined) => {
    // New PINs must be 6-8 digits; existing 4-digit PINs keep working until
    // this owner sets a replacement. Stored salted-hash only — never plain.
    if (pin !== undefined && !isValidNewPin(pin)) {
      toast.error("PIN must be 6-8 digits (or empty to disable)");
      return;
    }
    await db.stylists.update(id, { pin: pin === undefined ? undefined : await hashPin(pin) });
    await logAudit("staff.pin", `staff #${id}`);
    toast.success("Staff PIN updated — synced to every device");
  };

  const changeOwnerPin = async () => {
    const p = prompt("New owner PIN (6-8 digits)");
    if (p === null) return; // cancelled
    if (!isValidNewPin(p)) {
      toast.error("Owner PIN must be 6-8 digits");
      return;
    }
    // Hashed immediately: the plain value never touches storage.
    set({ ownerPin: await hashPin(p) });
    await logAudit("pin.change", "");
    toast.success("Owner PIN updated");
  };

  /** The file picker finished: stage the file, the confirm dialog asks for the owner PIN. */
  const requestRestore = async (file: File) => {
    setPending(file);
    setRestorePin("");
    setRestoreErr("");
  };

  /** Called only after the owner PIN has been verified in the confirm dialog. */
  const confirmRestore = async () => {
    const file = pending;
    if (!file || restoring) return;
    if (!s.ownerPin || !(await verifyPin(s.ownerPin, restorePin))) {
      setRestoreErr("That is not the owner PIN.");
      return;
    }
    setRestoreErr("");
    setRestoring(true);
    try {
      await restore(file);
      setPending(null);
      setRestorePin("");
    } finally {
      setRestoring(false);
    }
  };

  const restore = async (file: File) => {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!validateBackup(parsed)) {
        toast.error("That file is not a SalonBill backup");
        return;
      }
      const count = (parsed as Record<string, unknown[]>)["bills"]?.length ?? 0;
      void count; // the confirm dialog (already passed) carries the warning
      // Automatic safety copy BEFORE anything is replaced. If the copy cannot
      // be produced, the restore is aborted — current data stays untouched.
      try {
        await downloadLocalBackup();
      } catch (e) {
        console.error(e);
        toast.error("Could not save a safety copy of current data — restore cancelled.");
        return;
      }
      const r = await restoreBackup(parsed as Record<string, unknown[]>);
      await logAudit("backup.restore", `${file.name}: ${r.bills} bills`);
      toast.success(`Backup restored · ${r.bills} bills`);
    } catch (e) {
      console.error(e);
      toast.error("Could not read that backup file — local data is unchanged.");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_auto]">
      {/* min-w-0: the stylist-name truncate (nowrap) would otherwise inflate
          the grid's auto track to its intrinsic width and blow out 360px. */}
      <div className="min-w-0 space-y-6">
        <h1 className="text-2xl font-extrabold tracking-tight">Settings</h1>
        <section className="grid gap-4 rounded-3xl bg-card p-5 shadow-soft sm:grid-cols-2">
          {field("Salon name", "salonName")}
          {field("Phone", "phone")}
          <div className="sm:col-span-2">{field("Address", "address")}</div>
          {field("Receipt footer", "footer")}
          {field("Google review link (QR)", "reviewUrl")}
        </section>
        <section className="space-y-3 rounded-3xl bg-card p-5 shadow-soft">
          {toggle("GST billing (CGST + SGST)", "gstOn")}
          {s.gstOn && field("GSTIN", "gstin")}
          {toggle("Auto-print after save", "autoPrint")}
          {toggle("Show commission in Earnings", "showCommission", s.showCommission !== false)}
          <div className="flex gap-2">
            {(["80mm", "58mm"] as const).map((p) => (
              <button
                key={p}
                onClick={() => set({ paper: p })}
                className={`tap flex-1 rounded-xl py-2 font-semibold ${s.paper === p ? "bg-primary text-primary-foreground" : "bg-secondary"}`}
              >
                {p} paper
              </button>
            ))}
          </div>
        </section>

        {/* ------------------------- staff identity ------------------------- */}
        <section className="space-y-3 rounded-3xl bg-card p-5 shadow-soft">
          <div>
            <h2 className="font-bold">Staff &amp; PINs</h2>
            <p className="text-sm text-muted-foreground">
              Each staff member signs in with their own PIN before billing; their name is stamped as{" "}
              <strong>cashier</strong> on the bill, receipt and PDF. Staff without a PIN are not
              asked to sign in.
            </p>
          </div>
          <div className="space-y-2">
            {stylists.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-3 rounded-2xl bg-secondary px-4 py-2.5"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-card text-sm font-bold">
                  {p.name.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                {/* 160px (w-40) + normal placeholder tracking is what lets the
                    status read "PIN set ✓" in full at text-lg/0.3em — the old
                    narrow box cut it to "PIN se". The field only ever holds a
                    NEW PIN being typed; the saved one is a salted hash and is
                    never rendered, and it is wiped from the field on success. */}
                <input
                  key={`${p.id}-${p.pin ?? "none"}`}
                  defaultValue=""
                  inputMode="numeric"
                  placeholder={p.pin ? "PIN set ✓" : "No PIN"}
                  maxLength={8}
                  aria-label={`${p.name} PIN`}
                  onBlur={(e) => {
                    const target = e.target;
                    const v = target.value.replace(/\D/g, "").slice(0, 8);
                    if (v === "") {
                      if (!p.pin) return; // already unset — don't churn the row
                      void setStaffPin(p.id!, undefined).then(() => {
                        target.value = "";
                      });
                      return;
                    }
                    if (isValidNewPin(v)) {
                      void setStaffPin(p.id!, v).then(() => {
                        target.value = ""; // success: the field is left empty
                      });
                    } else {
                      target.value = "";
                      toast.error("PIN must be 6-8 digits (or empty to disable)");
                    }
                  }}
                  className="tap w-40 rounded-xl border border-input bg-card px-3 py-2 text-center text-lg font-bold tracking-[0.3em] placeholder:tracking-normal outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            PINs are stored as a salted hash and never shown here again. Existing 4-digit PINs keep
            working until you replace them (new PINs need 6-8 digits); seeded demo PINs (1111 / 2222
            / 3333 / 4444) are placeholders — set real ones before going live.
          </p>
        </section>

        <CloudBackupCard />
        <RestoreStarterCard />
        <BackupHygieneCard onRestoreFile={requestRestore} fileRef={fileRef} />
        <DeviceNameCard />
        <DataSafetyCard />

        {/* ------------------------ owner credentials ------------------------ */}
        <section className="rounded-3xl bg-card p-5 shadow-soft">
          <h2 className="mb-3 font-bold">Owner PIN</h2>
          <button
            onClick={() => void changeOwnerPin()}
            className="tap rounded-xl bg-secondary px-5 py-2.5 font-semibold"
          >
            Change owner PIN
          </button>
          <p className="mt-2 text-sm text-muted-foreground">
            The owner PIN unlocks bill cancellation, monthly totals, exports and this screen. New
            PINs need 6-8 digits (existing 4-digit PINs keep working until changed) and are stored
            as a salted hash.
          </p>
        </section>
      </div>
      <div>
        <p className="mb-2 text-sm font-medium text-muted-foreground">Live receipt preview</p>
        <div className="overflow-hidden rounded-2xl shadow-lift">
          <ReceiptView bill={sample} settings={s} stylists={stylists} />
        </div>
        <button
          onClick={() => printBill(setPrinting, sample)}
          className="tap mt-3 w-full rounded-xl bg-primary px-5 py-2.5 font-semibold text-primary-foreground"
        >
          Print test receipt
        </button>
        <PrintPortal>
          {printing && <ReceiptView bill={printing} settings={s} stylists={stylists} />}
        </PrintPortal>
      </div>

      {/* Restore confirmation — the owner PIN is checked here, BEFORE any file
          is read or any table is touched. */}
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !restoring) {
            setPending(null);
            setRestorePin("");
            setRestoreErr("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Are you sure?</DialogTitle>
            <DialogDescription>
              Restore “{pending?.name}” from this file? Replaces data on every device. Owner only.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-2xl bg-secondary px-4 py-3 text-sm">
            Every bill, catalog item, customer and setting on this salon is replaced by the
            file&apos;s contents, then synced to every connected device. A safety copy of the
            current data is downloaded first.
          </div>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-muted-foreground">Owner PIN</span>
            <input
              type="password"
              inputMode="numeric"
              autoFocus
              maxLength={8}
              value={restorePin}
              onChange={(e) => {
                setRestorePin(e.target.value.replace(/\D/g, ""));
                setRestoreErr("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && restorePin) void confirmRestore();
              }}
              className="tap w-full rounded-xl border border-input bg-card px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          {restoreErr && <p className="text-sm font-semibold text-destructive">{restoreErr}</p>}
          <DialogFooter>
            <button
              onClick={() => {
                setPending(null);
                setRestorePin("");
                setRestoreErr("");
              }}
              className="tap rounded-xl bg-secondary px-5 py-2.5 font-semibold"
            >
              Cancel
            </button>
            <button
              onClick={() => void confirmRestore()}
              disabled={!restorePin || restoring}
              className="tap rounded-xl bg-destructive px-5 py-2.5 font-semibold text-destructive-foreground disabled:opacity-50"
            >
              {restoring ? "Restoring…" : "Replace data & restore"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Owner-only rescue for the starter price list: adds back exactly the starter
 * rows that are MISSING (matched by name, ignoring case and spaces) and never
 * edits, re-prices or deletes anything that exists.
 */
function RestoreStarterCard() {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (busy) return;
    const ok = window.confirm(
      "Restore the starter catalog?\n\n" +
        "Every starter category, service, product and stylist that is MISSING is added back. " +
        "Nothing that already exists is renamed, re-priced or deleted, and saved bills are " +
        "untouched.\n\nRestored stylists have no PIN until you set one under Staff & PINs.",
    );
    if (!ok) return;
    setBusy(true);
    try {
      const report = restoreReport(await restoreStarterCatalog());
      await logAudit("catalog.restore", report);
      toast.success(report);
    } catch (e) {
      console.error("restore starter catalog failed", e);
      toast.error("Could not restore the starter catalog — please try again");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-3xl bg-card p-5 shadow-soft" data-testid="restore-starter">
      <h2 className="mb-1 font-bold">Restore starter catalog</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        Deleted or renamed part of the starter price list? This adds back only what is missing,
        matched by name — “arun” counts as “Arun”. Existing rows are never edited and bills are
        never touched. Running it twice adds nothing the second time.
      </p>
      <button
        onClick={() => void run()}
        disabled={busy}
        className="tap rounded-xl bg-accent px-5 py-2.5 font-semibold text-accent-foreground disabled:opacity-60"
      >
        {busy ? "Restoring…" : "Restore starter catalog"}
      </button>
    </section>
  );
}

/* ----------------------------- cloud backup ------------------------------ */

type CloudStatus = {
  ok: boolean;
  at?: number | null;
  key?: string | null;
  rows?: number;
  bills?: number;
  error?: string;
};

/**
 * "Cloud backup (automatic)" — rendered ONLY while the server confirms cloud
 * backup storage exists and this device holds a sync token. When it is not
 * enabled the whole card is absent: no red error, no disabled button and no
 * "kept for 13 months" claim about a backup that can never happen. The manual
 * backup / restore cards below never depend on this.
 * Exported so the regression test can drive both states.
 */
export function CloudBackupCard() {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    const token = getSyncToken();
    if (!token) {
      setStatus({ ok: false, error: "Not connected to the salon cloud yet" });
      return;
    }
    backupStatusFn({ data: { token } })
      .then(setStatus)
      .catch(() => setStatus({ ok: false, error: "Could not reach the cloud backup service" }));
  };

  useEffect(() => {
    refresh();
  }, []);

  const runNow = async () => {
    const token = getSyncToken();
    if (!token || busy) return;
    setBusy(true);
    try {
      const r = await backupNowFn({ data: { token } });
      if (r.ok) {
        toast.success(
          r.skipped
            ? "A recent backup already exists — nothing to do"
            : `Cloud backup done · ${r.rows ?? 0} rows / ${r.bills ?? 0} bills exported`,
        );
      } else {
        toast.error(r.error ?? "Cloud backup failed");
      }
      refresh();
    } finally {
      setBusy(false);
    }
  };

  // Not enabled (no R2 storage on this app) or not yet connected: hide it all.
  if (!status?.ok) return null;

  return (
    <section className="space-y-3 rounded-3xl bg-card p-5 shadow-soft">
      <div>
        <h2 className="flex items-center gap-2 font-bold">
          <Cloud className="size-4 text-accent-foreground" /> Cloud backup (automatic)
        </h2>
        <p className="text-sm text-muted-foreground">
          Every day the salon database is exported to cloud storage as a restore-ready JSON plus a
          bills CSV, kept for 13 months. The first sync of each day triggers it — no button needed.
        </p>
      </div>
      <div className="rounded-2xl bg-secondary px-4 py-3 text-sm">
        <span>
          <strong>Last cloud backup:</strong>{" "}
          {status.at ? new Date(status.at).toLocaleString("en-IN") : "never"}{" "}
          {status.at && (
            <span className="text-muted-foreground">
              · {status.rows ?? 0} rows / {status.bills ?? 0} bills
            </span>
          )}
        </span>
      </div>
      <button
        onClick={() => void runNow()}
        disabled={busy || !status?.ok}
        className="tap flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 font-semibold text-accent-foreground disabled:opacity-50"
      >
        <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />
        {busy ? "Backing up…" : "Back up now"}
      </button>
    </section>
  );
}

/* --------------------------- backup hygiene ------------------------------ */

const OFFSITE_DAYS = 30;
const DRILL_DAYS = 90;

function BackupHygieneCard({
  onRestoreFile,
  fileRef,
}: {
  onRestoreFile: (f: File) => Promise<void>;
  fileRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [offsite, setOffsite] = useState<number | null>(() => getMeta(META_KEYS.offsite));
  const [drill, setDrill] = useState<number | null>(() => getMeta(META_KEYS.drill));
  const [drillResult, setDrillResult] = useState<string | null>(() =>
    getMetaText(META_KEYS.drillResult),
  );
  const [drilling, setDrilling] = useState(false);

  const daysSince = (at: number | null) =>
    at === null ? null : Math.floor((Date.now() - at) / 86_400_000);
  const offsiteAge = daysSince(offsite);
  const drillAge = daysSince(drill);

  // "<epochMs>|passed — 8 tables match, 2 bills" → date + wording for the footer.
  const resultAt = drillResult ? Number(drillResult.slice(0, drillResult.indexOf("|"))) : null;
  const lastCheckAt = [drill, resultAt].reduce<number | null>(
    (acc, n) => (typeof n === "number" && !Number.isNaN(n) ? Math.max(acc ?? n, n) : acc),
    null,
  );
  const resultText = drillResult ? drillResult.slice(drillResult.indexOf("|") + 1) : "";
  const drillLine =
    lastCheckAt === null
      ? "No restore check recorded yet — run one now to prove the restore path works."
      : `Last restore check: ${new Date(lastCheckAt).toLocaleDateString("en-IN")}${
          resultText ? ` · ${resultText}` : ""
        }`;

  /**
   * Restore check (formerly the "restore drill"): export this device, then
   * work out ON PAPER how many rows each table would hold if that backup were
   * restored and compare with the live counts. It never opens a transaction
   * and never writes a table — see lib/restoreDrill.ts. The date and the
   * result are recorded; only a passed check refreshes the quarterly nudge.
   */
  const runDrill = async () => {
    if (drilling) return;
    const ok = window.confirm(
      "Check that a backup can be restored (does not change your data):\n\n" +
        "1. This device's data is exported to a JSON snapshot.\n" +
        "2. The check works out in memory how many rows each table would hold after restoring it.\n" +
        "3. Those numbers are compared with the live tables — nothing is restored, nothing is written.\n\n" +
        "Continue?",
    );
    if (!ok) return;
    setDrilling(true);
    const record = async (summary: string, passed: boolean) => {
      const at = Date.now();
      setMetaText(META_KEYS.drillResult, `${at}|${summary}`);
      setDrillResult(`${at}|${summary}`);
      if (passed) {
        setMeta(META_KEYS.drill, at);
        setDrill(at);
      }
      await logAudit("backup.drill", summary);
    };
    try {
      const snapshot = await snapshotAll();
      const json = JSON.parse(JSON.stringify(snapshot)) as unknown;
      const res = await runRestoreDrill(json);
      const summary = drillSummary(res);
      await record(summary, res.ok);
      if (res.ok) toast.success(`Backup can be restored · ${summary}`);
      else toast.error(`Backup check FAILED — ${summary}`);
    } catch (e) {
      console.error(e);
      await record("failed — the check threw an error", false);
      toast.error("Backup check FAILED — the check threw an error");
    } finally {
      setDrilling(false);
    }
  };

  return (
    <section className="space-y-3 rounded-3xl bg-card p-5 shadow-soft">
      <div>
        <h2 className="flex items-center gap-2 font-bold">
          <HardDrive className="size-4 text-accent-foreground" /> Backups &amp; restore
        </h2>
        <p className="text-sm text-muted-foreground">
          Three layers protect the data: the daily cloud copy (above), this device&apos;s JSON
          backup, and an <strong>off-platform copy</strong> you keep yourself (email / Google Drive)
          — the one that survives losing the device <em>and</em> the cloud account.
        </p>
      </div>

      {offsiteAge !== null && offsiteAge >= OFFSITE_DAYS && (
        <div className="flex items-start gap-2 rounded-2xl bg-gold-soft px-4 py-3 text-sm font-medium">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-accent-foreground" />
          <span>
            Last off-platform copy {offsiteAge} days ago — download this month&apos;s and email it
            to yourself / save it in Google Drive.
          </span>
        </div>
      )}
      {drillAge !== null && drillAge >= DRILL_DAYS && (
        <div className="flex items-start gap-2 rounded-2xl bg-gold-soft px-4 py-3 text-sm font-medium">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-accent-foreground" />
          <span>
            Restore check due — last passed one was {drillAge} days ago. Run it below (quarterly).
          </span>
        </div>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-3">
        <div className="flex flex-col gap-1">
          <button
            onClick={() =>
              void downloadLocalBackup().then((n) =>
                toast.success(`JSON backup saved · ${n} bills — email or Drive it`),
              )
            }
            className="tap flex items-center gap-2 rounded-xl bg-secondary px-5 py-2.5 font-semibold"
          >
            <Download className="size-4" /> Backup file (for restoring)
          </button>
          <p className="max-w-56 text-xs text-muted-foreground">
            One file with everything in it — this is the file a restore reads.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <button
            onClick={() =>
              void downloadBillsCsv().then((n) => toast.success(`CSV saved · ${n} bills`))
            }
            className="tap flex items-center gap-2 rounded-xl bg-secondary px-5 py-2.5 font-semibold"
          >
            <Download className="size-4" /> Bills spreadsheet (CSV)
          </button>
          <p className="max-w-56 text-xs text-muted-foreground">
            Every bill as a spreadsheet, for your records or accountant — it cannot be restored
            from.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <button
            onClick={() =>
              void downloadMonthlyCopy().then(({ bills }) => {
                setOffsite(Date.now());
                toast.success(
                  `Monthly copy saved · ${bills} bills (JSON + CSV) — send them off this device`,
                  { duration: 6000 },
                );
              })
            }
            className="tap flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 font-semibold text-accent-foreground"
          >
            <Upload className="size-4" /> Monthly off-platform copy
          </button>
        </div>
        <div className="flex flex-col gap-1">
          <button
            onClick={() => fileRef.current?.click()}
            className="tap flex items-center gap-2 rounded-xl bg-secondary px-5 py-2.5 font-semibold"
          >
            <Upload className="size-4" /> Restore from file…
          </button>
          <p className="max-w-56 text-xs font-semibold text-destructive">
            Replaces data on every device. Owner only.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <button
            onClick={() => void runDrill()}
            disabled={drilling}
            className="tap flex max-w-72 items-center gap-2 rounded-xl bg-secondary px-5 py-2.5 text-left font-semibold disabled:opacity-60"
          >
            <RefreshCw className={`size-4 shrink-0 ${drilling ? "animate-spin" : ""}`} />
            {drilling
              ? "Checking…"
              : "Check that a backup can be restored (does not change your data)"}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onRestoreFile(f);
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {offsite === null
          ? "No off-platform copy recorded yet on this device."
          : `Off-platform copy: ${new Date(offsite).toLocaleDateString("en-IN")} · `}
        {drillLine}
      </p>
    </section>
  );
}

/* ------------------------------ this device ------------------------------ */

/**
 * Name this physical counter.
 *
 * The name is asked once at first connect, but some webviews refuse
 * `window.prompt` entirely, so the owner needs a place to set it here —
 * otherwise every bill from this device would silently export as
 * "Unknown device". Renaming affects FUTURE bills only; saved bills keep the
 * name they were stamped with, exactly like a receipt reprint.
 *
 * The field is a DRAFT: typing changes nothing until Save. Save stores it and
 * shows “Saved ✓” + a toast; Cancel puts the saved name back. The helper text
 * promises what new bills will read, so it only ever shows the SAVED name.
 * Exported for the regression test.
 */
export function DeviceNameCard() {
  const [saved, setSaved] = useState(() => getDeviceName());
  const [draft, setDraft] = useState(() => getDeviceName());
  const [justSaved, setJustSaved] = useState(false);

  const clean = draft.trim().slice(0, 40);
  const dirty = clean !== saved.trim(); // save is disabled until the draft differs
  const canSave = dirty && clean.length > 0;

  const save = () => {
    if (!canSave) return;
    setDeviceName(clean);
    setSaved(clean);
    setDraft(clean);
    setJustSaved(true);
    void logAudit("device.name", clean || "(cleared)");
    toast.success(`Device name saved — new bills will read “${clean}”`);
  };

  const cancel = () => {
    setDraft(saved);
    setJustSaved(false);
  };

  const showSaved = justSaved && !dirty;

  return (
    <section className="rounded-3xl bg-card p-5 shadow-soft">
      <div>
        <h2 className="flex items-center gap-2 font-bold">
          <Smartphone className="size-4 text-accent-foreground" /> This device
        </h2>
        <p className="text-sm text-muted-foreground">
          Bills saved on this device are stamped with this name, so exports and bill details can
          tell your counter apart from your phone.
        </p>
      </div>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-muted-foreground">Device name</span>
        <input
          value={draft}
          maxLength={40}
          placeholder="Counter, Owner phone…"
          onChange={(e) => {
            setDraft(e.target.value);
            setJustSaved(false);
          }}
          className="tap w-full rounded-xl border border-input bg-card px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={save}
          disabled={!canSave}
          className="tap rounded-xl bg-primary px-5 py-2.5 font-semibold text-primary-foreground disabled:opacity-50"
        >
          Save
        </button>
        <button
          onClick={cancel}
          disabled={!dirty}
          className="tap rounded-xl bg-secondary px-5 py-2.5 font-semibold disabled:opacity-50"
        >
          Cancel
        </button>
        {showSaved && (
          <span className="text-sm font-bold text-success" data-testid="device-saved">
            Saved ✓
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {saved.trim()
          ? `New bills on this device will read “${saved.trim()}”.`
          : "No name set — new bills on this device will read \u201cUnknown device\u201d."}
      </p>
    </section>
  );
}

/* ----------------------------- data safety ------------------------------- */

function DataSafetyCard() {
  const [priv, setPriv] = useState(false);
  const [storage, setStorage] = useState<string>("…");
  const [installable, setInstallable] = useState(false);
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    setPriv(isPrivateBrowsing());
    setStandalone(isStandalone());
    void storageStatus().then((s) => {
      setStorage(
        s === "persistent"
          ? "protected (browser will not auto-evict it)"
          : s === "best-effort"
            ? "best-effort — the browser may still evict it under storage pressure"
            : s === "private"
              ? "UNSAFE — private browsing deletes everything when the tab closes"
              : "not controllable on this browser",
      );
    });
    setInstallable(canInstall());
    return subscribeInstall(() => setInstallable(canInstall()));
  }, []);

  return (
    <section className="space-y-3 rounded-3xl bg-card p-5 shadow-soft">
      <div>
        <h2 className="flex items-center gap-2 font-bold">
          <ShieldCheck className="size-4 text-accent-foreground" /> Device safety
        </h2>
        <p className="text-sm text-muted-foreground">
          This device is the source of truth until bills sync. Two habits keep it safe:
          <strong> never browse in Incognito/Private mode</strong>, and
          <strong> never use “Clear site data” / “Reset browser data”</strong> here — both delete
          bills that may not be synced yet.
        </p>
      </div>

      {priv && (
        <div className="flex items-start gap-2 rounded-2xl bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            Private/Incognito window detected — close it and use a normal window. Everything here is
            deleted when the tab closes.
          </span>
        </div>
      )}

      <div className="rounded-2xl bg-secondary px-4 py-3 text-sm">
        <strong>Storage:</strong> <span className="text-muted-foreground">{storage}</span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {standalone ? (
          <span className="flex items-center gap-2 rounded-xl bg-secondary px-4 py-2.5 text-sm font-semibold">
            <Smartphone className="size-4" /> Installed as an app ✓
          </span>
        ) : installable ? (
          <button
            onClick={() =>
              void promptInstall().then((r) =>
                r === "accepted"
                  ? toast.success("SalonBill installed")
                  : r === "unavailable" && toast.info("Install cancelled"),
              )
            }
            className="tap flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 font-semibold text-accent-foreground"
          >
            <Smartphone className="size-4" /> Install app on this device
          </button>
        ) : (
          <p className="text-sm text-muted-foreground">
            <Smartphone className="mr-1 inline size-4" />
            On iPhone/iPad: Share → <strong>Add to Home Screen</strong>. On Android/PC: use the
            browser&apos;s <strong>Install app</strong> menu.
          </p>
        )}
      </div>
    </section>
  );
}
