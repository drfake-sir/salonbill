import { describe, expect, it } from "vitest";
import { RETENTION_DAYS, billsCsv, buildBackupJson, isExpiredKey } from "./backup";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-21T06:00:00Z");

describe("billsCsv", () => {
  it("writes a header plus one escaped row per bill", () => {
    const csv = billsCsv([
      {
        number: "SB-0001",
        createdAt: Date.parse("2026-10-20T12:34:00Z"),
        status: "paid",
        customerName: 'Ram, "the regular"',
        customerPhone: "9840011111",
        cashierName: "Karthik",
        lines: [
          { name: "Men's Haircut", qty: 1, stylistName: "Karthik" },
          { name: "Head Massage", qty: 2 },
        ],
        subtotal: 1000,
        discount: 50,
        cgst: 45,
        sgst: 45,
        tip: 10,
        total: 1050,
        payments: [
          { mode: "Cash", amount: 550 },
          { mode: "UPI", amount: 500 },
        ],
      },
    ]);
    const [header, row] = csv.split("\r\n");
    expect(header).toContain("Bill No");
    expect(header).toContain("Cashier");
    expect(row).toContain("SB-0001");
    expect(row).toContain('"Ram, ""the regular"""'); // comma + quotes escaped
    expect(row).toContain("Men's Haircut x1 (Karthik); Head Massage x2");
    expect(row).toContain("Cash 550 + UPI 500");
    expect(row).toContain("2026-10-20T");
  });

  it("handles a cancelled bill with a reason", () => {
    const csv = billsCsv([{ number: "SB-0002", status: "cancelled", cancelReason: "Wrong item" }]);
    expect(csv.split("\r\n")[1]).toContain("Wrong item");
  });
});

describe("isExpiredKey", () => {
  it("expires daily files older than the retention window", () => {
    expect(isExpiredKey("daily/salonbill-2025-09-01.json", NOW)).toBe(true);
    expect(isExpiredKey("daily/salonbill-2025-09-01-bills.csv", NOW)).toBe(true);
    expect(isExpiredKey("daily/salonbill-2026-10-21.json", NOW)).toBe(false);
    // Inside the 13-month window even if the year rolled over.
    const recent = new Date(NOW - 300 * DAY).toISOString().slice(0, 10);
    expect(isExpiredKey(`daily/salonbill-${recent}.json`, NOW)).toBe(false);
  });

  it("expires monthly snapshots on the same window", () => {
    expect(isExpiredKey("monthly/salonbill-2024-11.json", NOW)).toBe(true);
    expect(isExpiredKey("monthly/salonbill-2026-09.json", NOW)).toBe(false);
  });

  it("never expires meta keys or unknown names", () => {
    expect(isExpiredKey("meta/last.json", NOW)).toBe(false);
    expect(isExpiredKey("daily/random-file.json", NOW)).toBe(false);
    expect(RETENTION_DAYS).toBeGreaterThanOrEqual(395); // ≥ 13 months
  });
});

describe("buildBackupJson", () => {
  it("groups rows by table, skips tombstones and marks the format", () => {
    const json = buildBackupJson(
      [
        { t: "bills", id: 1, data: { id: 1, number: "SB-0001", lines: [] } },
        { t: "bills", id: 2, data: null }, // deleted row
        { t: "settings", id: 1, data: { id: 1, salonName: "Glow Studio" } },
      ],
      NOW,
    );
    const parsed = JSON.parse(json) as Record<string, unknown> & {
      __backup: { format: string; exportedAt: number };
    };
    expect(parsed.__backup.format).toBe("salonbill-cloud");
    expect(parsed.__backup.exportedAt).toBe(NOW);
    expect(parsed["bills"]).toEqual([{ id: 1, number: "SB-0001", lines: [] }]);
    expect(parsed["settings"]).toEqual([{ id: 1, salonName: "Glow Studio" }]);
  });

  it("produces the exact shape the Settings restore accepts", async () => {
    const { validateBackup } = await import("@/lib/db");
    const json = JSON.parse(
      buildBackupJson(
        [
          {
            t: "bills",
            id: 7,
            data: { id: 7, number: "SB-0007", lines: [{ key: "a", qty: 1 }], status: "paid" },
          },
          { t: "settings", id: 1, data: { id: 1, salonName: "Glow Studio" } },
        ],
        NOW,
      ),
    ) as unknown;
    expect(validateBackup(json)).toBe(true);
  });
});
