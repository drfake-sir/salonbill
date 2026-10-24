import { useEffect, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Delete, Lock, UserRound } from "lucide-react";
import { db, type Stylist } from "@/lib/db";
import { setOwner, signInStaff, useSession } from "@/lib/lock";
import { entryTargetLength, hashPin, isPlainPin, isSha256StoredPin, verifyPin } from "@/lib/pins";

const MAX_ATTEMPTS = 5;
const LOCK_MS = 30_000;

/**
 * Lock screen enforcing staff identity: once any staff member has their own
 * PIN, every bill must be signed in — the signed-in name is stamped as
 * `cashier` on the bill. The owner PIN also works (opens an owner session).
 *
 * Not enforced before the salon sets up its first staff PIN, so existing
 * installs keep working until the owner opts in (Settings → Staff & PINs).
 *
 * PINs are verified against a salted hash (`s1$…`); legacy plain PINs still
 * verify and are migrated to the hash on their first successful sign-in.
 */
export function StaffGate({ children }: { children: ReactNode }) {
  const session = useSession();
  const [mounted, setMounted] = useState(false);
  const staff = useLiveQuery(() => db.stylists.filter((s) => s.active).toArray(), []) ?? [];
  const settings = useLiveQuery(() => db.settings.get(1));

  // sessionStorage/localStorage reads differ between SSR HTML and the first
  // client render — decide only after mount to avoid hydration mismatches.
  useEffect(() => setMounted(true), []);
  if (!mounted) return null; // matches SSR; decided after hydration
  if (session || !staff.some((s) => s.pin)) return <>{children}</>;
  return (
    <StaffSignIn
      staff={staff.filter((s) => s.pin)}
      ownerPin={settings?.ownerPin ?? ""}
      settingsLoaded={!!settings}
    />
  );
}

type Target = { id: number; name: string } | "owner";

function StaffSignIn({
  staff,
  ownerPin,
  settingsLoaded,
}: {
  staff: Stylist[];
  ownerPin: string;
  settingsLoaded: boolean;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState(false);
  const [fails, setFails] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [verifying, setVerifying] = useState(false);

  // Tick while locked so the "try again in Ns" label counts down.
  useEffect(() => {
    if (lockedUntil <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [lockedUntil]);

  const locked = lockedUntil > now;

  const fail = () => {
    const f = fails + 1;
    setFails(f);
    setErr(true);
    if (f >= MAX_ATTEMPTS) {
      setLockedUntil(Date.now() + LOCK_MS);
      setFails(0);
    }
    setTimeout(() => setPin(""), 300);
  };

  const storedFor = (t: Target): string | undefined =>
    t === "owner" ? ownerPin : staff.find((s) => s.id === t.id)?.pin;

  const attempt = async (entered: string, stored: string, who: Target) => {
    setVerifying(true);
    try {
      const ok = await verifyPin(stored, entered);
      if (!ok) {
        fail();
        return;
      }
      // Migration at the first successful sign-in: swap a legacy plain or
      // SHA-256 PIN for its PBKDF2 hash. The row update syncs like any change.
      if (isPlainPin(stored) || isSha256StoredPin(stored)) {
        try {
          const hashed = await hashPin(entered);
          if (who === "owner") await db.settings.update(1, { ownerPin: hashed });
          else await db.stylists.update(who.id, { pin: hashed });
        } catch (e) {
          console.warn("PIN migration failed (plain PIN still works)", e);
        }
      }
      if (who === "owner") setOwner(true);
      else signInStaff(who.id, who.name);
    } finally {
      setVerifying(false);
    }
  };

  const press = (d: string) => {
    if (locked || verifying || !target) return;
    const stored = storedFor(target);
    if (target === "owner" && !settingsLoaded) return; // settings still loading
    const storedLen = entryTargetLength(stored);
    if (storedLen === null) {
      fail(); // no PIN configured for this target (matches the old falsy path)
      return;
    }
    const next = (pin + d).slice(0, storedLen);
    setPin(next);
    setErr(false);
    if (next.length === storedLen && stored !== undefined) void attempt(next, stored, target);
  };

  const dots = target ? (entryTargetLength(storedFor(target)) ?? 4) : 4;

  /* ------------------------------ person pick ------------------------------ */
  if (!target) {
    return (
      <div className="mx-auto w-80 text-center">
        <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent-foreground">
          <UserRound />
        </div>
        <h2 className="text-lg font-bold">Who&apos;s at the counter?</h2>
        <p className="text-sm text-muted-foreground">
          Sign in with your own PIN — every bill you save is stamped with your name as cashier.
        </p>
        <div className="mt-5 grid grid-cols-2 gap-3">
          {staff.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setTarget({ id: s.id!, name: s.name });
                setPin("");
                setErr(false);
              }}
              className="tap flex items-center gap-2 rounded-2xl bg-card px-3 py-3 text-left font-semibold shadow-soft"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-sm font-bold">
                {s.name.slice(0, 1)}
              </span>
              <span className="truncate">{s.name}</span>
            </button>
          ))}
        </div>
        <button
          onClick={() => {
            setTarget("owner");
            setPin("");
            setErr(false);
          }}
          className="tap mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-secondary px-4 py-2.5 text-sm font-semibold"
        >
          <Lock className="size-4" /> Owner sign-in
        </button>
      </div>
    );
  }

  /* -------------------------------- pin pad -------------------------------- */
  return (
    <div className="mx-auto w-72 text-center">
      <div className="mx-auto mb-3 grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent-foreground">
        {target === "owner" ? <Lock /> : <UserRound />}
      </div>
      <h2 className="text-lg font-bold">{target === "owner" ? "Owner PIN" : target.name}</h2>
      <button
        onClick={() => {
          setTarget(null);
          setPin("");
          setErr(false);
        }}
        className="tap text-sm font-medium text-primary"
      >
        ← Not you?
      </button>
      {locked && (
        <p className="mt-2 text-sm font-semibold text-destructive">
          Too many attempts — try again in {Math.ceil((lockedUntil - now) / 1000)}s
        </p>
      )}
      <div className={`my-5 flex justify-center gap-3 ${err ? "animate-pulse" : ""}`}>
        {Array.from({ length: dots }, (_, i) => (
          <span
            key={i}
            className={`size-3.5 rounded-full ${i < pin.length ? (err ? "bg-destructive" : "bg-primary") : "bg-border"}`}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0"].map((d, i) =>
          d ? (
            <button
              key={i}
              onClick={() => press(d)}
              disabled={locked}
              className="tap rounded-2xl bg-card text-xl font-semibold shadow-soft hover:bg-secondary disabled:opacity-40"
            >
              {d}
            </button>
          ) : (
            <span key={i} />
          ),
        )}
        <button
          onClick={() => setPin(pin.slice(0, -1))}
          disabled={locked}
          className="tap grid place-items-center rounded-2xl text-muted-foreground hover:bg-secondary disabled:opacity-40"
          aria-label="Delete"
        >
          <Delete />
        </button>
      </div>
    </div>
  );
}
