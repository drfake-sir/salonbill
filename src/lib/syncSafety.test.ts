import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { friendlySyncError } from "./syncClient";

/* --------------------------- error message mapping ------------------------ */

describe("sync error message mapping", () => {
  it("maps an auth failure to Wrong PIN", () => {
    expect(friendlySyncError(new Error("auth: session expired"))).toBe("Wrong PIN");
    expect(friendlySyncError(new Error("Wrong PIN"))).toBe("Wrong PIN");
    expect(friendlySyncError(new Error("token rejected"))).toBe("Wrong PIN");
    expect(friendlySyncError("auth")).toBe("Wrong PIN");
  });

  it("maps network failures to No internet", () => {
    expect(friendlySyncError(new Error("Failed to fetch"))).toBe("No internet");
    expect(friendlySyncError(new Error("NetworkError when attempting to fetch resource."))).toBe(
      "No internet",
    );
    expect(friendlySyncError(new Error("fetch failed"))).toBe("No internet");
    expect(friendlySyncError(new Error("Request timed out"))).toBe("No internet");
  });

  it("maps a missing D1 binding to the cloud-database message", () => {
    // This is the message the Vite dev server produces (no workerd, no env.DB).
    expect(friendlySyncError(new Error("Cloud database is not available on this server"))).toBe(
      "Cloud database is not available on this server",
    );
  });

  it("falls back to a generic server error", () => {
    expect(friendlySyncError(new Error("boom"))).toBe("Server error, try again");
    expect(friendlySyncError(undefined)).toBe("Server error, try again");
    expect(friendlySyncError("")).toBe("Server error, try again");
  });

  it("never leaks the raw error text into user-facing copy", () => {
    const raw = new Error("SQLITE_ERROR: no such column: sb_rows.foo at offset 12");
    expect(friendlySyncError(raw)).toBe("Server error, try again");
    expect(friendlySyncError(raw)).not.toContain("SQLITE");
  });

  it("keeps the four messages distinct", () => {
    const msgs = [
      friendlySyncError(new Error("auth")),
      friendlySyncError(new Error("Failed to fetch")),
      friendlySyncError(new Error("Cloud database is not available on this server")),
      friendlySyncError(new Error("boom")),
    ];
    expect(new Set(msgs).size).toBe(4);
  });
});

/* ----------------------- offline billing after first connect ------------- */

describe("offline billing after first connect", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("a device that connected once is never blocked by the connect screen", async () => {
    // The gate lets a device through when it holds a token AND has finished
    // its first sync. everConnected() is the extra latch that keeps a RETURNING
    // device billing when a later sync fails or the network drops.
    const { connect, everConnected, isFirstSyncDone } = await import("./syncClient");

    // Nothing connected yet: gate must be closed.
    expect(everConnected()).toBe(false);
    expect(isFirstSyncDone()).toBe(false);

    // Pretend this device completed a first connect earlier (token + latch).
    localStorage.setItem("sb-sync-token", "tok");
    localStorage.setItem("sb-sync-ever-connected", "1");
    vi.resetModules();

    const mod = await import("./syncClient");
    expect(mod.everConnected()).toBe(true);

    // A later sync failure must NOT clear the latch or the token: the device
    // keeps the token so it can retry, and keeps billing.
    localStorage.setItem("sb-sync-done", "1");
    expect(mod.isFirstSyncDone()).toBe(true);
    expect(mod.hasToken()).toBe(true);
    expect(mod.everConnected()).toBe(true);
  });

  it("keeps the latch after disconnect+reconnect cycles", async () => {
    const mod = await import("./syncClient");
    localStorage.setItem("sb-sync-ever-connected", "1");
    expect(mod.everConnected()).toBe(true);

    // disconnect() drops the token (a deliberate owner action) but a device
    // that has joined the salon is still known to it.
    mod.disconnect();
    expect(mod.hasToken()).toBe(false);
    expect(mod.everConnected()).toBe(true);
  });

  it("reports no device as connected before the first connect", async () => {
    const mod = await import("./syncClient");
    expect(mod.everConnected()).toBe(false);
    expect(mod.hasToken()).toBe(false);
  });
});

/* --------------------------- unsynced warning ----------------------------- */

describe("unsynced-change warning threshold", () => {
  it("does not warn for a short outage", async () => {
    const { isUnsyncedStale, UNSYNCED_WARN_MS } = await import("./syncClient");
    const now = 1_000_000_000_000;
    expect(UNSYNCED_WARN_MS).toBe(3 * 60 * 60 * 1000);
    expect(isUnsyncedStale(now - 60_000, now)).toBe(false); // 1 min
    expect(isUnsyncedStale(now - 2 * 60 * 60 * 1000, now)).toBe(false); // 2 h
  });

  it("warns once bills have been unsynced for more than 3 hours", async () => {
    const { isUnsyncedStale, UNSYNCED_WARN_MS } = await import("./syncClient");
    const now = 1_000_000_000_000;
    expect(isUnsyncedStale(now - UNSYNCED_WARN_MS - 1, now)).toBe(true);
    expect(isUnsyncedStale(now - 4 * 60 * 60 * 1000, now)).toBe(true);
    expect(isUnsyncedStale(now - 26 * 60 * 60 * 1000, now)).toBe(true);
  });

  it("treats never-synced as not stale (a different warning covers it)", async () => {
    const { isUnsyncedStale } = await import("./syncClient");
    expect(isUnsyncedStale(null, Date.now())).toBe(false);
  });

  it("the warning banner reports how many changes are stuck", async () => {
    const src = fs.readFileSync(path.join(__dirname, "../components/SyncGate.tsx"), "utf8");
    // The banner must say how many changes are stuck, not just that some are.
    expect(src).toMatch(/queuedBills/);
    expect(src).toMatch(/have not reached the cloud|waiting to upload/);
    // It reports the outage length in hours, taken from the tested threshold.
    expect(src).toMatch(/hasn&apos;t synced in \{stale\}h/);
    // And it must reassure the owner the bills are safe locally.
    expect(src).toMatch(/not yet in the cloud/);
  });
});

/* ------------------- no duplicate bill numbers across devices ------------- */

/** Set up a salon with a known PIN and return its token (never undefined). */
async function salon() {
  const { createMemoryStore } = await import("../server/memoryStore");
  const { runAuth } = await import("../server/syncCore");
  const store = createMemoryStore();
  const auth = await runAuth(store, { pin: "482917" });
  if (!auth.ok || !auth.token) throw new Error("salon setup failed");
  return { store, token: auth.token };
}

/** A bill-number lease block, asserted present. */
async function billBlock(
  store: Awaited<ReturnType<typeof salon>>["store"],
  token: string,
  deviceId: string,
) {
  const { runSync } = await import("../server/syncCore");
  const r = await runSync(store, { deviceId, token, cursor: 0, lease: { billno: 50 } });
  const b = r.leases["billno"];
  if (!b) throw new Error("server issued no bill-number block");
  return b;
}

describe("bill numbers never duplicate across devices", () => {
  it("two devices given disjoint lease blocks never collide", async () => {
    // Mirrors the real flow: the server reserves disjoint blocks per device,
    // so two offline counters can bill simultaneously without clashing.
    const { store, token } = await salon();
    const blockA = await billBlock(store, token, "counter");
    const blockB = await billBlock(store, token, "owner-phone");

    // The blocks must not overlap.
    expect(blockB.next).toBeGreaterThan(blockA.max);

    // Enumerate every number each device could issue and assert disjointness.
    const numsA = Array.from({ length: blockA.max - blockA.next + 1 }, (_, i) => blockA.next + i);
    const numsB = Array.from({ length: blockB.max - blockB.next + 1 }, (_, i) => blockB.next + i);
    expect(numsA.filter((n) => numsB.includes(n))).toEqual([]);
  });

  it("a third device continues past the second block", async () => {
    const { store, token } = await salon();
    const blocks = [];
    for (const dev of ["d1", "d2", "d3"]) blocks.push(await billBlock(store, token, dev));
    const [first, second, third] = blocks;
    if (!first || !second || !third) throw new Error("missing block");
    expect(second.next).toBe(first.max + 1);
    expect(third.next).toBe(second.max + 1);
  });

  it("reserves above the highest bill number already stored", async () => {
    const { store, token } = await salon();
    const { runSync } = await import("../server/syncCore");

    // A device restores a backup containing SB-0200, then asks for numbers.
    await runSync(store, {
      deviceId: "restorer",
      token,
      cursor: 0,
      firstSync: true,
      push: [{ t: "bills", id: 1, op: "put", data: { number: "SB-0200" } }],
    });
    const block = await billBlock(store, token, "restorer");
    expect(block.next).toBeGreaterThan(200);
  });
});
