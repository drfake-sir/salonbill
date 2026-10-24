import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Task 3 — audit checks that are cheaper as source/pure contracts than as UI
 * automation: owner-only gates, PIN hashing wiring, the restore safety copy,
 * double-save protection, server auth, the service worker's staleness rules
 * and the append-only cancel transform.
 */

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, ...p), "utf8");

const settingsSrc = read("..", "routes", "settings.tsx");
const pinGateSrc = read("..", "components", "PinGate.tsx");
const staffGateSrc = read("..", "components", "StaffGate.tsx");
const indexSrc = read("..", "routes", "index.tsx");
const billsSrc = read("..", "routes", "bills.tsx");
const syncFnsSrc = read("..", "syncFns.ts");
const syncCoreSrc = read("..", "server", "syncCore.ts");
const swSrc = read("..", "..", "public", "sw.js");

/* --------------------------- Task 2 wiring ------------------------------- */

describe("PIN storage wiring (Task 2)", () => {
  it("Settings stores only salted hashes for new owner and staff PINs", () => {
    expect(settingsSrc).toMatch(/isValidNewPin\(p\)/); // owner: 6-8 digit rule
    expect(settingsSrc).toMatch(/ownerPin: await hashPin\(p\)/); // owner: hashed at set time
    expect(settingsSrc).toMatch(/pin: pin === undefined \? undefined : await hashPin\(pin\)/); // staff
    // The old plain write is gone.
    expect(settingsSrc).not.toMatch(/ownerPin: p\b/);
    expect(settingsSrc).toMatch(/maxLength=\{8\}/);
  });

  it("both sign-in pads verify through the hash and migrate on success", () => {
    for (const src of [pinGateSrc, staffGateSrc]) {
      expect(src).toMatch(/verifyPin\(/);
      expect(src).toMatch(/hashPin\(/);
      expect(src).toMatch(/isPlainPin\(/); // legacy migration trigger
    }
    // No direct plain-text comparison remains.
    expect(pinGateSrc).not.toMatch(/next === settings\?\.ownerPin/);
    expect(staffGateSrc).not.toMatch(/next === expected/);
    // Staff pad writes the migrated hash back to the right row.
    expect(staffGateSrc).toMatch(/db\.stylists\.update\([^)]*pin: hashed[^)]*\)/);
    expect(staffGateSrc).toMatch(/db\.settings\.update\(1, \{ ownerPin: hashed \}\)/);
  });

  it("keeps the 5-attempt lockout on both pads", () => {
    expect(pinGateSrc).toMatch(/const MAX_ATTEMPTS = 5;/);
    expect(pinGateSrc).toMatch(/LOCK_MS = 30_000/);
    expect(staffGateSrc).toMatch(/const MAX_ATTEMPTS = 5;/);
    expect(staffGateSrc).toMatch(/LOCK_MS = 30_000/);
    // A failed attempt still feeds the counter (lockout cannot be beaten).
    expect(pinGateSrc).toMatch(/setFails\(f\)/);
    expect(staffGateSrc).toMatch(/setFails\(f\)/);
  });
});

/* ------------------------------ Task 3 A --------------------------------- */

describe("data loss: restore keeps an automatic copy first (3A)", () => {
  it("the restore flow confirms, downloads a safety copy, THEN replaces data", () => {
    expect(settingsSrc).toMatch(/window\.confirm\(/); // asks for confirmation
    const copyAt = settingsSrc.indexOf("await downloadLocalBackup()");
    const restoreAt = settingsSrc.indexOf("await restoreBackup(");
    expect(copyAt).toBeGreaterThan(-1);
    expect(restoreAt).toBeGreaterThan(-1);
    expect(copyAt).toBeLessThan(restoreAt); // automatic copy BEFORE the wipe
    // A failed copy aborts the restore instead of proceeding.
    const between = settingsSrc.slice(copyAt, restoreAt);
    expect(between).toMatch(/restore cancelled/);
    expect(between).toMatch(/return/);
  });
});

/* ------------------------------ Task 3 C --------------------------------- */

describe("bill integrity (3C)", () => {
  it("Save is re-entrancy guarded (double tap / repeat key cannot save twice)", () => {
    expect(indexSrc).toMatch(/if \(savingRef\.current\) return;/);
    expect(indexSrc).toMatch(/savingRef\.current = true/);
    expect(indexSrc).toMatch(/savingRef\.current = false/); // released in finally
  });

  it("cancel requires the owner session and a reason", () => {
    const cancelAt = billsSrc.indexOf("const cancel = async");
    expect(cancelAt).toBeGreaterThan(-1);
    const cancelBody = billsSrc.slice(cancelAt, cancelAt + 600);
    expect(cancelBody).toMatch(/if \(!owner\)/); // guard inside the handler, not just hidden UI
    expect(cancelBody).toMatch(/prompt\(`Reason for cancelling/);
    expect(cancelBody).toMatch(/if \(!reason\) return;/);
  });

  it("applyCancel is append-only: every original field comes back identical", async () => {
    const { applyCancel } = await import("./db");
    const bill = {
      id: 9,
      number: "SB-0009",
      status: "paid",
      createdAt: 1_700_000_000_000,
      lines: [
        {
          key: "k",
          kind: "service",
          refId: 1,
          name: "Cut",
          price: 100,
          qty: 1,
          gstRate: 18,
          commissionPct: 10,
        },
      ],
      subtotal: 100,
      discount: 0,
      cgst: 9,
      sgst: 9,
      tip: 0,
      total: 118,
      payments: [{ mode: "Cash", amount: 118 }],
      cashierName: "Karthik",
      deviceName: "Counter",
      customerId: 3,
      customerName: "Meena",
      customerPhone: "9840012345",
    } as unknown as Parameters<typeof applyCancel>[0];

    const cancelled = applyCancel(bill, "Customer changed mind", "Owner", 1_700_000_100_000);
    expect(cancelled).toEqual({
      ...bill,
      status: "cancelled",
      cancelReason: "Customer changed mind",
      cancelledBy: "Owner",
      cancelledAt: 1_700_000_100_000,
    });
    // The three stamp fields are the ONLY additions (status already existed).
    expect(Object.keys(cancelled).length).toBe(Object.keys(bill).length + 3);
  });
});

/* ------------------------------ Task 3 D --------------------------------- */

describe("security (3D)", () => {
  it("every server function is POST and the data ones require the salon token", () => {
    expect(syncFnsSrc.match(/createServerFn\(\{ method: "POST" \}\)/g)).toHaveLength(4);
    expect(syncFnsSrc).toMatch(/async function requireToken/);
    // Both owner backup functions call requireToken before doing anything.
    const statusFn = syncFnsSrc.slice(syncFnsSrc.indexOf("backupStatusFn"));
    expect(statusFn).toMatch(/requireToken\(data\?\.token\)/);
    const nowFn = syncFnsSrc.slice(syncFnsSrc.indexOf("backupNowFn"));
    expect(nowFn).toMatch(/requireToken\(data\?\.token\)/);
    // The sync push validates the token inside the protocol core.
    expect(syncCoreSrc).toMatch(/auth\.hash !== req\.token/);
    expect(syncCoreSrc).toMatch(/return fail\("auth"\)/);
    // The auth endpoint itself is the intended unauthenticated bootstrap.
    expect(syncFnsSrc).toMatch(/syncAuthFn/);
  });

  it("owner-only screens are gated behind OwnerOnly / useOwner, not just links", () => {
    expect(settingsSrc).toMatch(/<OwnerOnly>/);
    const catalogSrc = read("..", "routes", "catalog.tsx");
    expect(catalogSrc).toMatch(/<OwnerOnly>/);
    expect(billsSrc).toMatch(/const owner = useOwner\(\);/);
  });

  it("no real-looking secrets in the sync source", () => {
    // Server tokens are derived at runtime; nothing hardcoded to leak.
    expect(syncFnsSrc).not.toMatch(/(sk-|api[_-]?key\s*[:=]\s*["'][A-Za-z0-9]{16,})/i);
    expect(syncCoreSrc).not.toMatch(/(sk-|api[_-]?key\s*[:=]\s*["'][A-Za-z0-9]{16,})/i);
  });
});

/* ------------------------------ Task 3 E --------------------------------- */

describe("PWA staleness (3E)", () => {
  it("the service worker is network-first, so it cannot pin a stale build", () => {
    // In the fetch handler the network attempt must come before any cache hit.
    const fetchAt = swSrc.indexOf("fetch(req)");
    const cacheAt = swSrc.indexOf("caches.match(req)");
    expect(fetchAt).toBeGreaterThan(-1);
    expect(cacheAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeLessThan(cacheAt);
    // Cache is versioned and old versions are dropped on activate.
    expect(swSrc).toMatch(/const CACHE = "salonbill-v\d+"/);
    expect(swSrc).toMatch(/caches\.delete\(/);
    expect(swSrc).toMatch(/skipWaiting\(\)/);
    // Server-function RPCs bypass the cache entirely.
    expect(swSrc).toMatch(/text\/x-component/);
  });
});
