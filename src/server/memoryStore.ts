import type { AuthRecord, PushItem, SyncStore } from "./syncCore";

type Row = { t: string; id: number; data: string | null; server_at: number };

/** In-memory SyncStore used by unit tests (and nowhere in production). */
export function createMemoryStore(): SyncStore & {
  rows: () => Row[];
  counters: Map<string, number>;
} {
  const rows = new Map<string, Row>();
  const counters = new Map<string, number>();
  let auth: AuthRecord | null = null;
  const key = (t: string, id: number) => `${t}#${id}`;
  const all = () => [...rows.values()];

  return {
    rows: all,
    counters,
    async getAuth() {
      return auth;
    },
    async setAuth(rec) {
      auth = rec;
    },
    async rowsSince(cursor, limit) {
      return all()
        .filter((r) => r.server_at >= cursor)
        .sort(
          (a, b) =>
            a.server_at - b.server_at || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0) || a.id - b.id,
        )
        .slice(0, limit);
    },
    async upsert(items, serverAt, mode) {
      let applied = 0;
      let i = 0;
      for (const it of items as PushItem[]) {
        const at = serverAt + i++;
        const k = key(it.t, it.id);
        const existing = rows.get(k);
        if (mode === "absent" && existing) continue;
        rows.set(k, {
          t: it.t,
          id: it.id,
          data: it.op === "put" ? JSON.stringify(it.data) : null,
          server_at: at,
        });
        applied++;
      }
      return { applied };
    },
    async deleteNotIn(sets, serverAt) {
      for (const [t, ids] of Object.entries(sets)) {
        const keep = new Set(ids);
        let i = 0;
        for (const r of all()) {
          if (r.t === t && r.data !== null && !keep.has(r.id)) {
            // Tombstone, not a hard delete: devices that already pulled this row
            // must receive a delete to converge.
            rows.set(key(r.t, r.id), { ...r, data: null, server_at: serverAt + i++ });
          }
        }
      }
    },
    async maxId(table) {
      let m = 0;
      for (const r of all()) if (r.t === table && r.data !== null) m = Math.max(m, r.id);
      return m;
    },
    async maxBillNo() {
      let m = 0;
      for (const r of all()) {
        if (r.t !== "bills" || r.data === null) continue;
        const num = (JSON.parse(r.data) as { number?: string }).number ?? "";
        const n = Number(num.replace(/^SB-/, ""));
        if (Number.isFinite(n)) m = Math.max(m, n);
      }
      return m;
    },
    async reserve(k, floor, size) {
      const high = Math.max(counters.get(k) ?? 0, floor) + size;
      counters.set(k, high);
      return { next: high - size + 1, max: high };
    },
    async getCounter(k) {
      return counters.get(k) ?? 0;
    },
    async setCounter(k, v) {
      counters.set(k, v);
    },
  };
}
