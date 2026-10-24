import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK 1 — Edited data must survive a new device.
 *
 * Device 1 has edited seeded rows (service price, stylist name/commission,
 * owner PIN, customer name). Device 2 connects fresh and seeds the SAME ids
 * with starter values. Required: the cloud keeps device 1's edits and device 2
 * receives them. Two layers are covered here:
 *
 *  1. sync core (server): a first sync is insert-if-absent, so seed pushes can
 *     never overwrite existing cloud rows, and the same response's pull hands
 *     the edited rows back to the fresh device.
 *  2. client drain: EVERY chunk of a first sync must be marked `firstSync`
 *     (a history device can exceed the 400-row chunk size) and applied pull
 *     rows must overwrite the local seed via `put`.
 */

type PushPayload = {
  deviceId: string;
  token: string;
  cursor: number;
  firstSync?: boolean | undefined;
  push?: { t: string; id: number; op: string; data?: unknown }[] | undefined;
  replaceAll?: Record<string, number[]> | undefined;
};

type PullRow = { t: string; id: number; data: Record<string, unknown> | null };

/* ------------------------------- test harness ---------------------------- */

const h = vi.hoisted(() => ({
  pushes: [] as PushPayload[],
  pull: [] as PullRow[],
  puts: [] as { t: string; o: Record<string, unknown> }[],
}));

type MockTable = {
  rows: Record<string, unknown>[];
  toArray: () => Promise<Record<string, unknown>[]>;
  put: (o: Record<string, unknown>) => Promise<number>;
  delete: (k: number) => Promise<void>;
  orderBy: () => { toArray: () => Promise<unknown[]> };
};

function makeTable(rows: Record<string, unknown>[]): MockTable {
  return {
    rows,
    toArray: async () => rows,
    put: async (o) => {
      h.puts.push({ t: "", o });
      const i = rows.findIndex((r) => r["id"] === o["id"]);
      if (i >= 0) rows[i] = o;
      else rows.push(o);
      return Number(o["id"]);
    },
    delete: async (k) => {
      const i = rows.findIndex((r) => r["id"] === k);
      if (i >= 0) rows.splice(i, 1);
    },
    orderBy: () => ({ toArray: async () => [] }),
  };
}

/** Tables are rebuilt per test via resetTables() before each import. */
const tables: Record<string, MockTable> = {};
function resetTables(seed: Record<string, Record<string, unknown>[]>) {
  for (const k of Object.keys(tables)) delete tables[k];
  for (const [k, rows] of Object.entries(seed)) tables[k] = makeTable(rows);
}

vi.mock("./db", async () => {
  const db: Record<string, unknown> = {
    get tables() {
      return Object.keys(tables);
    },
    syncQueue: {
      clear: async () => {},
      delete: async () => {},
      hook: () => {},
      orderBy: () => ({ toArray: async () => [] }),
    },
    transaction: (_mode: string, _tables: unknown, cb: () => Promise<unknown>) => cb(),
  };
  // Table access is dynamic (db[t]); bind through a proxy so per-test tables work.
  const dbProxy = new Proxy(db, {
    get(target, prop) {
      if (typeof prop === "string" && tables[prop]) return tables[prop];
      return Reflect.get(target, prop);
    },
  });
  return {
    db: dbProxy,
    SYNCED_TABLES: [
      "categories",
      "services",
      "products",
      "stylists",
      "customers",
      "bills",
      "settings",
    ],
    askDeviceName: (fallback: string) => fallback,
    getDeviceName: () => "Counter",
    setDeviceName: () => {},
    runWithoutEnqueue: (fn: () => unknown) => fn(),
    setOnRestored: () => {},
    localMaxId: async () => 0,
  };
});

vi.mock("@/syncFns", () => ({
  syncAuthFn: vi.fn(async () => ({ ok: true, token: "tok-1" })),
  syncPushFn: vi.fn(async (arg: { data: PushPayload }) => {
    h.pushes.push(arg.data);
    return {
      ok: true,
      cursor: 1,
      pull: h.pull,
      capped: false,
      applied: arg.data.push?.length ?? 0,
      leases: {},
    };
  }),
}));

async function freshDevice() {
  localStorage.clear();
  vi.resetModules();
  return await import("./syncClient");
}

const svc = (id: number, price: number) => ({ id, name: `Service ${id}`, price, active: true });

beforeEach(() => {
  h.pushes.length = 0;
  h.pull = [];
  h.puts.length = 0;
});

/* ------------------------- client: first-sync chunks --------------------- */

describe("fresh device first sync (client drain)", () => {
  it("marks EVERY chunk firstSync so seed rows can never win over cloud edits", async () => {
    // A device with pre-sync history pushes more than PUSH_CHUNK (400) rows on
    // its first sync: seed rows land in chunk 1, history in later chunks. If
    // only the final chunk carries firstSync, the server applies chunk 1 as
    // last-writer-wins and the device's stale starter copies OVERWRITE the
    // salon's edited prices/PINs in one request.
    resetTables({
      // 401 services ⇒ two chunks (400 + 1).
      services: Array.from({ length: 401 }, (_, i) => svc(i + 1, 100)),
      settings: [{ id: 1, ownerPin: "1234", salonName: "Seed Salon" }],
      stylists: [{ id: 1, name: "Karthik", pin: "1111", active: true }],
      categories: [{ id: 1, name: "Hair", order: 1 }],
      products: [],
      customers: [{ id: 1, name: "Seed Customer", phone: "9840000000" }],
      bills: [],
    });

    const mod = await freshDevice();
    localStorage.setItem("sb-sync-token", "tok-1"); // after freshDevice clears storage
    await mod.syncNow({ forceFirst: true });

    expect(h.pushes.length).toBe(2);
    const c1 = h.pushes[0] as PushPayload;
    const c2 = h.pushes[1] as PushPayload;
    // The regression: pre-fix only the LAST chunk was firstSync.
    expect(c1.firstSync).toBe(true);
    expect(c2.firstSync).toBe(true);
    // A plain first sync still never sends id-sets (see firstSyncReplace.test).
    expect(c1.replaceAll).toBeUndefined();
    expect(c2.replaceAll).toBeUndefined();
    expect(c1.push?.length).toBe(400);
    expect(c2.push?.length).toBe(1 + 1 + 1 + 1 + 1); // settings+stylists+category+customer (+1 svc)
  });

  it("applies pulled cloud rows over the local seed (device 2 receives the edits)", async () => {
    resetTables({
      services: [svc(2, 600)], // seed value
      settings: [{ id: 1, ownerPin: "1234", salonName: "Seed Salon" }],
      stylists: [{ id: 1, name: "Karthik", commissionPct: 10, active: true }],
      categories: [],
      products: [],
      customers: [{ id: 1, name: "Seed Customer", phone: "9840000000" }],
      bills: [],
    });

    const mod = await freshDevice();
    localStorage.setItem("sb-sync-token", "tok-1"); // after freshDevice clears storage

    // The server's response carries device 1's edited rows.
    h.pull = [
      { t: "services", id: 2, data: { id: 2, name: "Service 2", price: 555, active: true } },
      { t: "settings", id: 1, data: { id: 1, ownerPin: "s1$6$aa$bb", salonName: "Edited Salon" } },
      {
        t: "stylists",
        id: 1,
        data: { id: 1, name: "Karthik Kumar", commissionPct: 12, active: true },
      },
      { t: "customers", id: 1, data: { id: 1, name: "Edited Customer", phone: "9840000001" } },
    ];

    await mod.syncNow({ forceFirst: true });

    expect(tables["services"]!.rows[0]!["price"]).toBe(555);
    expect(tables["settings"]!.rows[0]!["ownerPin"]).toBe("s1$6$aa$bb");
    expect(tables["stylists"]!.rows[0]!["name"]).toBe("Karthik Kumar");
    expect(tables["stylists"]!.rows[0]!["commissionPct"]).toBe(12);
    expect(tables["customers"]!.rows[0]!["name"]).toBe("Edited Customer");
    // And the outbox is fully superseded after the first sync.
    expect(localStorage.getItem("sb-sync-done")).toBe("1");
  });

  it("pulling a tombstone deletes the local row (delete propagation)", async () => {
    resetTables({
      customers: [{ id: 5, name: "Deleted elsewhere", phone: "9840000005" }],
      services: [],
      settings: [],
      stylists: [],
      categories: [],
      products: [],
      bills: [],
    });

    const mod = await freshDevice();
    localStorage.setItem("sb-sync-token", "tok-1");
    // A tombstone from another device arrives as data: null.
    h.pull = [{ t: "customers", id: 5, data: null }];

    await mod.syncNow({ forceFirst: true });

    expect(tables["customers"]!.rows).toHaveLength(0);
  });
});

/* --------------------------- sync core (server) -------------------------- */

describe("fresh device first sync (sync core)", () => {
  async function salon() {
    const { createMemoryStore } = await import("../server/memoryStore");
    const { runAuth } = await import("../server/syncCore");
    const store = createMemoryStore();
    const auth = await runAuth(store, { pin: "482917" });
    if (!auth.ok || !auth.token) throw new Error("salon setup failed");
    return { store, token: auth.token };
  }

  it("keeps device 1's edits and hands them to the fresh device in its pull", async () => {
    const { runSync } = await import("../server/syncCore");
    const { store, token } = await salon();

    // Device 1 edits four seeded rows.
    await runSync(store, {
      deviceId: "d1",
      token,
      cursor: 0,
      push: [
        { t: "services", id: 2, op: "put", data: { id: 2, name: "Women's Haircut", price: 555 } },
        {
          t: "stylists",
          id: 1,
          op: "put",
          data: { id: 1, name: "Karthik Kumar", commissionPct: 12, active: true },
        },
        {
          t: "settings",
          id: 1,
          op: "put",
          data: { id: 1, ownerPin: "654321", salonName: "Edited Salon" },
        },
        {
          t: "customers",
          id: 1,
          op: "put",
          data: { id: 1, name: "Edited Customer", phone: "9840000001" },
        },
      ],
    });

    // Device 2 connects fresh and first-syncs the STARTER values for the same ids.
    const res = await runSync(store, {
      deviceId: "d2",
      token,
      cursor: 0,
      firstSync: true,
      push: [
        { t: "services", id: 2, op: "put", data: { id: 2, name: "Women's Haircut", price: 600 } },
        {
          t: "stylists",
          id: 1,
          op: "put",
          data: { id: 1, name: "Karthik", commissionPct: 10, active: true },
        },
        {
          t: "settings",
          id: 1,
          op: "put",
          data: { id: 1, ownerPin: "1234", salonName: "Glow Studio Unisex Salon" },
        },
        {
          t: "customers",
          id: 1,
          op: "put",
          data: { id: 1, name: "Lakshmi Narayanan", phone: "9841234567" },
        },
      ],
    });
    expect(res.ok).toBe(true);

    // The cloud still holds device 1's edited values (seed lost).
    const rows = await store.rowsSince(0, 500);
    type RowShape = {
      price?: number;
      name?: string;
      ownerPin?: string;
      commissionPct?: number;
      [k: string]: unknown;
    };
    const val = (t: string, id: number): RowShape | null => {
      const r = rows.find((x) => x.t === t && x.id === id);
      return r && r.data !== null ? (JSON.parse(r.data) as RowShape) : null;
    };
    expect(val("services", 2)?.price).toBe(555);
    expect(val("stylists", 1)?.name).toBe("Karthik Kumar");
    expect(val("stylists", 1)?.commissionPct).toBe(12);
    expect(val("settings", 1)?.ownerPin).toBe("654321");
    expect(val("customers", 1)?.name).toBe("Edited Customer");

    // Device 2 receives the edits in the very same first-sync response.
    const got = (t: string, id: number): RowShape | null =>
      res.pull.find((x) => x.t === t && x.id === id)?.data as RowShape | null;
    expect(got("services", 2)?.price).toBe(555);
    expect(got("stylists", 1)?.name).toBe("Karthik Kumar");
    expect(got("settings", 1)?.ownerPin).toBe("654321");
    expect(got("customers", 1)?.name).toBe("Edited Customer");
  });

  it("insert-if-absent holds on EVERY first-sync chunk, not just the last", async () => {
    const { runSync } = await import("../server/syncCore");
    const { store, token } = await salon();

    await runSync(store, {
      deviceId: "d1",
      token,
      cursor: 0,
      push: [{ t: "services", id: 7, op: "put", data: { id: 7, name: "Keratin", price: 4999 } }],
    });

    // Device 3's first sync arrives in two chunks, BOTH marked firstSync.
    const chunk1 = await runSync(store, {
      deviceId: "d3",
      token,
      cursor: 0,
      firstSync: true,
      push: [{ t: "services", id: 7, op: "put", data: { id: 7, name: "Keratin", price: 4500 } }],
    });
    const chunk2 = await runSync(store, {
      deviceId: "d3",
      token,
      cursor: chunk1.cursor,
      firstSync: true,
      push: [{ t: "services", id: 21, op: "put", data: { id: 21, name: "New row", price: 1 } }],
    });
    expect(chunk2.ok).toBe(true);

    const rows = await store.rowsSince(0, 500);
    const s7 = rows.find((x) => x.t === "services" && x.id === 7);
    expect(s7 && JSON.parse(s7.data!).price).toBe(4999); // edit survived both chunks
    expect(rows.some((x) => x.t === "services" && x.id === 21)).toBe(true); // new rows still land
  });
});
