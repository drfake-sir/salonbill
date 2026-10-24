/**
 * Forgotten owner PIN recovery.
 *
 * Proves knowledge of the SALON CLOUD PIN (the one every device uses to
 * connect) against the server — which enforces its existing 5-attempt /
 * 5-minute lockout — and only then lets the owner set a new owner PIN. The new
 * PIN is hashed (PBKDF2, see lib/pins) before it ever touches storage, and
 * the settings row update syncs to every device like any other change.
 *
 * Dependencies are injectable so the flow (success / wrong PIN / lockout /
 * hashing / old-PIN invalidation) is unit-testable without a server or Dexie.
 */

import { syncAuthFn } from "@/syncFns";
import { db } from "./db";
import { hashPin, isValidNewPin } from "./pins";

export type RecoveryDeps = {
  /** Verify the salon cloud PIN against the server (lockout lives there). */
  verifyCloudPin: (pin: string) => Promise<{ ok: boolean; error?: string | undefined }>;
  /** Hash the new owner PIN before storage. */
  hash: (pin: string) => Promise<string>;
  /** Persist the new hash (the settings row — syncs like any other update). */
  saveOwnerPin: (hashed: string) => Promise<void>;
};

export const defaultRecoveryDeps: RecoveryDeps = {
  verifyCloudPin: async (pin) => {
    try {
      // No token is sent: runAuth's verifyOnly branch can never bootstrap or
      // rotate the cloud PIN, it only checks it.
      return await syncAuthFn({ data: { pin, verifyOnly: true } });
    } catch (e) {
      console.error("cloud PIN verification failed", e);
      return { ok: false, error: "Could not reach the salon cloud — check the internet" };
    }
  },
  hash: hashPin,
  saveOwnerPin: async (hashed) => {
    await db.settings.update(1, { ownerPin: hashed });
  },
};

export type RecoveryResult = { ok: true } | { ok: false; error: string };

export async function recoverOwnerPin(
  cloudPin: string,
  newPin: string,
  deps: RecoveryDeps = defaultRecoveryDeps,
): Promise<RecoveryResult> {
  if (!/^\d{6,8}$/.test(cloudPin))
    return { ok: false, error: "Enter the 6-8 digit salon cloud PIN" };
  if (!isValidNewPin(newPin)) return { ok: false, error: "New owner PIN must be 6-8 digits" };
  const check = await deps.verifyCloudPin(cloudPin);
  if (!check.ok) return { ok: false, error: check.error || "Wrong PIN" };
  const hashed = await deps.hash(newPin);
  await deps.saveOwnerPin(hashed);
  return { ok: true };
}
