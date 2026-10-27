import { useEffect, useState } from "react";
import { getDeviceName } from "@/lib/db";
import { setSession, useSession } from "@/lib/lock";

/**
 * "Who is using this device" — the left half of the in-flow status bar.
 *
 * The owner bills at the counter too, so the signed-in person and this
 * device's name have to be readable at a glance without opening anything.
 * It is a normal flow element inside `SyncPill` (never floating, never
 * covering a control); only its small sheet is an overlay, and only because a
 * sheet is what it is.
 *
 * Phones show the avatar + first name only — the device name lives in the
 * sheet, so the chip can never crowd the sync status next to it.
 */

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? full;
}

export function PersonChip() {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  // localStorage differs between the SSR HTML and the first client render.
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const device = mounted ? getDeviceName() : "";
  const owner = session?.role === "owner";
  const name = session ? (owner ? "Owner" : session.name) : null;
  const initial = name ? firstName(name).charAt(0).toUpperCase() : "?";

  const endSession = () => {
    setSession(null);
    setOpen(false);
  };

  return (
    <>
      <button
        data-testid="person-chip"
        onClick={() => setOpen(true)}
        title={name ? `Signed in as ${name}` : "Locked — tap to sign in"}
        className="tap flex shrink-0 items-center gap-2 border-r border-border/60 px-3 py-2 text-left"
      >
        <span
          data-testid="person-avatar"
          className={`grid size-8 shrink-0 place-items-center rounded-full text-sm font-extrabold ${
            owner
              ? "bg-accent text-accent-foreground"
              : name
                ? "bg-primary text-primary-foreground"
                : "bg-muted-foreground/20 text-muted-foreground"
          }`}
          aria-hidden
        >
          {initial}
        </span>
        <span className="min-w-0 leading-tight">
          {/* Phones: initial + first name only (the device lives in the sheet). */}
          <span
            data-testid="person-name"
            className={`block whitespace-nowrap text-sm font-semibold md:hidden ${name ? "" : "text-muted-foreground"}`}
          >
            {name ? firstName(name) : "Locked - tap to sign in"}
          </span>
          <span
            data-testid="person-name-wide"
            className={`hidden whitespace-nowrap text-sm font-semibold md:inline ${name ? "" : "text-muted-foreground"}`}
          >
            {name ?? "Locked - tap to sign in"}
          </span>
          {device && (
            <span
              data-testid="person-device"
              className="hidden max-w-28 truncate text-[11px] text-muted-foreground md:block"
            >
              {device}
            </span>
          )}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Who is using this device"
          className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
        >
          <div className="w-full max-w-sm rounded-3xl bg-card p-6 shadow-soft">
            <h2 className="text-lg font-extrabold">Who is using this device?</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Signed in as{" "}
              <span className="font-semibold text-foreground" data-testid="sheet-person">
                {name ?? "nobody (locked)"}
              </span>
            </p>
            <p className="text-sm text-muted-foreground">
              Device{" "}
              <span className="font-semibold text-foreground" data-testid="sheet-device">
                {device || "Unnamed device"}
              </span>
            </p>
            <div className="mt-4 space-y-2">
              <button
                onClick={endSession}
                data-testid="switch-person"
                className="tap w-full rounded-xl bg-accent py-3 font-semibold text-accent-foreground"
              >
                Switch person
              </button>
              <button
                onClick={endSession}
                data-testid="lock-now"
                className="tap w-full rounded-xl bg-secondary py-3 font-semibold"
              >
                Lock now
              </button>
              <button
                onClick={() => setOpen(false)}
                className="tap w-full rounded-xl py-2 text-sm font-medium text-muted-foreground"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
