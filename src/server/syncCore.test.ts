import { describe, expect, it } from "vitest";
import { createMemoryStore } from "./memoryStore";
import { hashToken, runAuth, runSync, type SyncRequest } from "./syncCore";

const DEV = (n: number) => `device-${n}`;
const req = (r: Partial<SyncRequest>): SyncRequest => ({
  deviceId: DEV(1),
  token: "",
  cursor: 0,
  ...r,
});

async function setupSalon(pin = "482917") {
  const store = createMemoryStore();
  const auth = await runAuth(store, { pin });
  return { store, token: auth.token! };
}

describe("auth", () => {
  it("first device sets the PIN and gets a token", async () => {
    const store = createMemoryStore();
    const r = await runAuth(store, { pin: "482917" });
    expect(r.ok).toBe(true);
    expect(r.token).toBe(await hashToken("482917", (await store.getAuth())!.salt));
  });

  it("rejects wrong PIN and accepts the right one", async () => {
    const { store, token } = await setupSalon();
    expect((await runAuth(store, { pin: "999999" })).ok).toBe(false);
    expect((await runAuth(store, { token })).ok).toBe(true);
  });

  it("rotates the PIN when a valid token is presented with a new pin", async () => {
    const { store, token } = await setupSalon();
    const rotated = await runAuth(store, { token, pin: "567890" });
    expect(rotated.ok).toBe(true);
    expect((await runAuth(store, { pin: "567890" })).ok).toBe(true);
    expect((await runAuth(store, { pin: "482917" })).ok).toBe(false);
  });

  it("rejects malformed PINs on first setup", async () => {
    const store = createMemoryStore();
    expect((await runAuth(store, { pin: "12" })).ok).toBe(false);
    expect((await runAuth(store, {})).ok).toBe(false);
    expect(await store.getAuth()).toBeNull();
  });

  it("requires at least 6 digits for the salon PIN", async () => {
    const store = createMemoryStore();
    // 4 digits used to be accepted and is now too short to be brute-force safe.
    expect((await runAuth(store, { pin: "1234" })).ok).toBe(false);
    expect(await store.getAuth()).toBeNull();
    expect((await runAuth(store, { pin: "12345" })).ok).toBe(false);
    expect(await store.getAuth()).toBeNull();
    expect((await runAuth(store, { pin: "123456" })).ok).toBe(true);
    expect(await store.getAuth()).not.toBeNull();
  });

  it("rejects a 4-digit PIN on an already-configured server", async () => {
    const { store, token } = await setupSalon();
    // A too-short pin alongside a valid token is NOT a valid rotation.
    const r = await runAuth(store, { token, pin: "1234" });
    expect(r.ok).toBe(true); // token still valid, PIN unchanged
    expect((await runAuth(store, { pin: "1234" })).ok).toBe(false);
    expect((await runAuth(store, { pin: "482917" })).ok).toBe(true);
  });

  it("locks out after 5 wrong attempts and recovers after the cooldown", async () => {
    const { store, token } = await setupSalon();
    for (let i = 0; i < 4; i++) {
      const r = await runAuth(store, { pin: `99999${i}` });
      expect(r.ok).toBe(false);
      expect(r.error).toBe("Wrong PIN");
    }
    // 5th wrong attempt trips the lock.
    const fifth = await runAuth(store, { pin: "999999" });
    expect(fifth.ok).toBe(false);
    expect(fifth.error).toMatch(/locked/i);

    // Correct PIN is refused while locked — the counter cannot be beaten.
    const whileLocked = await runAuth(store, { pin: "482917" });
    expect(whileLocked.ok).toBe(false);
    expect(whileLocked.error).toMatch(/try again in \d+ minute/i);

    // Cooldown elapses: the right PIN works again and the counter is clear.
    await store.setCounter("auth_lock_until", Date.now() - 1);
    expect((await runAuth(store, { pin: "482917" })).ok).toBe(true);
    expect((await runAuth(store, { token: "bad" })).ok).toBe(false); // still counts
  });

  it("a successful auth clears the failed-attempt counter", async () => {
    const { store, token } = await setupSalon();
    await runAuth(store, { pin: "000000" });
    await runAuth(store, { pin: "000001" });
    await runAuth(store, { pin: "000002" });
    expect(await store.getCounter("auth_attempts")).toBe(3);
    expect((await runAuth(store, { token })).ok).toBe(true);
    expect(await store.getCounter("auth_attempts")).toBe(0);
  });
});

describe("push/pull", () => {
  it("a second device pulls everything the first device pushed", async () => {
    const { store, token } = await setupSalon();
    await runSync(
      store,
      req({
        token,
        firstSync: true,
        push: [
          { t: "bills", id: 1, op: "put", data: { number: "SB-0001", total: 100 } },
          { t: "settings", id: 1, op: "put", data: { salonName: "Test" } },
        ],
      }),
    );
    const pull = await runSync(store, req({ deviceId: DEV(2), token, cursor: 0 }));
    expect(pull.pull).toHaveLength(2);
    expect(pull.pull.find((r) => r.t === "bills")?.data).toMatchObject({ number: "SB-0001" });
  });

  it("rejects a bad token and non-synced tables", async () => {
    const { store, token } = await setupSalon();
    expect((await runSync(store, req({ token: "nope" }))).error).toBe("auth");
    const r = await runSync(
      store,
      req({ token, push: [{ t: "audit", id: 1, op: "put", data: {} }] }),
    );
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(0);
    expect(await store.maxId("audit")).toBe(0);
  });

  it("later write wins regardless of which device wrote it", async () => {
    const { store, token } = await setupSalon();
    await runSync(
      store,
      req({
        token,
        firstSync: true,
        push: [{ t: "products", id: 3, op: "put", data: { stock: 5 } }],
      }),
    );
    await runSync(
      store,
      req({
        deviceId: DEV(2),
        token,
        cursor: 0,
        push: [{ t: "products", id: 3, op: "put", data: { stock: 2 } }],
      }),
    );
    const rows = await store.rowsSince(0, 10);
    expect(JSON.parse(rows[0]!.data!).stock).toBe(2);
  });

  it("firstSync is insert-if-absent: an existing server row is never overwritten", async () => {
    const { store, token } = await setupSalon();
    await runSync(
      store,
      req({
        token,
        firstSync: true,
        push: [{ t: "products", id: 3, op: "put", data: { stock: 5 } }],
      }),
    );
    const r = await runSync(
      store,
      req({
        deviceId: DEV(2),
        token,
        firstSync: true,
        push: [{ t: "products", id: 3, op: "put", data: { stock: 99 } }],
      }),
    );
    expect(r.applied).toBe(0);
    expect(JSON.parse((await store.rowsSince(0, 10))[0]!.data!).stock).toBe(5);
  });

  it("deletes become tombstones that other devices see", async () => {
    const { store, token } = await setupSalon();
    await runSync(
      store,
      req({
        token,
        firstSync: true,
        push: [{ t: "customers", id: 7, op: "put", data: { name: "A" } }],
      }),
    );
    await runSync(store, req({ token, push: [{ t: "customers", id: 7, op: "del" }] }));
    const pull = await runSync(store, req({ deviceId: DEV(2), token, cursor: 0 }));
    expect(pull.pull.some((r) => r.id === 7 && r.t === "customers" && r.data === null)).toBe(true);
  });

  it("pull cursor is idempotent: replaying from an old cursor re-delivers rows", async () => {
    const { store, token } = await setupSalon();
    await runSync(
      store,
      req({
        token,
        firstSync: true,
        push: [{ t: "bills", id: 1, op: "put", data: { number: "SB-0001" } }],
      }),
    );
    // Advance past the push's server_at so the first pull's cursor is strictly
    // newer than the row (within the same ms the boundary row may be
    // re-delivered, which is safe because applying is idempotent).
    await new Promise((r) => setTimeout(r, 3));
    const c1 = (await runSync(store, req({ token, cursor: 0 }))).cursor;
    const again = await runSync(store, req({ deviceId: DEV(2), token, cursor: 0 }));
    expect(again.pull).toHaveLength(1);
    const after = await runSync(store, req({ deviceId: DEV(2), token, cursor: c1 }));
    expect(after.pull).toHaveLength(0);
  });

  it("replaceAll deletes server rows the restoring device does not have", async () => {
    const { store, token } = await setupSalon();
    await runSync(
      store,
      req({
        token,
        firstSync: true,
        push: [
          { t: "bills", id: 1, op: "put", data: { number: "SB-0001" } },
          { t: "bills", id: 2, op: "put", data: { number: "SB-0002" } },
        ],
      }),
    );
    await runSync(
      store,
      req({
        token,
        replaceAll: { bills: [2] },
        push: [{ t: "bills", id: 2, op: "put", data: { number: "SB-0002" } }],
      }),
    );
    const pull = await runSync(store, req({ deviceId: DEV(2), token, cursor: 0 }));
    const bills = pull.pull.filter((r) => r.t === "bills");
    expect(bills.some((b) => b.id === 1 && b.data === null)).toBe(true);
    expect(bills.find((b) => b.id === 2)?.data).not.toBeNull();
  });
});

describe("leases", () => {
  it("bill-number leases never overlap and start after the highest existing bill", async () => {
    const { store, token } = await setupSalon();
    await runSync(
      store,
      req({
        token,
        firstSync: true,
        push: [{ t: "bills", id: 1, op: "put", data: { number: "SB-0007" } }],
      }),
    );
    const a = (await runSync(store, req({ token, lease: { billno: 3 } }))).leases["billno"]!;
    expect(a).toEqual({ next: 8, max: 10 });
    const b = (await runSync(store, req({ deviceId: DEV(2), token, lease: { billno: 3 } }))).leases[
      "billno"
    ]!;
    expect(b).toEqual({ next: 11, max: 13 });
    const c = (await runSync(store, req({ deviceId: DEV(3), token, lease: { billno: 2 } }))).leases[
      "billno"
    ]!;
    expect(c).toEqual({ next: 14, max: 15 });
  });

  it("row-id leases are floored by the max id on the server", async () => {
    const { store, token } = await setupSalon();
    await runSync(
      store,
      req({
        token,
        firstSync: true,
        push: [{ t: "customers", id: 42, op: "put", data: { name: "X" } }],
      }),
    );
    const a = (await runSync(store, req({ token, lease: { "row:customers": 5 } }))).leases[
      "row:customers"
    ]!;
    expect(a).toEqual({ next: 43, max: 47 });
    const b = (
      await runSync(store, req({ deviceId: DEV(2), token, lease: { "row:customers": 5 } }))
    ).leases["row:customers"]!;
    expect(b.next).toBe(48);
  });

  it("leases issued before pushes are still safe: push precedes lease in one request", async () => {
    const { store, token } = await setupSalon();
    // Device pushes its first bill AND asks for the next number block in the same call.
    const r1 = await runSync(
      store,
      req({
        token,
        firstSync: true,
        push: [{ t: "bills", id: 1, op: "put", data: { number: "SB-0003" } }],
        lease: { billno: 3 },
      }),
    );
    expect(r1.leases["billno"]).toEqual({ next: 4, max: 6 });
  });

  it("ignores unknown lease keys and bogus sizes", async () => {
    const { store, token } = await setupSalon();
    const r = await runSync(store, req({ token, lease: { bogus: 5, "row:audit": 5, billno: -1 } }));
    expect(r.leases).toEqual({});
  });
});
