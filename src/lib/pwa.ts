/**
 * PWA + storage-protection helpers (browser only, SSR-safe).
 *
 * The salon's bills live in IndexedDB on the counter device. Three things
 * keep them safe: persistent storage (blocks browser eviction), a normal
 * browsing session (Incognito / "clear site data" destroys them), and
 * regular backups (Settings). This module powers those guards.
 */

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferred: InstallPromptEvent | null = null;
const installListeners = new Set<() => void>();

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // we render our own Install button
    deferred = e as InstallPromptEvent;
    for (const f of installListeners) f();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    for (const f of installListeners) f();
  });
}

export function subscribeInstall(fn: () => void): () => void {
  installListeners.add(fn);
  return () => installListeners.delete(fn);
}

/** Chrome/Edge offer a real install prompt; Safari (iOS) never does. */
export const canInstall = () => deferred !== null;

export const isStandalone = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.matchMedia?.("(display-mode: standalone)").matches === true ||
      (window.navigator as { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
};

export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!deferred) return "unavailable";
  try {
    await deferred.prompt();
    const choice = await deferred.userChoice;
    return choice.outcome;
  } catch {
    return "dismissed";
  } finally {
    deferred = null;
    for (const f of installListeners) f();
  }
}

/** Register the app service worker (offline shell + installability). */
export function registerServiceWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {
    /* offline shell is best-effort */
  });
}

/**
 * Ask the browser NOT to evict this origin's storage under pressure.
 * Returns true when storage is (already) persistent.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const st = navigator.storage;
    if (!st) return false;
    if (st.persisted && (await st.persisted())) return true;
    if (!st.persist) return false;
    return await st.persist();
  } catch {
    return false;
  }
}

/**
 * Best-effort private-browsing detection: localStorage is unavailable (or
 * resets on close) in Incognito/Private windows on every major browser.
 */
export function isPrivateBrowsing(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const k = "__sb_probe__";
    window.localStorage.setItem(k, "1");
    window.localStorage.removeItem(k);
    return false;
  } catch {
    return true;
  }
}

/** Short human label for storage protection state. */
export async function storageStatus(): Promise<
  "persistent" | "best-effort" | "private" | "unsupported"
> {
  if (isPrivateBrowsing()) return "private";
  if (typeof navigator === "undefined" || !navigator.storage) return "unsupported";
  try {
    if (navigator.storage.persisted && (await navigator.storage.persisted())) return "persistent";
    return "best-effort";
  } catch {
    return "best-effort";
  }
}
