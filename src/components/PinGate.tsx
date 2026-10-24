import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Lock, Delete } from "lucide-react";
import { toast } from "sonner";
import { db, logAudit } from "@/lib/db";
import { setOwner, useOwner } from "@/lib/lock";
import { recoverOwnerPin } from "@/lib/ownerRecovery";
import { entryTargetLength, hashPin, isPlainPin, isSha256StoredPin, verifyPin } from "@/lib/pins";

const MAX_ATTEMPTS = 5;
const LOCK_MS = 30_000;

export function PinPad({ onOk }: { onOk?: () => void }) {
  const settings = useLiveQuery(() => db.settings.get(1));
  const [pin, setPin] = useState("");
  const [err, setErr] = useState(false);
  const [fails, setFails] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [verifying, setVerifying] = useState(false);
  const [isDefault, setIsDefault] = useState(false);
  // Forgotten-PIN flow: verify the salon cloud PIN on the server, then set a
  // new owner PIN.
  const [mode, setMode] = useState<"pad" | "forgot">("pad");
  const [cloudPin, setCloudPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [forgotErr, setForgotErr] = useState("");
  const [busy, setBusy] = useState(false);

  // Tick while locked so the "try again in Ns" label counts down.
  useEffect(() => {
    if (lockedUntil <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [lockedUntil]);

  // "Still the default PIN?" must work for plain AND migrated (hashed) storage.
  useEffect(() => {
    let live = true;
    const stored = settings?.ownerPin;
    if (stored) {
      void verifyPin(stored, "1234").then((v) => {
        if (live) setIsDefault(v);
      });
    } else {
      setIsDefault(false);
    }
    return () => {
      live = false;
    };
  }, [settings?.ownerPin]);

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

  const attempt = async (entered: string, stored: string) => {
    setVerifying(true);
    try {
      const ok = await verifyPin(stored, entered);
      if (!ok) {
        fail();
        return;
      }
      // Migration at the first successful sign-in: replace a legacy plain or
      // SHA-256 value with its PBKDF2 hash. The update goes through the normal
      // sync outbox, so every device converges on the hash.
      if (isPlainPin(stored) || isSha256StoredPin(stored)) {
        try {
          await db.settings.update(1, { ownerPin: await hashPin(entered) });
        } catch (e) {
          console.warn("owner PIN migration failed (plain PIN still works)", e);
        }
      }
      setOwner(true);
      setFails(0);
      onOk?.();
    } finally {
      setVerifying(false);
    }
  };

  const press = (d: string) => {
    if (locked || verifying) return;
    const stored = settings?.ownerPin;
    if (stored === undefined) return; // settings still loading — never false-fail
    const target = entryTargetLength(stored);
    if (target === null) {
      fail(); // no usable PIN configured (matches the old falsy-expected path)
      return;
    }
    const next = (pin + d).slice(0, target);
    setPin(next);
    setErr(false);
    if (next.length === target) void attempt(next, stored);
  };

  const dots = entryTargetLength(settings?.ownerPin) ?? 4;

  const submitForgot = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setForgotErr("");
    try {
      // Server verifies the cloud PIN (existing lockout applies there), then
      // the new owner PIN is hashed before storage and syncs like any change.
      const r = await recoverOwnerPin(cloudPin, newPin);
      if (!r.ok) {
        setForgotErr(r.error);
        return;
      }
      try {
        await logAudit("pin.recover", "owner PIN reset via salon cloud PIN");
      } catch {
        /* audit is best-effort */
      }
      toast.success("Owner PIN reset — use the new PIN from now on");
      setOwner(true);
      onOk?.();
    } finally {
      setBusy(false);
    }
  };

  if (mode === "forgot") {
    return (
      <div className="mx-auto w-72 text-center">
        <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-gold-soft text-accent-foreground">
          <Lock />
        </div>
        <h2 className="text-lg font-bold">Reset owner PIN</h2>
        <p className="text-sm text-muted-foreground">
          Enter the salon cloud PIN (the one devices use to connect), then choose a new owner PIN.
        </p>
        <form onSubmit={submitForgot} className="my-5 space-y-3">
          <input
            value={cloudPin}
            onChange={(e) => setCloudPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
            inputMode="numeric"
            autoComplete="off"
            placeholder="Salon cloud PIN (6-8 digits)"
            aria-label="Salon cloud PIN"
            className="tap w-full rounded-xl border border-input bg-card px-4 py-3 text-center text-2xl font-bold tracking-[0.4em] outline-none focus:ring-2 focus:ring-ring"
          />
          <input
            value={newPin}
            onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
            inputMode="numeric"
            autoComplete="off"
            placeholder="New owner PIN (6-8 digits)"
            aria-label="New owner PIN"
            className="tap w-full rounded-xl border border-input bg-card px-4 py-3 text-center text-2xl font-bold tracking-[0.4em] outline-none focus:ring-2 focus:ring-ring"
          />
          {forgotErr && <p className="text-sm font-medium text-destructive">{forgotErr}</p>}
          <button
            type="submit"
            disabled={busy}
            className="tap w-full rounded-2xl bg-accent py-3 font-semibold text-accent-foreground disabled:opacity-60"
          >
            {busy ? "Checking…" : "Reset owner PIN"}
          </button>
        </form>
        <button
          onClick={() => {
            setMode("pad");
            setForgotErr("");
          }}
          className="tap text-sm font-medium text-primary"
        >
          ← Back to PIN pad
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-72 text-center">
      <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-gold-soft text-accent-foreground">
        <Lock />
      </div>
      <h2 className="text-lg font-bold">Owner PIN</h2>
      {isDefault && (
        <p className="text-sm text-muted-foreground">Default PIN 1234 — change it in Settings</p>
      )}
      {locked && (
        <p className="mt-1 text-sm font-semibold text-destructive">
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
      <button
        onClick={() => {
          setMode("forgot");
          setForgotErr("");
        }}
        className="tap mt-5 text-sm font-medium text-primary"
      >
        Forgot PIN?
      </button>
    </div>
  );
}

export function OwnerOnly({ children }: { children: ReactNode }) {
  const owner = useOwner();
  if (!owner)
    return (
      <div className="grid min-h-[70vh] place-items-center">
        <PinPad />
      </div>
    );
  return <>{children}</>;
}
