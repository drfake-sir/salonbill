import { useEffect, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  CloudOff,
  Download,
  Loader2,
  ShieldAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { db } from "@/lib/db";
import { useOwner } from "@/lib/lock";
import { META_KEYS, downloadLocalBackup, getMeta, shouldRemindSundayBackup } from "@/lib/export";
import {
  connect,
  everConnected,
  getSyncStatus,
  hasToken,
  isUnsyncedStale,
  isFirstSyncDone,
  subscribeSync,
  syncNow,
  type SyncStatus,
} from "@/lib/syncClient";
import { isPrivateBrowsing } from "@/lib/pwa";

export function useSyncStatus(): SyncStatus {
  const [s, setS] = useState(getSyncStatus);
  useEffect(() => subscribeSync(() => setS(getSyncStatus())), []);
  return s;
}

/** "just now" / "2 min ago" / "5 h ago" / "3 d ago" */
function timeAgo(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/**
 * Slim status line: "Online · last sync 2 min ago" / "Offline · 4 bills
 * waiting". Click opens the connect sheet.
 */
export function SyncPill() {
  const s = useSyncStatus();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // localStorage differs between SSR HTML and the first client render — only
  // read it after mount to keep hydration consistent.
  const [mounted, setMounted] = useState(false);
  const queued = useLiveQuery(() => db.syncQueue.count(), []) ?? 0;
  const queuedBills =
    useLiveQuery(() => db.syncQueue.filter((q) => q.table === "bills").count(), []) ?? 0;

  useEffect(() => {
    setMounted(true);
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const connected = mounted && hasToken();
  const syncing = s.phase === "syncing" || s.phase === "connecting";
  const online = connected && s.phase === "online";

  const label = !connected
    ? "Not connected"
    : syncing
      ? "Syncing…"
      : online
        ? s.lastSyncAt
          ? `Online · last sync ${timeAgo(s.lastSyncAt, now)}`
          : "Online"
        : queuedBills
          ? `Offline · ${queuedBills} bill${queuedBills === 1 ? "" : "s"} waiting`
          : queued
            ? `Offline · ${queued} change${queued === 1 ? "" : "s"} waiting`
            : "Offline";

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="tap fixed right-3 top-3 z-40 flex max-w-[calc(100vw-1.5rem)] items-center gap-1.5 truncate rounded-full bg-card px-3 py-1.5 text-xs font-semibold shadow-soft"
        title={s.error ?? "Cloud sync"}
      >
        {syncing ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" />
        ) : online ? (
          <CheckCircle2 className="size-3.5 shrink-0 text-success" />
        ) : connected ? (
          <CloudOff className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <Cloud className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{label}</span>
      </button>
      {open && <ConnectSheet onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * In-flow warning strips at the top of the app:
 *  - Incognito / private mode (data dies with the tab)
 *  - unsynced changes sitting on this device for more than 3 h
 */
export function DataWarnings() {
  const s = useSyncStatus();
  const [now, setNow] = useState(() => Date.now());
  const [priv, setPriv] = useState(false);
  const [mounted, setMounted] = useState(false);
  const queued = useLiveQuery(() => db.syncQueue.count(), []) ?? 0;
  const queuedBills =
    useLiveQuery(() => db.syncQueue.filter((q) => q.table === "bills").count(), []) ?? 0;

  useEffect(() => {
    setMounted(true);
    setPriv(isPrivateBrowsing());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const connected = mounted && hasToken();
  const stale =
    connected && isUnsyncedStale(s.lastSyncAt, now)
      ? Math.floor((now - (s.lastSyncAt ?? now)) / 3600_000)
      : null;
  const neverSynced = connected && s.lastSyncAt === null;

  if (!priv && stale === null && !neverSynced) return null;
  return (
    <div className="mb-3 space-y-2">
      {priv && (
        <div className="flex items-start gap-2 rounded-2xl bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            Private/Incognito window detected — bills here are{" "}
            <strong>deleted when this tab closes</strong>. Open this app in a normal window and
            download a backup from Settings.
          </span>
        </div>
      )}
      {stale !== null && (
        <div className="flex items-start gap-2 rounded-2xl bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            This counter hasn&apos;t synced in {stale}h. Check the internet — bills below are safe
            locally but are <strong>not yet in the cloud</strong>.
            {queued > 0 && (
              <>
                {" "}
                <strong>
                  {queued} change{queued === 1 ? "" : "s"}
                  {queuedBills ? ` (${queuedBills} bill${queuedBills === 1 ? "" : "s"})` : ""}
                </strong>{" "}
                waiting to upload.
              </>
            )}
          </span>
        </div>
      )}
      {neverSynced && s.phase === "error" && (
        <div className="flex items-start gap-2 rounded-2xl bg-gold-soft px-4 py-3 text-sm font-medium">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-accent-foreground" />
          <span>First sync has not succeeded yet — billing stays locked until it does.</span>
        </div>
      )}
    </div>
  );
}

/**
 * Mandatory cloud copy: the app refuses to start billing until this device
 * has a sync token (salon PIN set) AND its first full sync has succeeded.
 * Settings stays reachable outside this gate (recovery/export path).
 *
 * OFFLINE SAFETY: once a device has connected successfully even once it is
 * latched in. Losing the network — or a failed background sync — must never
 * put the counter back behind this screen, because the salon can't bill a
 * customer it can't serve. A first sync that never completed is retried in
 * the background instead of blocking.
 */
export function CloudGate({ children }: { children: ReactNode }) {
  const s = useSyncStatus();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // First (server + hydration) render stays neutral: token state lives in
  // localStorage, which SSR can't see.
  if (!mounted) return <GateSkeleton />;
  if (hasToken() && (isFirstSyncDone() || everConnected())) {
    // Latched device whose first copy is still pending: keep billing, retry
    // quietly, and say so rather than blocking the counter.
    if (!isFirstSyncDone())
      return (
        <>
          <div className="mb-3 flex items-start gap-2 rounded-2xl bg-gold-soft px-4 py-3 text-sm font-medium">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-accent-foreground" />
            <span>
              The first cloud copy of this device is still uploading. You can keep billing — it
              retries automatically.
            </span>
          </div>
          {children}
        </>
      );
    return <>{children}</>;
  }
  return <CloudSetup s={s} />;
}

function GateSkeleton() {
  return (
    <div className="grid min-h-[70vh] place-items-center">
      <div className="h-10 w-40 animate-pulse rounded-full bg-card" />
    </div>
  );
}

function CloudSetup({ s }: { s: SyncStatus }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const connected = hasToken();
  const syncing = s.phase === "syncing" || s.phase === "connecting";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!/^\d{6,8}$/.test(pin)) {
      toast.error("Enter the 6-8 digit salon PIN");
      return;
    }
    setBusy(true);
    const r = await connect(pin);
    setBusy(false);
    if (r.ok) {
      setPin("");
      toast.success("Connected — uploading the first cloud copy…");
    } else {
      toast.error(r.error ?? "Could not connect. Check the PIN and your internet.");
    }
  };

  const step = (done: boolean, text: string) => (
    <li className="flex items-center gap-2 text-sm">
      {done ? (
        <CheckCircle2 className="size-4 shrink-0 text-success" />
      ) : (
        <Loader2 className="size-4 shrink-0 animate-spin text-accent" />
      )}
      <span className={done ? "text-muted-foreground" : "font-medium"}>{text}</span>
    </li>
  );

  return (
    <div className="grid min-h-[70vh] place-items-center">
      <div className="w-full max-w-md rounded-3xl bg-card p-6 shadow-soft">
        <div className="mb-4 grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent-foreground">
          <Cloud className="size-7" />
        </div>
        <h1 className="text-xl font-extrabold">Connect this device to the salon cloud</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Billing unlocks only after this device&apos;s first sync succeeds — that first upload is
          what guarantees every bill is copied off this device.
        </p>

        <ul className="my-4 space-y-2">
          {step(connected, connected ? "Salon PIN accepted" : "Salon PIN not set on this device")}
          {step(
            connected && isFirstSyncDone(),
            connected && isFirstSyncDone()
              ? "First cloud copy uploaded"
              : "Uploading the first cloud copy…",
          )}
        </ul>

        {!connected ? (
          <form onSubmit={submit} className="space-y-3">
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
              inputMode="numeric"
              autoComplete="off"
              placeholder="Salon PIN (6-8 digits)"
              className="tap w-full rounded-xl border border-input bg-card px-4 py-3 text-center text-2xl font-bold tracking-[0.4em] outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground">
              First device in the salon sets the PIN; every other device uses the same PIN.
            </p>
            {s.error && <p className="text-sm text-destructive">{s.error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="tap w-full rounded-xl bg-accent py-3 font-semibold text-accent-foreground disabled:opacity-60"
            >
              {busy ? "Connecting…" : "Connect & unlock billing"}
            </button>
          </form>
        ) : (
          <div className="space-y-3">
            {syncing ? (
              <div className="flex items-center gap-2 rounded-xl bg-secondary px-4 py-3 text-sm font-medium">
                <Loader2 className="size-4 animate-spin text-accent" />
                Uploading your first copy — this can take a moment on a large catalog…
              </div>
            ) : (
              <>
                {s.error && (
                  <p className="text-sm text-destructive">
                    First sync failed: {s.error}. Fix the internet connection and retry — nothing
                    was lost.
                  </p>
                )}
                <button
                  onClick={() => void syncNow({ forceFirst: true })}
                  className="tap w-full rounded-xl bg-accent py-3 font-semibold text-accent-foreground"
                >
                  Retry first sync
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectSheet({ onClose }: { onClose: () => void }) {
  const s = useSyncStatus();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const connected = hasToken() && s.phase === "online";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!/^\d{6,8}$/.test(pin)) {
      toast.error("Enter the 6-8 digit salon PIN");
      return;
    }
    setBusy(true);
    const r = await connect(pin);
    setBusy(false);
    if (r.ok) {
      toast.success("Connected — this device now shares data with the salon");
      setPin("");
      onClose();
    } else {
      toast.error(r.error ?? "Could not connect. Check the PIN and your internet.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-3xl bg-card p-6 shadow-soft">
        <div className="mb-1 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-extrabold">Salon cloud sync</h2>
            <p className="text-sm text-muted-foreground">
              {connected
                ? "This device shares bills, catalog and customers with every other device in real time."
                : "Enter the salon PIN so every device shares the same data. The first device sets the PIN."}
            </p>
          </div>
          <button
            onClick={onClose}
            className="tap -mr-2 -mt-2 grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground"
            aria-label="Close sync sheet"
          >
            <X className="size-5" />
          </button>
        </div>

        {connected ? (
          <div className="mt-4 space-y-3">
            <div className="rounded-2xl bg-secondary p-3 text-sm">
              <div className="flex items-center gap-2 font-medium">
                <CheckCircle2 className="size-4 text-success" /> Connected
              </div>
              {s.lastSyncAt && (
                <p className="mt-1 text-muted-foreground">
                  Last synced {new Date(s.lastSyncAt).toLocaleTimeString()}
                </p>
              )}
            </div>
            <button
              onClick={() => void syncNow()}
              className="tap w-full rounded-xl bg-accent py-2.5 font-semibold text-accent-foreground"
            >
              Sync now
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-4 space-y-3">
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
              inputMode="numeric"
              autoComplete="off"
              placeholder="Salon PIN"
              className="tap w-full rounded-xl border border-input bg-card px-4 py-3 text-center text-2xl font-bold tracking-[0.4em] outline-none focus:ring-2 focus:ring-ring"
            />
            {s.error && <p className="text-sm text-destructive">{s.error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="tap w-full rounded-xl bg-accent py-3 font-semibold text-accent-foreground disabled:opacity-60"
            >
              {busy ? "Connecting…" : "Connect this device"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * Owner-only Sunday nudge to download this week's backup.
 *
 * Every salon keeps its week's takings on one phone; a Sunday reminder is the
 * habit that gets a copy off it. Shown only on Sundays (IST, never the
 * browser's zone) and only until a backup is downloaded that same IST day, so
 * a completed download silences it for the rest of the day. Staff never see
 * it — they cannot export, so it would be a dead end for them.
 */
export function BackupReminder() {
  const owner = useOwner();
  // localStorage differs between SSR HTML and the first client render — read
  // it only after mount to keep hydration consistent (same as DataWarnings).
  const [mounted, setMounted] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setMounted(true);
    setSavedAt(getMeta(META_KEYS.sunday));
    // Tick every minute AND whenever the owner returns to the tab: a Sunday
    // reminder must appear the moment the salon opens the app, even if the
    // machine slept through the last minute tick.
    const tick = () => setNow(Date.now());
    const t = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, []);

  if (!mounted || !owner) return null;
  if (!shouldRemindSundayBackup(now, savedAt)) return null;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl bg-gold-soft px-4 py-3 text-sm font-medium">
      <Download className="size-4 shrink-0 text-accent-foreground" />
      <span className="min-w-0 flex-1">
        <strong>Sunday backup day</strong> — download this week&apos;s backup so a lost or damaged
        phone can&apos;t take the week&apos;s bills with it.
      </span>
      <button
        onClick={() => {
          if (busy) return;
          setBusy(true);
          void downloadLocalBackup()
            .then((n) => {
              setSavedAt(Date.now());
              toast.success(`Backup saved · ${n} bills — email or Drive it`);
            })
            .catch((e) => {
              console.error(e);
              toast.error("Could not build the backup");
            })
            .finally(() => setBusy(false));
        }}
        disabled={busy}
        className="tap shrink-0 rounded-xl bg-accent px-4 py-2 font-semibold text-accent-foreground disabled:opacity-60"
      >
        {busy ? "Preparing…" : "Download backup"}
      </button>
    </div>
  );
}
