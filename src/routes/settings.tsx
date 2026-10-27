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
import { DemoCleanup } from "@/components/DemoCleanup";
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
  setMeta,
  snapshotAll,
} from "@/lib/export";
import { getSyncToken } from "@/lib/syncClient";
import { hashPin, isValidNewPin } from "@/lib/pins";
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
  const toggle = (label: string, key: "gstOn" | "autoPrint") => (
    <button
      onClick={() => set({ [key]: !s[key] })}
      className="tap flex w-full items-center justify-between rounded-xl bg-secondary px-4 py-2.5"
    >
      <span className="font-medium">{label}</span>
      <span
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${s[key] ? "bg-success" : "bg-border"}`}
      >
        <span
          className={`absolute top-1 size-5 rounded-full bg-card shadow-soft transition-all ${s[key] ? "left-6" : "left-1"}`}
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

  const restore = async (file: File) => {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!validateBackup(parsed)) {
        toast.error("That file is not a SalonBill backup");
        return;
      }
      const count = (parsed as Record<string, unknown[]>)["bills"]?.length ?? 0;
      const ok = window.confirm(
        `Restore backup from ${file.name}?\n\n` +
          `${count} bills will REPLACE all records on this device (current bills, catalog, customers, settings).\n\n` +
          "A safety copy of this device's current data will be downloaded first.",
      );
      if (!ok) return;
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
                <input
                  key={`${p.id}-${p.pin ?? "none"}`}
                  defaultValue=""
                  inputMode="numeric"
                  placeholder={p.pin ? "PIN set" : "No PIN"}
                  maxLength={8}
                  aria-label={`${p.name} PIN`}
                  onBlur={(e) => {
                    const v = e.target.value.replace(/\D/g, "").slice(0, 8);
                    if (v === "") {
                      if (!p.pin) return; // already unset — don't churn the row
                      void setStaffPin(p.id!, undefined);
                      return;
                    }
                    if (isValidNewPin(v)) void setStaffPin(p.id!, v);
                    else {
                      e.target.value = "";
                      toast.error("PIN must be 6-8 digits (or empty to disable)");
                    }
                  }}
                  className="tap w-28 rounded-xl border border-input bg-card px-3 py-2 text-center text-lg font-bold tracking-[0.3em] outline-none focus:ring-2 focus:ring-ring"
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
        <DemoDataCard />
        <RestoreStarterCard />
        <BackupHygieneCard onRestoreFile={restore} fileRef={fileRef} />
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
    </div>
  );
}

/* ----------------------------- demo data --------------------------------- */

/**
 * Demo/starter cleanup: three separate, unticked-by-default actions in one
 * card (see `DemoCleanup`), each with its own confirmation, an automatic
 * local backup first and the real-bills refusal. Deletions sync as tombstones.
 */
function DemoDataCard() {
  return (
    <section className="rounded-3xl bg-card p-5 shadow-soft">
      <h2 className="mb-1 font-bold">Demo data</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        New salons start with demo staff (Karthik, Priya, Arun, Divya), starter services and
        products, and fake customers. Nothing is removed unless you tick its box and confirm.
      </p>
      <DemoCleanup />
    </section>
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

function CloudBackupCard() {
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
        {status === null ? (
          <span className="text-muted-foreground">Checking cloud backup status…</span>
        ) : status.ok ? (
          <span>
            <strong>Last cloud backup:</strong>{" "}
            {status.at ? new Date(status.at).toLocaleString("en-IN") : "never"}{" "}
            {status.at && (
              <span className="text-muted-foreground">
                · {status.rows ?? 0} rows / {status.bills ?? 0} bills
              </span>
            )}
          </span>
        ) : (
          <span className="text-destructive">{status.error}</span>
        )}
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
  const [drilling, setDrilling] = useState(false);

  const daysSince = (at: number | null) =>
    at === null ? null : Math.floor((Date.now() - at) / 86_400_000);
  const offsiteAge = daysSince(offsite);
  const drillAge = daysSince(drill);

  /**
   * Quarterly restore drill: export this device, validate the export, restore
   * it straight back, and confirm the bill count is identical. A backup that
   * was never restored is not proven.
   */
  const runDrill = async () => {
    if (drilling) return;
    const ok = window.confirm(
      "Restore drill (safe):\n\n" +
        "1. This device's data is exported to a JSON snapshot.\n" +
        "2. The snapshot is validated and restored onto this device.\n" +
        "3. Bill counts are compared — anything missing fails the drill.\n\n" +
        "Nothing should change. Continue?",
    );
    if (!ok) return;
    setDrilling(true);
    try {
      const before = await db.bills.count();
      const snapshot = await snapshotAll();
      const json = JSON.parse(JSON.stringify(snapshot)) as unknown;
      if (!validateBackup(json)) {
        toast.error("Drill FAILED — the export is not a valid backup");
        return;
      }
      const r = await restoreBackup(json as Record<string, unknown[]>);
      const after = await db.bills.count();
      if (after !== before || r.bills !== before) {
        toast.error(`Drill FAILED — ${before} bills before, ${after} after. Keep the JSON export!`);
        return;
      }
      const at = Date.now();
      setMeta(META_KEYS.drill, at);
      setDrill(at);
      await logAudit("backup.drill", `${after} bills round-trip OK`);
      toast.success(`Restore drill passed · ${after} bills round-trip OK`);
    } catch (e) {
      console.error(e);
      toast.error("Drill FAILED — restore threw an error");
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
            Restore drill due — last one was {drillAge} days ago. Run it below (quarterly).
          </span>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          onClick={() =>
            void downloadLocalBackup().then((n) =>
              toast.success(`JSON backup saved · ${n} bills — email or Drive it`),
            )
          }
          className="tap flex items-center gap-2 rounded-xl bg-secondary px-5 py-2.5 font-semibold"
        >
          <Download className="size-4" /> JSON backup
        </button>
        <button
          onClick={() =>
            void downloadBillsCsv().then((n) => toast.success(`CSV saved · ${n} bills`))
          }
          className="tap flex items-center gap-2 rounded-xl bg-secondary px-5 py-2.5 font-semibold"
        >
          <Download className="size-4" /> Bills CSV
        </button>
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
        <button
          onClick={() => fileRef.current?.click()}
          className="tap flex items-center gap-2 rounded-xl bg-secondary px-5 py-2.5 font-semibold"
        >
          <Upload className="size-4" /> Restore from file…
        </button>
        <button
          onClick={() => void runDrill()}
          disabled={drilling}
          className="tap flex items-center gap-2 rounded-xl bg-secondary px-5 py-2.5 font-semibold disabled:opacity-60"
        >
          <RefreshCw className={`size-4 ${drilling ? "animate-spin" : ""}`} />
          {drilling ? "Running drill…" : "Run restore drill"}
        </button>
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
        {drill === null
          ? "No restore drill recorded yet — run one now to prove the restore path works."
          : `Last restore drill: ${new Date(drill).toLocaleDateString("en-IN")}`}
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
 */
function DeviceNameCard() {
  const [name, setName] = useState(() => getDeviceName());
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
          value={name}
          maxLength={40}
          placeholder="Counter, Owner phone…"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const clean = name.trim().slice(0, 40);
            setDeviceName(clean);
            setName(clean);
            void logAudit("device.name", clean || "(cleared)");
          }}
          className="tap w-full rounded-xl border border-input bg-card px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <p className="mt-2 text-xs text-muted-foreground">
        {name.trim()
          ? `New bills on this device will read “${name.trim()}”.`
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
