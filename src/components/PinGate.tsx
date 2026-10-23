import { useEffect, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Lock, Delete } from "lucide-react";
import { db } from "@/lib/db";
import { setOwner, useOwner } from "@/lib/lock";

const MAX_ATTEMPTS = 5;
const LOCK_MS = 30_000;

export function PinPad({ onOk }: { onOk?: () => void }) {
  const settings = useLiveQuery(() => db.settings.get(1));
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
  const press = (d: string) => {
    if (locked) return;
    const next = (pin + d).slice(0, 4);
    setPin(next);
    setErr(false);
    if (next.length === 4) {
      if (next === settings?.ownerPin) {
        setOwner(true);
        setFails(0);
        onOk?.();
      } else {
        const f = fails + 1;
        setFails(f);
        setErr(true);
        if (f >= MAX_ATTEMPTS) {
          setLockedUntil(Date.now() + LOCK_MS);
          setFails(0);
        }
        setTimeout(() => setPin(""), 300);
      }
    }
  };
  return (
    <div className="mx-auto w-72 text-center">
      <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-gold-soft text-accent-foreground">
        <Lock />
      </div>
      <h2 className="text-lg font-bold">Owner PIN</h2>
      {settings?.ownerPin === "1234" && (
        <p className="text-sm text-muted-foreground">Default PIN 1234 — change it in Settings</p>
      )}
      {locked && (
        <p className="mt-1 text-sm font-semibold text-destructive">
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
