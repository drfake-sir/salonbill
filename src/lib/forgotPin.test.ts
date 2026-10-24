import { describe, expect, it } from "vitest";
import { recoverOwnerPin, type RecoveryDeps } from "./ownerRecovery";
import { hashPin, verifyPin } from "./pins";

/**
 * Forgotten owner PIN:
 *  - client flow: cloud PIN verified by the server, new PIN hashed, old PIN gone
 *  - server (runAuth verifyOnly): wrong PIN, existing lockout, no side effects
 */

/* --------------------------- client recovery flow ------------------------ */

function deps(overrides?: Partial<RecoveryDeps>) {
  const saved: string[] = [];
  const base: RecoveryDeps = {
    verifyCloudPin: async () => ({ ok: true }),
    hash: hashPin,
    saveOwnerPin: async (h) => {
      saved.push(h);
    },
    ...overrides,
  };
  return { deps: base, saved };
}

describe("recoverOwnerPin (client flow)", () => {
  it("success: verifies the cloud PIN, hashes the new PIN and saves only the hash", async () => {
    const { deps: d, saved } = deps();
    const r = await recoverOwnerPin("482917", "654321", d);
    expect(r).toEqual({ ok: true });
    expect(saved).toHaveLength(1);
    // New PIN is hashed (PBKDF2 form), never stored plain.
    expect(saved[0]!.startsWith("p1$")).toBe(true);
    expect(saved[0]).not.toBe("654321");
    expect(await verifyPin(saved[0], "654321")).toBe(true);
  });

  it("wrong cloud PIN: surfaces the server error and never touches the owner PIN", async () => {
    const { deps: d, saved } = deps({
      verifyCloudPin: async () => ({ ok: false, error: "Wrong PIN" }),
    });
    const r = await recoverOwnerPin("000000", "654321", d);
    expect(r).toEqual({ ok: false, error: "Wrong PIN" });
    expect(saved).toHaveLength(0); // nothing saved
  });

  it("lockout: the server's lockout message is what the owner sees", async () => {
    const { deps: d, saved } = deps({
      verifyCloudPin: async () => ({
        ok: false,
        error: "Too many wrong PIN attempts — locked for 5 minutes",
      }),
    });
    const r = await recoverOwnerPin("482917", "654321", d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/locked for 5 minutes/);
    expect(saved).toHaveLength(0);
  });

  it("the OLD owner PIN stops working once the new hash is saved", async () => {
    // Simulated settings row holding the owner's current PIN.
    let ownerPin = await hashPin("111111");
    expect(await verifyPin(ownerPin, "111111")).toBe(true);

    const { deps: d } = deps({
      saveOwnerPin: async (h) => {
        ownerPin = h;
      },
    });
    const r = await recoverOwnerPin("482917", "654321", d);
    expect(r.ok).toBe(true);
    expect(await verifyPin(ownerPin, "654321")).toBe(true); // new PIN works
    expect(await verifyPin(ownerPin, "111111")).toBe(false); // old PIN is dead
  });

  it("validates inputs before spending a server attempt", async () => {
    let called = 0;
    const { deps: d } = deps({
      verifyCloudPin: async () => {
        called++;
        return { ok: true };
      },
    });
    expect((await recoverOwnerPin("123", "654321", d)).ok).toBe(false); // cloud PIN too short
    expect((await recoverOwnerPin("482917", "1234", d)).ok).toBe(false); // new PIN < 6 digits
    expect(called).toBe(0);
  });
});

/* --------------------- server: runAuth verifyOnly ------------------------ */

describe("server verifyOnly (salon cloud PIN check)", () => {
  async function salon() {
    const { createMemoryStore } = await import("../server/memoryStore");
    const { runAuth } = await import("../server/syncCore");
    const store = createMemoryStore();
    const auth = await runAuth(store, { pin: "482917" });
    if (!auth.ok || !auth.token) throw new Error("salon setup failed");
    return { store, runAuth };
  }

  it("accepts the correct cloud PIN", async () => {
    const { store, runAuth } = await salon();
    const r = await runAuth(store, { pin: "482917", verifyOnly: true });
    expect(r.ok).toBe(true);
  });

  it("rejects a wrong cloud PIN", async () => {
    const { store, runAuth } = await salon();
    const r = await runAuth(store, { pin: "000000", verifyOnly: true });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Wrong PIN");
  });

  it("keeps the existing lockout: 5 wrong attempts lock verification", async () => {
    const { store, runAuth } = await salon();
    for (let i = 0; i < 4; i++) {
      const r = await runAuth(store, { pin: `99999${i}`, verifyOnly: true });
      expect(r.ok).toBe(false);
      expect(r.error).toBe("Wrong PIN");
    }
    const fifth = await runAuth(store, { pin: "999999", verifyOnly: true });
    expect(fifth.ok).toBe(false);
    expect(fifth.error).toMatch(/locked for 5 minutes/);
    // Even the CORRECT PIN is refused while locked.
    const whileLocked = await runAuth(store, { pin: "482917", verifyOnly: true });
    expect(whileLocked.ok).toBe(false);
    expect(whileLocked.error).toMatch(/try again in/);
  });

  it("never bootstraps a PIN on an empty server (no side effect)", async () => {
    const { createMemoryStore } = await import("../server/memoryStore");
    const { runAuth } = await import("../server/syncCore");
    const store = createMemoryStore();
    const r = await runAuth(store, { pin: "123456", verifyOnly: true });
    expect(r.ok).toBe(false);
    expect(await store.getAuth()).toBeNull(); // nothing was set
  });

  it("never rotates the cloud PIN, even when a valid token is supplied", async () => {
    const { store, runAuth } = await salon();
    const before = await store.getAuth();
    const r = await runAuth(store, { token: before!.hash, pin: "000000", verifyOnly: true });
    expect(r.ok).toBe(false); // wrong PIN still fails…
    // …and the stored hash is untouched either way.
    expect(await store.getAuth()).toEqual(before);
    expect((await runAuth(store, { pin: "482917", verifyOnly: true })).ok).toBe(true);
  });
});
