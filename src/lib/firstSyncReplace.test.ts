import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * REGRESSION: a fresh device's first sync must never send `replaceAll`.
 *
 * The server treats `replaceAll` as "tombstone every row the sender does not
 * have" — its intended meaning is a backup RESTORE, where the restoring
 * device's data is authoritative. The client used to send it on EVERY first
 * sync, so a brand-new device joining the salon pushed its seed id-set
 * (6 customers, 20 services, ...) and the server deleted every customer the
 * salon had added beyond the seed — on the cloud AND on every other device
 * (tombstones pull back everywhere). This is exactly the wipe observed live:
 * one incognito device connecting removed customers 151-153.
 *
 * The latch: only `setOnRestored` (an explicit backup restore) may authorise
 * a replaceAll, and the first sync that sends it consumes the latch.
 */

type PushPayload = {
  deviceId: string;
  token: string;
  cursor: number;
  firstSync: boolean;
  push: Array<{ t: string; id: number; op: string; data?: unknown }>;
  replaceAll?: Record<string, number[]> | undefined;
};

/* Shared state for the hoisted module mocks below. */
const h = vi.hoisted(() => ({
  pushes: [] as unknown[],
  restored: null as (() => void) | null,
}));

/* The client under test talks to mocked modules: Dexie is not available in
 * jsdom (no indexedDB), and the server fns would try to reach a Worker. */
vi.mock("./db", () => {
  const table = (rows: unknown[]) => ({ toArray: async () => rows });
  return {
    db: {
      services: table([{ id: 1, name: "Haircut" }]),
      customers: table([
        { id: 1, name: "Asha" },
        { id: 2, name: "Meena" },
      ]),
      bills: table([{ id: 9, number: "SB-0009", status: "paid", lines: [] }]),
      syncQueue: {
        clear: async () => {},
        delete: async () => {},
        hook: () => {},
        orderBy: () => ({ toArray: async () => [] }),
      },
    },
    SYNCED_TABLES: ["services", "customers", "bills"],
    askDeviceName: (fallback: string) => fallback,
    getDeviceName: () => "Counter",
    setDeviceName: () => {},
    runWithoutEnqueue: (fn: () => unknown) => fn(),
    setOnRestored: (fn: () => void) => {
      h.restored = fn;
    },
    localMaxId: async () => 0,
  };
});

vi.mock("@/syncFns", () => ({
  syncAuthFn: vi.fn(async () => ({ ok: true, token: "tok-1" })),
  syncPushFn: vi.fn(async (arg: { data: unknown }) => {
    h.pushes.push(arg.data);
    return { ok: true, cursor: 1, pull: [], capped: false, applied: 0, leases: {} };
  }),
}));

/** Reload the sync engine against clean storage (a brand-new device). */
async function freshDevice() {
  localStorage.clear();
  vi.resetModules();
  return await import("./syncClient");
}

beforeEach(() => {
  h.pushes.length = 0;
  h.restored = null;
});

afterEach(async () => {
  const mod = await import("./syncClient");
  mod.stopSyncEngine();
});

describe("first sync never sends replaceAll (fresh device must not wipe the salon)", () => {
  it("connect() uploads the local rows but sends NO id-sets", async () => {
    const mod = await freshDevice();
    const res = await mod.connect("12345");
    expect(res.ok).toBe(true);

    expect(h.pushes).toHaveLength(1);
    const p = h.pushes[0] as PushPayload;
    expect(p.firstSync).toBe(true);
    // The bug: replaceAll carried the seed id-set and the server tombstoned
    // every salon customer outside it.
    expect(p.replaceAll).toBeUndefined();
    // ...while the dataset itself still fully uploads (merge, not wipe).
    expect(p.push.length).toBeGreaterThan(0);
    expect(p.push.some((i) => i.t === "customers")).toBe(true);
    expect(localStorage.getItem("sb-sync-restore")).toBeNull();
  });

  it('the "Retry first sync" path (token, synced=0, no restore) sends NO id-sets', async () => {
    const mod = await freshDevice();
    localStorage.setItem("sb-sync-token", "tok-1");
    localStorage.setItem("sb-sync-done", "0");

    await mod.syncNow({ forceFirst: true });

    expect(h.pushes).toHaveLength(1);
    const p = h.pushes[0] as PushPayload;
    expect(p.firstSync).toBe(true);
    expect(p.replaceAll).toBeUndefined();
  });
});

describe("backup restore still converges the cloud (replaceAll stays available)", () => {
  it("a restore sends the local id-sets once, then consumes the latch", async () => {
    const mod = await freshDevice();
    // Wiring the engine registers the restore callback (as AppShell does).
    mod.startSyncEngine();
    if (!h.restored) throw new Error("setOnRestored was never wired");

    // The owner restores a backup on this device, then the sync runs.
    localStorage.setItem("sb-sync-token", "tok-1");
    h.restored();
    await vi.waitFor(() => expect(mod.isFirstSyncDone()).toBe(true));
    await new Promise((r) => setTimeout(r, 10));

    expect(h.pushes.length).toBeGreaterThan(0);
    const p = h.pushes[0] as PushPayload;
    // The restored dataset IS authoritative: the server may prune rows this
    // backup does not contain.
    expect(p.replaceAll).toEqual({ services: [1], customers: [1, 2], bills: [9] });
    // The latch is consumed by the successful first sync...
    expect(localStorage.getItem("sb-sync-restore")).toBeNull();

    // ...so a later full-resend never repeats the replace step.
    await mod.syncNow({ forceFirst: true });
    const again = h.pushes[h.pushes.length - 1] as PushPayload;
    expect(again.replaceAll).toBeUndefined();
  });
});
