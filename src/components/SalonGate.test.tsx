import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SalonGate, decideSalonGate } from "./SyncGate";

/**
 * The multi-device gate (SalonGate / decideSalonGate).
 *
 * The bug this replaces: AppShell decided "Set up your salon" from the LOCAL
 * seed (`settings.onboarded` written by seedIfEmpty), so every new device
 * showed the owner setup, was asked to (re)create the PIN, and came out
 * signed in as the OWNER. The gate must decide from the CLOUD:
 *
 *  - device 2/3 (cloud onboarded) → connect screen, "Enter your salon PIN",
 *    never setup, never an owner session;
 *  - fresh connected device → one-time in-app device-name dialog, then the
 *    LOCKED person picker;
 *  - genuinely empty cloud → setup (first device only);
 *  - offline/failed probe → neutral connect wording, never setup;
 *  - "Syncing your salon…" until connect + first pull finish.
 */

/* --------------------------------- fixtures -------------------------------- */

const h = vi.hoisted(() => ({
  /** settings row returned by the (mocked) live query; undefined = loading. */
  settings: undefined as Record<string, unknown> | undefined,
  stylists: [] as Record<string, unknown>[],
  deviceName: "",
  token: false,
  firstSyncDone: false,
  phase: "disabled" as string,
  probe: { ok: true, salonPinSet: true } as
    { ok: true; salonPinSet: boolean } | { ok: false; error: string },
  connectResult: { ok: true } as { ok: boolean; error?: string },
  connectCalls: [] as (string | undefined)[],
  probeCalls: 0,
}));

const lk = vi.hoisted(() => ({
  session: null as { role: "staff" | "owner"; name: string } | null,
  setOwner: vi.fn(),
  signInOwner: vi.fn(),
  signInStaff: vi.fn(),
  setSession: vi.fn(),
}));

/* ---------------------------------- mocks ---------------------------------- */

// Live queries resolve from fixtures: Dexie has no IndexedDB in jsdom, and the
// queries are only ever "which table" distinguishable by their source.
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => {
    const src = String(fn);
    if (src.includes("stylists")) return h.stylists;
    if (src.includes("settings")) return h.settings;
    return undefined;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    settings: {
      get: async () => h.settings,
      update: async (_key: number, patch: Record<string, unknown>) => {
        h.settings = { ...(h.settings ?? { id: 1 }), ...patch };
        return 1;
      },
    },
    stylists: { filter: () => ({ toArray: async () => h.stylists }) },
    services: { toArray: async () => [] },
    customers: { toArray: async () => [] },
    bills: { toArray: async () => [] },
    syncQueue: {
      count: async () => 0,
      filter: () => ({ count: async () => 0 }),
      clear: async () => {},
      hook: () => {},
    },
    audit: { add: async () => 1 },
  },
  logAudit: async () => {},
  deviceLabel: () => "Unknown device",
  // Same contract as lib/db: never throws, always returns a name.
  askDeviceName: (
    suggested: string,
    ask?: (message: string, defaultValue: string) => string | null,
  ) => {
    let answer: unknown = null;
    try {
      answer = ask ? ask("Name this device", suggested) : null;
    } catch {
      answer = null;
    }
    const clean = typeof answer === "string" ? answer.trim().slice(0, 40) : "";
    return clean || suggested;
  },
  getDeviceName: () => h.deviceName,
  setDeviceName: (name: string) => {
    h.deviceName = name;
  },
}));

vi.mock("@/lib/syncClient", () => ({
  connect: vi.fn(async (pin?: string) => {
    h.connectCalls.push(pin);
    if (h.connectResult.ok) {
      h.token = true; // what the real connect does on success
    }
    return h.connectResult;
  }),
  fetchCloudStatus: vi.fn(async () => {
    h.probeCalls++;
    return h.probe;
  }),
  getCachedCloudStatus: () => (h.probe.ok ? { salonPinSet: h.probe.salonPinSet } : null),
  getDeviceId: () => "dev-test",
  getSyncStatus: () => ({
    phase: h.phase,
    needsPin: false,
    lastSyncAt: h.firstSyncDone ? Date.now() : null,
    error: null,
    firstSyncDone: h.firstSyncDone,
  }),
  subscribeSync: () => () => {},
  hasToken: () => h.token,
  isFirstSyncDone: () => h.firstSyncDone,
  everConnected: () => h.token,
  isUnsyncedStale: () => false,
  syncNow: vi.fn(async () => {}),
  UNSYNCED_WARN_MS: 3 * 60 * 60 * 1000,
}));

vi.mock("@/lib/lock", () => ({
  useSession: () => lk.session,
  useOwner: () => lk.session?.role === "owner",
  setOwner: lk.setOwner,
  signInOwner: lk.signInOwner,
  signInStaff: lk.signInStaff,
  setSession: lk.setSession,
  touchOwner: vi.fn(),
  restoreSession: vi.fn(),
}));

vi.mock("sonner", () => {
  const toast = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  });
  return { toast };
});

// SetupScreen offers NO demo-cleanup step any more (a real salon must never
// see one), so nothing here pulls @/lib/demoData in.

function reset() {
  h.settings = { id: 1, onboarded: false };
  h.stylists = [
    { id: 1, name: "Karthik", active: true, pin: "s1$8$1$aa$bb" },
    { id: 2, name: "Priya", active: true, pin: "s1$8$1$cc$dd" },
  ];
  h.deviceName = "";
  h.token = false;
  h.firstSyncDone = false;
  h.phase = "disabled";
  h.probe = { ok: true, salonPinSet: true };
  h.connectResult = { ok: true };
  h.connectCalls = [];
  h.probeCalls = 0;
  lk.session = null;
  lk.setOwner.mockClear();
  lk.signInOwner.mockClear();
  lk.signInStaff.mockClear();
  localStorage.clear();
}

beforeEach(reset);

const renderGate = () =>
  render(
    <SalonGate>
      <div data-testid="app-content">billing screen</div>
    </SalonGate>,
  );

/* --------------------------- decision table (pure) ------------------------- */

describe("decideSalonGate — the cloud decides, never the local seed", () => {
  const base = {
    mounted: true,
    hasToken: false,
    probe: "known" as const,
    cloudHasPin: true,
    onboarded: false, // local seed still says "not onboarded" — the bug's input
    firstSyncDone: false,
    phase: "disabled" as const,
  };

  it("device 2 (cloud has a PIN) → connect 'enter', even with onboarded=false locally", () => {
    expect(decideSalonGate(base)).toEqual({ kind: "connect", mode: "enter" });
  });

  it("device 3 (cloud has a PIN) → same connect 'enter', never setup", () => {
    const v = decideSalonGate({ ...base, onboarded: false });
    expect(v.kind).toBe("connect");
    expect(v).toEqual({ kind: "connect", mode: "enter" });
    expect(v).not.toEqual({ kind: "setup" });
  });

  it("genuinely empty cloud + local setup unfinished → setup (first device)", () => {
    expect(decideSalonGate({ ...base, cloudHasPin: false })).toEqual({ kind: "setup" });
  });

  it("empty cloud but setup already finished (reload before connect) → create the salon PIN", () => {
    expect(decideSalonGate({ ...base, cloudHasPin: false, onboarded: true })).toEqual({
      kind: "connect",
      mode: "create",
    });
  });

  it("cloud unreachable → neutral connect, NEVER setup (an offline cloud is not an empty cloud)", () => {
    expect(decideSalonGate({ ...base, probe: "error" })).toEqual({
      kind: "connect",
      mode: "unknown",
    });
  });

  it("probe in flight → short syncing state", () => {
    expect(decideSalonGate({ ...base, probe: "probing" })).toEqual({
      kind: "syncing",
      why: "status",
    });
  });

  it("token + first pull running → 'Syncing your salon…' state, not setup", () => {
    expect(
      decideSalonGate({ ...base, hasToken: true, phase: "connecting", onboarded: true }),
    ).toEqual({ kind: "syncing", why: "first-sync" });
  });

  it("token + first pull done → app", () => {
    expect(
      decideSalonGate({
        ...base,
        hasToken: true,
        firstSyncDone: true,
        phase: "online",
        onboarded: true,
      }),
    ).toEqual({ kind: "app", firstSyncPending: false });
  });

  it("failed first sync offline → app with the keep-billing warning (billing never locks)", () => {
    expect(decideSalonGate({ ...base, hasToken: true, phase: "error", onboarded: true })).toEqual({
      kind: "app",
      firstSyncPending: true,
    });
  });

  it("OFFLINE RELOAD of a synced device → app, never setup and never connect", () => {
    const v = decideSalonGate({
      ...base,
      hasToken: true,
      firstSyncDone: true,
      phase: "error",
      probe: "error",
      onboarded: true,
    });
    expect(v).toEqual({ kind: "app", firstSyncPending: false });
  });

  it("pre-hydration render stays neutral", () => {
    expect(decideSalonGate({ ...base, mounted: false }).kind).toBe("skeleton");
  });
});

/* ----------------------------- rendered behaviour -------------------------- */

describe("SalonGate on a fresh device 2 (cloud already onboarded)", () => {
  it("shows the connect screen with 'Enter your salon PIN' — never setup, never owner", async () => {
    h.probe = { ok: true, salonPinSet: true };
    h.settings = { id: 1, onboarded: false }; // local seed — must not matter
    renderGate();

    await screen.findByPlaceholderText("Enter your salon PIN");
    expect(screen.queryByText("Set up your salon")).toBeNull();
    expect(screen.queryByPlaceholderText("Salon PIN (6-8 digits)")).toBeNull();
    expect(screen.queryByPlaceholderText("Create a salon PIN (first device only)")).toBeNull();
    // No session of any kind is created by arriving/connecting here.
    expect(lk.setOwner).not.toHaveBeenCalled();
    expect(lk.signInOwner).not.toHaveBeenCalled();
    expect(h.connectCalls).toHaveLength(0); // no auto-connect, PIN must be typed
    // The device-name step is not asked before the gate passes.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("device 3 gets exactly the same treatment", async () => {
    h.probe = { ok: true, salonPinSet: true };
    h.settings = { id: 1, onboarded: false };
    renderGate();

    await screen.findByPlaceholderText("Enter your salon PIN");
    expect(screen.queryByText("Set up your salon")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Owner PIN" })).toBeNull(); // no pad
    expect(lk.setOwner).not.toHaveBeenCalled();
    expect(lk.signInOwner).not.toHaveBeenCalled();
  });
});

describe("SalonGate on the first device (empty cloud)", () => {
  it("offers setup and no owner pad, and finishing setup creates the owner session", async () => {
    h.probe = { ok: true, salonPinSet: false }; // cloud confirmed empty
    h.settings = { id: 1, onboarded: false, salonName: "", phone: "" };
    renderGate();

    await screen.findByText("Set up your salon");
    // The old flow put an Owner PIN pad in front of this screen — gone.
    expect(screen.queryByRole("heading", { name: "Owner PIN" })).toBeNull();
    // Arriving here does not sign anyone in…
    expect(lk.signInOwner).not.toHaveBeenCalled();

    // Finish setup: shop identity + a NEW owner PIN.
    fireEvent.change(screen.getByLabelText("Shop name"), {
      target: { value: "Test Salon" },
    });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "9840001111" } });
    fireEvent.change(screen.getByLabelText("New owner PIN"), {
      target: { value: "482917" },
    });
    fireEvent.click(screen.getByText("Finish setup"));

    await waitFor(
      () => {
        expect(lk.signInOwner).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000 },
    );
    // Setup stored a HASHED owner PIN and the onboarded flag (no plain PIN).
    const stored = h.settings as Record<string, unknown>;
    expect(stored["onboarded"]).toBe(true);
    expect(String(stored["ownerPin"])).toMatch(/^p1\$/);
    expect(stored["ownerPin"]).not.toBe("482917");
    // Finishing setup is the owner source — connecting still isn't.
    expect(lk.setOwner).not.toHaveBeenCalled();
  });

  it("after setup but before connecting, the cloud status words it 'Create a salon PIN'", async () => {
    h.probe = { ok: true, salonPinSet: false };
    h.settings = { id: 1, onboarded: true }; // setup finished, reload before connect
    renderGate();

    await screen.findByPlaceholderText("Create a salon PIN (first device only)");
    expect(screen.queryByText("Set up your salon")).toBeNull();
  });
});

describe("SalonGate with a cloud that answers", () => {
  it("offline/unreachable cloud on a fresh device → neutral wording, never setup", async () => {
    h.probe = { ok: false, error: "No internet" };
    h.settings = { id: 1, onboarded: false };
    renderGate();

    await screen.findByPlaceholderText("Salon PIN (6-8 digits)");
    expect(screen.queryByText("Set up your salon")).toBeNull();
    expect(lk.signInOwner).not.toHaveBeenCalled();
  });

  it("offline reload of a synced device opens straight into the app (no setup, no probe)", async () => {
    h.token = true;
    h.firstSyncDone = true;
    h.phase = "error"; // offline background sync failed
    h.settings = { id: 1, onboarded: true };
    renderGate();

    // The gate passed: the locked picker (not setup, not connect) is what a
    // fresh tab shows; no status probe ran for a device that has a token.
    await screen.findByRole("heading", { name: "Who's at the counter?" });
    expect(screen.queryByText("Set up your salon")).toBeNull();
    expect(screen.queryByPlaceholderText("Enter your salon PIN")).toBeNull();
    expect(h.probeCalls).toBe(0); // a connected device never probes for setup
  });

  it("shows 'Syncing your salon…' until connect + the first pull finish", async () => {
    h.token = true; // connect() already succeeded…
    h.firstSyncDone = false; // …but the first pull is still running
    h.phase = "syncing";
    h.settings = { id: 1, onboarded: true };
    renderGate();

    await screen.findByText("Syncing your salon…");
    expect(screen.queryByTestId("app-content")).toBeNull(); // not inside yet
    expect(screen.queryByText("Set up your salon")).toBeNull();

    // First pull completes → the gate passes (device already named).
    h.firstSyncDone = true;
    h.phase = "online";
    h.deviceName = "Counter";
    renderGate();
    await waitFor(() => {
      expect(
        screen.getAllByRole("heading", { name: "Who's at the counter?" }).length,
      ).toBeGreaterThan(0);
    });
    expect(screen.queryByText("Set up your salon")).toBeNull();
  });
});

describe("a freshly connected device lands LOCKED and names itself once", () => {
  it("in-app name dialog → locked person picker, never an owner session", async () => {
    h.token = true;
    h.firstSyncDone = true;
    h.phase = "online";
    h.settings = { id: 1, onboarded: true };
    renderGate();

    // One-time, in-app device-name dialog (never window.prompt — asserted on
    // the sources below too).
    const dialog = await screen.findByRole("dialog", { name: "Name this device" });
    expect(dialog).toBeTruthy();
    // The gate passed (no setup / connect screen behind the dialog).
    expect(screen.queryByText("Set up your salon")).toBeNull();

    fireEvent.change(screen.getByLabelText("Device name"), {
      target: { value: "  Counter 2  " },
    });
    fireEvent.click(screen.getByText("Save name"));

    // Dialog is done (one-time), the LOCKED picker is what remains.
    await screen.findByRole("heading", { name: "Who's at the counter?" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.deviceName).toBe("Counter 2"); // trimmed, stored locally
    // The app content is blocked behind the picker → not signed in at all.
    expect(screen.queryByTestId("app-content")).toBeNull();
    expect(lk.setOwner).not.toHaveBeenCalled();
    expect(lk.signInOwner).not.toHaveBeenCalled();
    expect(lk.signInStaff).not.toHaveBeenCalled();
    expect(lk.session).toBeNull();

    // A later boot with the name already stored never asks again.
    renderGate();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the device-name step uses the in-app dialog, never window.prompt (source)", () => {
    const dir = join(__dirname);
    for (const file of ["SyncGate.tsx", "AppShell.tsx", "SetupScreen.tsx"]) {
      expect(readFileSync(join(dir, file), "utf8")).not.toMatch(/window\.prompt\s*\(/);
    }
    const syncClient = readFileSync(join(dir, "..", "lib", "syncClient.ts"), "utf8");
    expect(syncClient).not.toMatch(/window\.prompt\s*\(/);
    // connect() no longer asks the name at all — and never signs anyone in.
    expect(syncClient).not.toMatch(/askDeviceName/);
    expect(syncClient).not.toMatch(/setOwner|signInOwner/);
    const dbSrc = readFileSync(join(dir, "..", "lib", "db.ts"), "utf8");
    expect(dbSrc).not.toMatch(/window\.prompt\s*\(/);
  });
});
