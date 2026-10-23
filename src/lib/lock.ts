import { useSyncExternalStore } from "react";

/**
 * Who is at the counter.
 *
 *  - staff session: a staff member signed in with their OWN PIN; stamped as
 *    `cashier` on every bill they save.
 *  - owner session: the owner PIN; additionally unlocks cancel, monthly
 *    totals, exports and settings.
 *
 * The session lives in sessionStorage (per tab) and auto-locks after 5 min of
 * no interaction, so an abandoned counter never bills under the wrong person.
 */

export type Session = {
  role: "staff" | "owner";
  /** Stylist row id (staff only) — stamped on bills. */
  staffId?: number | undefined;
  name: string;
};

const SESSION_KEY = "sb-session";
const LOCK_MS = 5 * 60_000; // auto-lock after 5 min without touching the screen

function readStored(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (s && (s.role === "staff" || s.role === "owner") && typeof s.name === "string") return s;
    return null;
  } catch {
    return null;
  }
}

let session: Session | null = null; // restored from sessionStorage after mount (SSR-safe)
let timer: ReturnType<typeof setTimeout> | undefined;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** Re-attach the stored session (per-tab) once the app boots in the browser. */
export function restoreSession() {
  const s = typeof window === "undefined" ? null : readStored();
  if (s && !session) {
    session = s;
    armAutoLock();
    emit();
  }
}

function armAutoLock() {
  clearTimeout(timer);
  if (session) timer = setTimeout(() => setSession(null), LOCK_MS);
}

export function setSession(s: Session | null) {
  session = s;
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode */
  }
  armAutoLock();
  emit();
}

/** Staff member signed in with their own PIN. */
export function signInStaff(staffId: number, name: string) {
  setSession({ role: "staff", staffId, name });
}

/** Owner signed in with the owner PIN. Kept as setOwner for older call sites. */
export function signInOwner() {
  setSession({ role: "owner", name: "Owner" });
}
export const setOwner = (v: boolean) => (v ? signInOwner() : setSession(null));

/** Reset the auto-lock timer — called on every touch while signed in. */
export function touchOwner() {
  if (session) armAutoLock();
}

function snapshot(): Session | null {
  return session;
}

export function useSession(): Session | null {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    snapshot,
    () => null,
  );
}

/** True while the OWNER PIN is unlocked (cancel / totals / export / settings). */
export function useOwner(): boolean {
  return useSession()?.role === "owner";
}
