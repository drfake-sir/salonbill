import { useEffect, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { Receipt, Scissors, Settings, History, Lock, Unlock, IndianRupee } from "lucide-react";
import { db, seedIfEmpty } from "@/lib/db";
import { setSession, restoreSession, touchOwner, useSession } from "@/lib/lock";
import { startSyncEngine } from "@/lib/syncClient";
import { registerServiceWorker, requestPersistentStorage } from "@/lib/pwa";
import { BackupReminder, CloudGate, DataWarnings, SyncPill } from "./SyncGate";
import { StaffGate } from "./StaffGate";
import { OwnerOnly } from "./PinGate";
import { SetupScreen } from "./SetupScreen";

const nav = [
  { to: "/", label: "Billing", icon: Receipt },
  { to: "/bills", label: "Bills", icon: History },
  { to: "/earnings", label: "Earnings", icon: IndianRupee },
  { to: "/catalog", label: "Catalog", icon: Scissors },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const session = useSession();
  const path = useRouterState({ select: (st) => st.location.pathname });
  const settings = useLiveQuery(() => db.settings.get(1));
  // Settings stays reachable outside the gates: it is the recovery path
  // (owner PIN, restore backup, exports) and is owner-protected on its own.
  const recovery = path === "/settings";
  // First run: a salon that has never completed setup must set a new owner
  // PIN (and may remove the seeded demo data) before billing. Owner-only.
  const needsSetup = !!settings && !settings.onboarded;

  useEffect(() => {
    // Re-attach this tab's session, seed local demo data, then bring up cloud
    // sync (all idempotent).
    restoreSession();
    void seedIfEmpty().finally(() => startSyncEngine());
    const t = () => touchOwner();
    window.addEventListener("pointerdown", t);
    // Data protection: ask the browser not to evict our storage, and install
    // the offline shell.
    void requestPersistentStorage();
    registerServiceWorker();
    return () => window.removeEventListener("pointerdown", t);
  }, []);

  return (
    <div className="min-h-screen pb-24 md:pb-0 md:pl-24">
      <SyncPill />
      <aside className="fixed inset-x-0 bottom-0 z-30 flex bg-navy pb-[env(safe-area-inset-bottom)] text-sidebar-foreground md:inset-y-0 md:left-0 md:right-auto md:w-24 md:flex-col md:py-5 md:pb-5">
        <div className="hidden md:mb-6 md:grid md:place-items-center">
          <div className="grid size-11 place-items-center rounded-2xl bg-accent font-extrabold text-accent-foreground">
            SB
          </div>
        </div>
        {nav.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            activeOptions={{ exact: true }}
            className="tap flex flex-1 flex-col items-center justify-center gap-1 px-1 pt-2 text-[11px] font-medium opacity-70 md:mx-3 md:flex-none md:rounded-2xl md:py-3 data-[status=active]:bg-sidebar-accent data-[status=active]:text-sidebar-primary data-[status=active]:opacity-100"
          >
            <Icon className="size-5" />
            {label}
          </Link>
        ))}
        <button
          onClick={() => setSession(null)}
          disabled={!session}
          title={session ? "Sign out / switch person" : "Signed out"}
          className="tap flex flex-1 flex-col items-center justify-center gap-1 px-1 pt-2 text-[11px] opacity-70 md:mx-3 md:mt-auto md:flex-none md:rounded-2xl md:py-3"
        >
          {session ? (
            <Unlock className="size-5 text-sidebar-primary" />
          ) : (
            <Lock className="size-5" />
          )}
          <span className="max-w-full truncate">
            {session ? (session.role === "owner" ? "Owner" : session.name) : "Sign in"}
          </span>
        </button>
      </aside>
      <main className="mx-auto max-w-[1400px] p-4 md:p-6">
        <DataWarnings />
        <BackupReminder />
        {recovery ? (
          children
        ) : needsSetup ? (
          <OwnerOnly>
            <SetupScreen />
          </OwnerOnly>
        ) : (
          <CloudGate>
            <StaffGate>{children}</StaffGate>
          </CloudGate>
        )}
      </main>
    </div>
  );
}
