import { useEffect, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Download,
  Loader2,
  ShieldAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { askDeviceName, db, getDeviceName, setDeviceName } from "@/lib/db";
import { useOwner } from "@/lib/lock";
import { META_KEYS, downloadLocalBackup, getMeta, shouldRemindSundayBackup } from "@/lib/export";
import {
  connect,
  fetchCloudStatus,
  getCachedCloudStatus,
  getDeviceId,
  getSyncStatus,
  hasToken,
  isUnsyncedStale,
  isFirstSyncDone,
  subscribeSync,
  syncNow,
  type SyncPhase,
  type SyncStatus,
} from "@/lib/syncClient";
import { isPrivateBrowsing } from "@/lib/pwa";
import { StaffGate } from "./StaffGate";
import { SetupScreen } from "./SetupScreen";

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
  const waiting = queuedBills || queued;

  // Desktop keeps the full status line; phones get the short form (the dot
  // carries the state) and open the sheet for the details.
  const full = !connected
    ? "Not connected"
    : syncing
      ? "Syncing…"
      : online
        ? s.lastSyncAt
          ? `Online · last sync ${timeAgo(s.lastSyncAt, now)}`
          : "Online"
        : waiting
          ? `Offline · ${queuedBills ? `${queuedBills} bill${queuedBills === 1 ? "" : "s"}` : `${queued} change${queued === 1 ? "" : "s"}`} waiting`
          : "Offline";
  const short = !connected
    ? "Not connected"
    : syncing
      ? "Syncing…"
      : online
        ? "Online"
        : waiting
          ? `Offline · ${waiting} waiting`
          : "Offline";
  const stateText = online ? "" : connected ? "text-destructive" : "text-muted-foreground";

  return (
    <>
      {/* Part of the normal page flow (NOT floating): a full-width status
          line can never sit on top of a control on any route or overlay —
          overlays keep their own z-indexes above it. */}
      <button
        data-testid="sync-status-line"
        onClick={() => setOpen(true)}
        title={s.error ?? "Cloud sync — tap for details"}
        className="tap flex w-full items-center gap-2 border-b border-border/60 bg-card px-4 text-left text-sm font-semibold md:px-6"
      >
        {syncing ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" />
        ) : (
          <span
            aria-hidden
            className={`size-2.5 shrink-0 rounded-full ${
              online ? "bg-success" : connected ? "bg-destructive" : "bg-muted-foreground"
            }`}
          />
        )}
        {/* Phones: short text. Desktop: the full line with last-sync time. */}
        <span className={`truncate md:hidden ${stateText}`}>{short}</span>
        <span className={`hidden truncate md:inline ${stateText}`}>{full}</span>
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
 * What the cloud told us about itself, for a device that has no sync token:
 * "probing" = the side-effect-free status request is in flight, "known" = it
 * answered (a salon PIN exists or not), "error" = it could not be reached.
 */
export type CloudProbe = "probing" | "known" | "error";

export type SalonGateInput = {
  /** SSR hydration finished — localStorage-based inputs are trustworthy. */
  mounted: boolean;
  /** This device holds a sync token (it has joined the salon cloud). */
  hasToken: boolean;
  probe: CloudProbe;
  /** Only meaningful when probe === "known": cloud already has a salon PIN. */
  cloudHasPin: boolean;
  /** Local settings row loaded? null = still loading, else its onboarded flag. */
  onboarded: boolean | null;
  /** This device's first full cloud copy exists. */
  firstSyncDone: boolean;
  phase: SyncPhase;
};

export type SalonGateView =
  | { kind: "skeleton" }
  | { kind: "syncing"; why: "status" | "connect" | "first-sync" | "hydrate" }
  | { kind: "connect"; mode: "enter" | "create" | "unknown" }
  | { kind: "setup" }
  | { kind: "app"; firstSyncPending: boolean };

/**
 * Decide what a device sees before the app. The CLOUD decides, never the
 * local seed:
 *
 *  - no token + cloud already has a salon PIN → connect ("Enter your salon
 *    PIN"). Never setup, never a create-PIN screen: a later device can't be
 *    offered the salon's owner setup just because its local seed still says
 *    "not onboarded".
 *  - no token + cloud CONFIRMED empty (probe succeeded) + local setup not
 *    finished → setup: only a genuinely first device gets this.
 *  - no token + probe unreachable → connect with neutral wording. Never
 *    setup: an unreachable cloud must not be mistaken for an empty one.
 *  - token → app once connect + the first pull finished; before that a short
 *    "Syncing your salon…" state, except when the first sync is failing
 *    offline, where the existing keep-billing warning applies so a network
 *    outage can never lock the counter out for good.
 *
 * Nothing here ever signs anyone in: connecting grants no session and no
 * role, and the owner session comes only from the owner PIN (StaffGate) or
 * from finishing setup on the first device (SetupScreen).
 */
export function decideSalonGate(i: SalonGateInput): SalonGateView {
  if (!i.mounted) return { kind: "skeleton" };

  if (!i.hasToken) {
    if (i.probe === "probing") return { kind: "syncing", why: "status" };
    if (i.probe === "error") return { kind: "connect", mode: "unknown" };
    if (i.cloudHasPin) return { kind: "connect", mode: "enter" }; // device 2/3
    if (i.onboarded === null) return { kind: "syncing", why: "hydrate" };
    // Cloud confirmed empty. The device that already finished setup but has
    // no token yet (reload before connecting) is asked to CREATE the salon
    // PIN — only a never-set-up device sees the setup screen.
    return i.onboarded ? { kind: "connect", mode: "create" } : { kind: "setup" };
  }

  if (!i.firstSyncDone) {
    if (i.phase === "error") return { kind: "app", firstSyncPending: true };
    return { kind: "syncing", why: "first-sync" };
  }
  if (i.onboarded === null) return { kind: "syncing", why: "hydrate" };
  return { kind: "app", firstSyncPending: false };
}

/**
 * The app's outer gate, replacing the old local-seed gate: status probe →
 * connect / setup / short syncing state, then the locked person picker.
 * Settings stays outside it (recovery path, owner-protected on its own).
 */
export function SalonGate({ children }: { children: ReactNode }) {
  const s = useSyncStatus();
  const [mounted, setMounted] = useState(false);
  const settings = useLiveQuery(() => db.settings.get(1));
  const onboarded = settings === undefined ? null : !!settings.onboarded;
  const [probe, setProbe] = useState<CloudProbe>("probing");
  const [cloudHasPin, setCloudHasPin] = useState(false);
  const [named, setNamed] = useState(false);
  const hasTok = mounted && hasToken();

  useEffect(() => {
    setMounted(true);
    setNamed(!!getDeviceName()); // already named → the dialog never reappears
  }, []);

  // Ask the cloud (no PIN, no token, no side effects) whether a salon is
  // configured there — only while this device has never connected. Re-ask
  // when back online so an offline first open doesn't stay on "unknown".
  useEffect(() => {
    if (!mounted || hasTok) return;
    let live = true;
    const run = async () => {
      const r = await fetchCloudStatus();
      if (!live) return;
      if (r.ok) {
        setProbe("known");
        setCloudHasPin(r.salonPinSet);
      } else {
        setProbe("error");
      }
    };
    void run();
    window.addEventListener("online", run);
    return () => {
      live = false;
      window.removeEventListener("online", run);
    };
  }, [mounted, hasTok]);

  const view = decideSalonGate({
    mounted,
    hasToken: hasTok,
    probe,
    cloudHasPin,
    onboarded,
    firstSyncDone: s.firstSyncDone,
    phase: s.phase,
  });

  if (view.kind === "skeleton") return <GateSkeleton />;
  if (view.kind === "syncing") return <SyncingSalon why={view.why} />;
  if (view.kind === "connect") return <CloudSetup s={s} mode={view.mode} />;
  if (view.kind === "setup") return <SetupScreen />;
  return (
    <>
      {view.firstSyncPending && (
        <div className="mb-3 flex items-start gap-2 rounded-2xl bg-gold-soft px-4 py-3 text-sm font-medium">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-accent-foreground" />
          <span>
            The first cloud copy of this device is still uploading. You can keep billing — it
            retries automatically.
          </span>
        </div>
      )}
      {!named && (
        <DeviceNameDialog
          suggested={`Device ${getDeviceId().slice(-4)}`}
          onDone={() => setNamed(true)}
        />
      )}
      <StaffGate>{children}</StaffGate>
    </>
  );
}

/** Short interstitial while connect + first pull run — never setup. */
function SyncingSalon({ why }: { why: "status" | "connect" | "first-sync" | "hydrate" }) {
  const sub =
    why === "hydrate"
      ? "Reading this device's settings…"
      : why === "first-sync"
        ? "Uploading this device's first cloud copy…"
        : "Connecting and pulling your salon's data — this only takes a moment.";
  return (
    <div className="grid min-h-[70vh] place-items-center" role="status" aria-live="polite">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent-foreground">
          <Loader2 className="size-6 animate-spin text-accent-foreground" />
        </div>
        <h1 className="text-lg font-extrabold">Syncing your salon…</h1>
        <p className="mt-1 text-sm text-muted-foreground">{sub}</p>
      </div>
    </div>
  );
}

/**
 * One-time, per-device naming step shown AFTER the gate passes. Purely local
 * (it never syncs — each device keeps its own name) and grants no role: it
 * only stamps bills with which phone wrote them. In-app dialog, never
 * window.prompt; an empty answer or "Use default name" both fall back
 * through askDeviceName, so the step completes exactly once.
 */
function DeviceNameDialog({ suggested, onDone }: { suggested: string; onDone: () => void }) {
  const [value, setValue] = useState(suggested);
  const save = (answer: string) => {
    setDeviceName(askDeviceName(suggested, () => answer));
    onDone();
  };
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Name this device"
    >
      <div className="w-full max-w-sm rounded-3xl bg-card p-6 shadow-soft">
        <h2 className="text-lg font-extrabold">Name this device</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Shown on every bill this phone creates, so the salon can tell its devices apart. One-time
          — rename it any time in Settings.
        </p>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value.slice(0, 40))}
          aria-label="Device name"
          placeholder={suggested}
          className="tap mt-4 w-full rounded-xl border border-input bg-card px-4 py-3 outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="mt-4 space-y-2">
          <button
            onClick={() => save(value)}
            className="tap w-full rounded-xl bg-accent py-3 font-semibold text-accent-foreground"
          >
            Save name
          </button>
          <button
            onClick={() => save(suggested)}
            className="tap w-full rounded-xl bg-secondary py-2.5 text-sm font-semibold"
          >
            Use default name ({suggested})
          </button>
        </div>
      </div>
    </div>
  );
}

function GateSkeleton() {
  return (
    <div className="grid min-h-[70vh] place-items-center">
      <div className="h-10 w-40 animate-pulse rounded-full bg-card" />
    </div>
  );
}

function CloudSetup({ s, mode }: { s: SyncStatus; mode: "enter" | "create" | "unknown" }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const connected = hasToken();
  const syncing = s.phase === "syncing" || s.phase === "connecting";
  // Wording comes from the cloud's status signal, never from the local seed —
  // and it says nothing about whether any PIN is correct.
  const placeholder =
    mode === "enter"
      ? "Enter your salon PIN"
      : mode === "create"
        ? "Create a salon PIN (first device only)"
        : "Salon PIN (6-8 digits)";
  const helper =
    mode === "enter"
      ? "Every device in the salon signs in with this same PIN — after connecting you land on the locked person picker."
      : "First device in the salon sets the PIN; every other device uses the same PIN.";

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
              placeholder={placeholder}
              aria-label={placeholder}
              className="tap w-full rounded-xl border border-input bg-card px-4 py-3 text-center text-2xl font-bold tracking-[0.4em] outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground">{helper}</p>
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
  // Same cloud status signal the gate uses (cached by the gate's probe), so
  // the wording here matches: configured cloud → "Enter", empty → "Create".
  const cloudPin = getCachedCloudStatus();

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
                : cloudPin === null
                  ? "Enter the salon PIN so every device shares the same data. The first device sets the PIN."
                  : cloudPin.salonPinSet
                    ? "Enter the salon PIN so every device shares the same data."
                    : "Create the salon PIN now — every other device in the salon will use this same PIN."}
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
              placeholder={
                cloudPin === null
                  ? "Salon PIN"
                  : cloudPin.salonPinSet
                    ? "Enter your salon PIN"
                    : "Create a salon PIN (first device only)"
              }
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
