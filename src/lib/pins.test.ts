import { describe, expect, it } from "vitest";
import {
  PBKDF2_ITERATIONS,
  entryTargetLength,
  hashPin,
  isPlainPin,
  isSha256StoredPin,
  isValidNewPin,
  legacySha256Pin,
  migratePin,
  verifyPin,
} from "./pins";
import { validateBackup } from "./db";

/* ------------------------------- migration ------------------------------- */

describe("legacy plain PIN login then migration", () => {
  it("verifies the legacy plain value and returns a PBKDF2 replacement", async () => {
    // Legacy install: settings.ownerPin === "1234" (plain digits).
    expect(isPlainPin("1234")).toBe(true);
    expect(entryTargetLength("1234")).toBe(4); // pad still submits on the 4th digit
    expect(await verifyPin("1234", "1234")).toBe(true);

    const migrated = await migratePin("1234", "1234");
    expect(migrated).toBeTruthy();
    expect(migrated).not.toBe("1234");
    expect(isPlainPin(migrated!)).toBe(false);

    // Format stays readable: p1$<iterations>$<len>$<32-hex salt>$<64-hex hash>.
    const parts = migrated!.split("$");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("p1");
    expect(Number(parts[1])).toBeGreaterThanOrEqual(100_000); // PBKDF2 cost
    expect(parts[1]).toBe(String(PBKDF2_ITERATIONS));
    expect(parts[2]).toBe("4"); // digit count preserved for the pad + lockout
    expect(parts[3]).toMatch(/^[0-9a-f]{32}$/);
    expect(parts[4]).toMatch(/^[0-9a-f]{64}$/);
    expect(entryTargetLength(migrated!)).toBe(4);

    // The migrated form verifies — and can't be migrated again.
    expect(await verifyPin(migrated, "1234")).toBe(true);
    expect(await migratePin(migrated, "1234")).toBeNull();
  });

  it("hashes a fresh salt per PIN so identical PINs do not share hashes", async () => {
    const a = await hashPin("123456");
    const b = await hashPin("123456");
    expect(a).not.toBe(b); // different salts
    expect(await verifyPin(a, "123456")).toBe(true);
    expect(await verifyPin(b, "123456")).toBe(true);
  });

  it("refuses migration when the entered PIN does not match", async () => {
    expect(await migratePin("1234", "9999")).toBeNull();
    expect(await migratePin(undefined, "1234")).toBeNull();
    expect(await migratePin(null, "1234")).toBeNull();
    const s1 = await legacySha256Pin("4321");
    expect(await migratePin(s1, "9999")).toBeNull();
  });
});

/* ------------------ existing SHA-256 hash still logs in ------------------ */

describe("legacy SHA-256 (s1) hash login then upgrade", () => {
  it("verifies an existing s1 hash and upgrades it to PBKDF2 at sign-in", async () => {
    const stored = await legacySha256Pin("4321");
    expect(isSha256StoredPin(stored)).toBe(true);
    expect(stored.startsWith("s1$")).toBe(true);
    expect(entryTargetLength(stored)).toBe(4);
    expect(await verifyPin(stored, "4321")).toBe(true);
    expect(await verifyPin(stored, "4322")).toBe(false);

    // Upgrade on the next successful sign-in.
    const upgraded = await migratePin(stored, "4321");
    expect(upgraded).toBeTruthy();
    expect(upgraded!.startsWith("p1$")).toBe(true);
    expect(isSha256StoredPin(upgraded)).toBe(false);
    expect(await verifyPin(upgraded, "4321")).toBe(true);
    expect(entryTargetLength(upgraded)).toBe(4); // pad length unchanged

    // Already-current hashes are left alone.
    expect(await migratePin(upgraded, "4321")).toBeNull();
  });

  it("never mistakes a current p1 hash for a legacy s1 hash", async () => {
    const p1 = await hashPin("123456");
    expect(isSha256StoredPin(p1)).toBe(false);
    expect(isSha256StoredPin("1234")).toBe(false);
    expect(isSha256StoredPin("s1$a$b$c")).toBe(false); // malformed
    expect(isSha256StoredPin(null)).toBe(false);
  });
});

/* ------------------------- new PBKDF2 hashes ----------------------------- */

describe("new PIN hashes use PBKDF2", () => {
  it("writes p1$<iterations>$… with >= 100000 iterations and verifies it", async () => {
    const hashed = await hashPin("654321");
    const [fmt, iter] = hashed.split("$");
    expect(fmt).toBe("p1");
    expect(Number(iter)).toBeGreaterThanOrEqual(100_000);
    expect(await verifyPin(hashed, "654321")).toBe(true);
    expect(await verifyPin(hashed, "6543211")).toBe(false); // length guard first
    expect(await verifyPin(hashed, "111111")).toBe(false);
  });

  it("fails closed on a corrupted iterations field instead of hanging", async () => {
    const hashed = await hashPin("654321");
    const [fmt, , len, salt, hash] = hashed.split("$");
    expect(await verifyPin(`${fmt}$0$${len}$${salt}$${hash}`, "654321")).toBe(false);
    expect(await verifyPin(`${fmt}$abc$${len}$${salt}$${hash}`, "654321")).toBe(false);
    expect(await verifyPin(`p2$${PBKDF2_ITERATIONS}$${len}$${salt}$${hash}`, "654321")).toBe(false);
  });
});

/* -------------------------------- wrong PIN ------------------------------ */

describe("wrong PIN", () => {
  it("rejects a wrong PIN in plain, s1 and p1 storage", async () => {
    expect(await verifyPin("1234", "9999")).toBe(false);
    const s1 = await legacySha256Pin("123456");
    expect(await verifyPin(s1, "654321")).toBe(false);
    const hashed = await hashPin("123456");
    expect(await verifyPin(hashed, "654321")).toBe(false);
    // Length mismatch is rejected without hashing (lockout stays 1 per entry).
    expect(await verifyPin(hashed, "1234")).toBe(false);
    // Garbage / empty stored values never verify.
    expect(await verifyPin("", "1234")).toBe(false);
    expect(await verifyPin("s1$x$y$z", "1234")).toBe(false);
    expect(await verifyPin("p1$100000$x$y$z", "1234")).toBe(false);
    expect(await verifyPin(hashed, "")).toBe(false);
  });
});

/* --------------------------- 6-digit minimum ----------------------------- */

describe("6-digit minimum for new PINs", () => {
  it("accepts only 6-8 digit PINs for NEW owner/staff PINs", () => {
    expect(isValidNewPin("1234")).toBe(false); // existing 4-digit stays valid to USE, not to SET
    expect(isValidNewPin("12345")).toBe(false);
    expect(isValidNewPin("123456")).toBe(true);
    expect(isValidNewPin("1234567")).toBe(true);
    expect(isValidNewPin("12345678")).toBe(true);
    expect(isValidNewPin("123456789")).toBe(false);
    expect(isValidNewPin("12ab56")).toBe(false);
    expect(isValidNewPin("  123456")).toBe(false);
    expect(isValidNewPin("")).toBe(false);
  });

  it("a migrated 6-digit PIN keeps a 6-digit entry target", async () => {
    const hashed = await migratePin("123456", "123456");
    expect(entryTargetLength(hashed)).toBe(6);
    expect(await verifyPin(hashed, "123456")).toBe(true);
  });
});

/* ------------------------ backup never has plain PINs -------------------- */

describe("backup file has no plain PIN after migration", () => {
  it("the exported settings + stylist rows carry only salted hashes", async () => {
    // What Settings → Restore consumes: a settings row and stylists array.
    const ownerPin = await migratePin("987654", "987654"); // was legacy plain
    const staffPin = await hashPin("123456"); // set fresh via Settings (hashed at set time)
    expect(ownerPin && staffPin).toBeTruthy();

    const settingsRow = { id: 1, salonName: "Glow", ownerPin, billSeq: 12 };
    const priya = { id: 1, name: "Karthik", pin: staffPin, active: true };
    const stylists = [priya];

    // Every PIN field in the file is in hashed form, never plain digits.
    expect(isPlainPin(settingsRow.ownerPin)).toBe(false);
    expect(isPlainPin(priya.pin)).toBe(false);

    // The file still round-trips through the restore validator...
    const file = { bills: [{ number: "SB-0001", lines: [] }], settings: [settingsRow], stylists };
    expect(validateBackup(file)).toBe(true);
    // ...and the JSON text contains no standalone plain PIN value.
    const text = JSON.stringify(file);
    expect(text).not.toContain('"987654"');
    expect(text).not.toContain('"123456"');

    // Devices restoring this file can still sign in with the ORIGINAL PINs.
    expect(await verifyPin(settingsRow.ownerPin, "987654")).toBe(true);
    expect(await verifyPin(priya.pin, "123456")).toBe(true);
  });
});

/* ------------------ hash survives sync to a second device ---------------- */

describe("hash survives sync to a second device", () => {
  it("a second device pulling the rows verifies the original PIN against the hash", async () => {
    const { createMemoryStore } = await import("../server/memoryStore");
    const { runAuth, runSync } = await import("../server/syncCore");
    const store = createMemoryStore();
    const auth = await runAuth(store, { pin: "482917" });
    if (!auth.ok || !auth.token) throw new Error("salon setup failed");
    const token = auth.token;

    const ownerPin = await hashPin("654321");
    const staffPin = await hashPin("111122");

    // Device 1 pushes its migrated rows through the normal sync protocol.
    const push = await runSync(store, {
      deviceId: "d1",
      token,
      cursor: 0,
      push: [
        { t: "settings", id: 1, op: "put", data: { id: 1, salonName: "Glow", ownerPin } },
        {
          t: "stylists",
          id: 2,
          op: "put",
          data: { id: 2, name: "Priya", pin: staffPin, active: true },
        },
      ],
    });
    expect(push.ok).toBe(true);

    // Device 2 pulls them (cursor 0 = fresh device) and verifies locally.
    const pull = await runSync(store, { deviceId: "d2", token, cursor: 0 });
    const gotSettings = pull.pull.find((r) => r.t === "settings" && r.id === 1)?.data as
      { ownerPin?: string } | undefined;
    const gotStylist = pull.pull.find((r) => r.t === "stylists" && r.id === 2)?.data as
      { pin?: string } | undefined;
    expect(gotSettings?.ownerPin).toBe(ownerPin); // identical stored bytes
    expect(gotStylist?.pin).toBe(staffPin);
    expect(gotSettings?.ownerPin?.startsWith("p1$")).toBe(true); // still PBKDF2 after sync
    expect(await verifyPin(gotSettings?.ownerPin, "654321")).toBe(true);
    expect(await verifyPin(gotStylist?.pin, "111122")).toBe(true);
    expect(await verifyPin(gotSettings?.ownerPin, "000000")).toBe(false);
  });
});
