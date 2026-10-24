/**
 * Owner & staff PIN storage.
 *
 * Stored shape (in `settings.ownerPin` and `stylists[].pin`):
 *  - legacy: the plain digits themselves ("1234") — how every install up to
 *    now has stored them; these keep working until their owner/staff member
 *    signs in successfully, at which point `migratePin` returns a hash and the
 *    plain value is replaced (and the change syncs like any other row).
 *  - legacy hashed: `s1$<length>$<salt-hex>$<hash-hex>` — SHA-256 of `pin:salt`
 *    with a fresh 16-byte salt per PIN. Still verified; upgraded to the PBKDF2
 *    form at the next successful sign-in.
 *  - current: `p1$<iterations>$<length>$<salt-hex>$<hash-hex>` — PBKDF2
 *    (WebCrypto, SHA-256, {@link PBKDF2_ITERATIONS} iterations, fresh 16-byte
 *    salt per PIN, 256-bit derived key). Every NEW hash is written in this
 *    form.
 *
 * The embedded length keeps the entry UX (verify exactly when the pad reaches
 * the PIN's digit count, so a legacy 4-digit PIN still auto-submits on the
 * 4th press while a new 6-digit one submits on the 6th) and keeps the lockout
 * counter at one attempt per entry.
 *
 * Plain digits can never contain `$`, and the `s1$` / `p1$` prefixes are unambiguous
 * discriminators between the three shapes, so the format stays plainly readable.
 */

/** New PINs must be 6-8 digits (mirrors the salon sync PIN rule). */
export const MIN_NEW_PIN_DIGITS = 6;
export const MAX_PIN_DIGITS = 8;
const NEW_PIN_RE = new RegExp(`^\\d{${MIN_NEW_PIN_DIGITS},${MAX_PIN_DIGITS}}$`);

/** PBKDF2 cost for NEW hashes. Requirement: >= 100000, SHA-256, per-PIN salt. */
export const PBKDF2_ITERATIONS = 100_000;
const SHA256_FORMAT = "s1";
const PBKDF2_FORMAT = "p1";
/** Sanity bounds for the iterations field read from storage (fail closed). */
const MIN_ITERATIONS = 1_000;
const MAX_ITERATIONS = 10_000_000;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

/** PBKDF2(SHA-256) over the PIN bytes with the stored salt, hex-encoded. */
async function pbkdf2Hex(pin: string, saltHex: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations, hash: "SHA-256" },
    key,
    256,
  );
  return toHex(new Uint8Array(bits));
}

/** Is this stored value still the legacy plain digits (needs migration)? */
export function isPlainPin(stored: string | null | undefined): boolean {
  return !!stored && /^\d+$/.test(stored);
}

/**
 * Is this stored value the legacy salted SHA-256 hash? It verifies fine, but
 * at the next successful sign-in it is re-hashed with PBKDF2.
 */
export function isSha256StoredPin(stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  return parts.length === 4 && parts[0] === SHA256_FORMAT && /^\d+$/.test(parts[1] ?? "");
}

/** A new PIN the settings screens must accept: 6-8 digits. */
export function isValidNewPin(pin: string): boolean {
  return NEW_PIN_RE.test(pin);
}

/**
 * How many digits must be typed before this stored PIN is verified, or null
 * when the stored value is unusable (empty / malformed).
 */
export function entryTargetLength(stored: string | null | undefined): number | null {
  if (!stored) return null;
  if (isPlainPin(stored)) return stored.length;
  const parts = stored.split("$");
  // p1$<iter>$<len>$<salt>$<hash> or legacy s1$<len>$<salt>$<hash>
  const lenPart =
    parts[0] === PBKDF2_FORMAT && parts.length === 5
      ? parts[2]
      : parts[0] === SHA256_FORMAT && parts.length === 4
        ? parts[1]
        : undefined;
  if (lenPart !== undefined && /^\d+$/.test(lenPart)) {
    const len = Number(lenPart);
    if (len >= 1 && len <= MAX_PIN_DIGITS) return len;
  }
  return null;
}

/**
 * Salt + PBKDF2 a PIN into the current `p1$...` form. A fresh random salt per
 * call, so identical PINs never share a stored hash.
 */
export async function hashPin(pin: string, saltHex?: string): Promise<string> {
  const salt = saltHex ?? toHex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await pbkdf2Hex(pin, salt, PBKDF2_ITERATIONS);
  return `${PBKDF2_FORMAT}$${PBKDF2_ITERATIONS}$${pin.length}$${salt}$${hash}`;
}

/** Build the legacy `s1$…` form directly (test fixtures for old installs). */
export async function legacySha256Pin(pin: string, saltHex?: string): Promise<string> {
  const salt = saltHex ?? toHex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await sha256Hex(`${pin}:${salt}`);
  return `${SHA256_FORMAT}$${pin.length}$${salt}$${hash}`;
}

/** Does the entered PIN match the stored value (plain, s1 or p1)? */
export async function verifyPin(
  stored: string | null | undefined,
  entered: string,
): Promise<boolean> {
  if (!stored || !entered) return false;
  if (isPlainPin(stored)) return entered === stored;
  const parts = stored.split("$");
  if (parts[0] === SHA256_FORMAT && parts.length === 4) {
    const [, len, salt, hash] = parts;
    if (!len || !salt || !hash) return false;
    if (entered.length !== Number(len)) return false;
    return (await sha256Hex(`${entered}:${salt}`)) === hash;
  }
  if (parts[0] === PBKDF2_FORMAT && parts.length === 5) {
    const [, iterRaw, len, salt, hash] = parts;
    if (!iterRaw || !salt || !hash) return false;
    const iterations = Number(iterRaw);
    // Reject absurd stored costs so a corrupted row can never hang the pad.
    if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS)
      return false;
    if (!len || entered.length !== Number(len)) return false;
    return (await pbkdf2Hex(entered, salt, iterations)) === hash;
  }
  return false;
}

/**
 * On a successful sign-in with a legacy PIN (plain digits OR the old salted
 * SHA-256 hash), return the PBKDF2 form to store. Current `p1$…` hashes and
 * non-matching PINs return null — nothing to change.
 */
export async function migratePin(
  stored: string | null | undefined,
  entered: string,
): Promise<string | null> {
  const legacy = isPlainPin(stored) || isSha256StoredPin(stored);
  if (!legacy) return null;
  if (!(await verifyPin(stored, entered))) return null;
  return hashPin(entered);
}
