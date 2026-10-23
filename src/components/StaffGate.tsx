import { useEffect, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Delete, Lock, UserRound } from "lucide-react";
import { db, type Stylist } from "@/lib/db";
import { setOwner, signInStaff, useSession } from "@/lib/lock";

const MAX_ATTEMPTS = 5;
const LOCK_MS = 30_000;

/**
 * Lock screen enforcing staff identity: once any staff member has their own
 * PIN, every bill must be signed in — the signed-in name is stamped as
 * `cashier` on the bill. The owner PIN also works (opens an owner session).
 *
 * Not enforced before the salon sets up its first staff PIN, so existing
 * installs keep working until the owner opts in (Settings → Staff & PINs).
 */
export function StaffGate({ children }: { children: ReactNode }) {
  const session = useSession();
  const [mounted, setMounted] = useState(false);
  const staff = useLiveQuery(() => db.stylists.filter((s) => s.active).toArray(), []) ?? [];
  const settings = useLiveQuery(() => db.settings.get(1));

  // sessionStorage/localStorage reads differ between SSR HTML and the first
  // client render — decide only after mount to avoid hydration mismatches.
  useEffect(() => setMounted(true), []);

  const withPin = staff.filter((s) => s.pin);
  if (!mounted) return null; // matches SSR; decided after hydration
  if (session || !withPin.length) return <>{children}</>;
  return <StaffSignIn staff={withPin} ownerPin={settings?.ownerPin ?? ""} />;
}

type Target = { id: number; name: string } | "owner";

function StaffSignIn({ staff, ownerPin }: { staff: Stylist[]; ownerPin: string }) {
  const [target, setTarget] = useState<Target | null>(null);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState(false);
  const [fails, setFails] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

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

  const press = (d: string) => {
    if (locked || !target) return;
    const next = (pin + d).slice(0, 4);
    setPin(next);
    setErr(false);
    if (next.length !== 4) return;
    const expected = target === "owner" ? ownerPin : staff.find((s) => s.id === target.id)?.pin;
    if (expected && next === expected) {
      if (target === "owner") setOwner(true);
      else signInStaff(target.id, target.name);
      return;
    }
    fail();
  };

  /* ------------------------------ person pick ------------------------------ */
  if (!target) {
    return (
      <div className="mx-auto w-80 text-center">
        <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent-foreground">
          <UserRound />
        </div>
        <h2 className="text-lg font-bold">Who&apos;s at the counter?</h2>
        <p className="mt-1 text-sm text-muted-foreground">
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
          className="tap mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-secondary px-3 py-3 text-sm font-semibold"
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
        {[0, 1, 2, 3].map((i) => (
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
