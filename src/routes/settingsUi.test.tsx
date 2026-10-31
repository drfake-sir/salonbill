import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CloudBackupCard } from "./settings";

/**
 * Regression guards for Settings:
 *
 *  1. the staff PIN box — wide enough to show its "PIN set ✓" status in full,
 *     the typed value wiped after a successful save, and never echoing a PIN
 *     back (only a salted hash is stored, so there is nothing to echo);
 *  2. the "Cloud backup (automatic)" card — rendered ONLY while the server
 *     confirms cloud backup storage exists, so no red error, no dead button
 *     and no "kept for 13 months" claim when it does not.
 *
 * jsdom has no layout engine, so the actual fit of the placeholder is
 * verified in the browser matrix; these tests pin the source rules.
 */

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const src = read("routes/settings.tsx");

/** Slice of source from `from` up to (not including) `to`. */
const between = (from: string, to: string) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};

/* ------------------------------- staff PINs ------------------------------- */

describe("staff PIN field", () => {
  const row = between("{stylists.map((p) => (", "</section>");

  it('is wide enough (and un-tracked in the placeholder) for "PIN set ✓"', () => {
    expect(row).toContain("w-40");
    expect(row).not.toContain("w-28"); // the old 112px box clipped the status
    expect(row).toContain("placeholder:tracking-normal");
    expect(row).toContain('placeholder={p.pin ? "PIN set ✓" : "No PIN"}');
    // The 0.3em tracking stays on the TYPED digits only.
    expect(row).toContain("tracking-[0.3em]");
  });

  it("clears the typed value after a successful save", () => {
    expect(row).toMatch(/setStaffPin\(p\.id!, v\)\.then\(\(\) => \{\s*target\.value = "";/);
    // …and after clearing a PIN too.
    expect(row).toMatch(/setStaffPin\(p\.id!, undefined\)\.then\(\(\) => \{\s*target\.value = "";/);
  });

  it("never renders a PIN back — the field always starts empty", () => {
    expect(row).toContain('defaultValue=""');
    expect(row).not.toContain("value={p.pin}");
    expect(row).not.toContain("defaultValue={p.pin}");
    // Every reference to the stored value is a condition or the row key.
    for (const m of row.matchAll(/\{p\.pin[^}]*\}/g)) expect(m[0]).toMatch(/[?]/);
  });
});

/* ----------------------------- cloud backup ------------------------------ */

describe("Cloud backup (automatic) card", () => {
  it("renders nothing at all unless the server says storage is available", () => {
    expect(src).toMatch(
      /\/\/ Not enabled \(no R2 storage on this app\)[\s\S]{0,80}?if \(!status\?\.ok\) return null;/,
    );
    // So none of these can appear in the hidden state:
    expect(src).toContain("Cloud backup (automatic)");
    expect(src).toContain("kept for 13 months");
    expect(src).toContain("Back up now");
  });

  it("keeps the manual backup & restore card untouched", () => {
    expect(src).toContain("JSON backup");
    expect(src).toContain("Bills CSV");
    expect(src).toContain("Monthly off-platform copy");
    expect(src).toContain("Restore from file…");
    expect(src).toContain("Run restore drill");
  });
});

/* ------------------------------ cloud card ------------------------------- */

const { statusFn, syncToken } = vi.hoisted(() => ({
  statusFn: vi.fn(),
  syncToken: { value: "tok" as string | null },
}));

vi.mock("@/syncFns", () => ({
  backupStatusFn: statusFn,
  backupNowFn: vi.fn(),
}));

vi.mock("@/lib/syncClient", () => ({
  getSyncToken: () => syncToken.value,
}));

vi.mock("@/lib/db", () => ({
  db: {
    settings: { get: async () => undefined, update: async () => 0 },
    stylists: { toArray: async () => [], update: async () => 0 },
    bills: { toArray: async () => [] },
  },
  getDeviceName: () => "Counter",
  deviceLabel: () => "Counter",
  logAudit: async () => undefined,
  restoreBackup: async () => ({ bills: 0 }),
  setDeviceName: () => undefined,
  validateBackup: () => true,
}));

/** Render and let the status round-trip settle. */
async function renderCard() {
  const utils = render(<CloudBackupCard />);
  await waitFor(() => expect(statusFn).toHaveBeenCalled());
  await act(async () => {}); // flush the resolved status into state
  return utils;
}

describe("<CloudBackupCard />", () => {
  it("is empty (no error, no button, no retention claim) when storage is off", async () => {
    statusFn.mockResolvedValue({
      ok: false,
      error: "Cloud backup storage is not enabled on this app",
    });
    const { container } = await renderCard();
    expect(container.innerHTML).toBe("");
    expect(screen.queryByText(/Cloud backup \(automatic\)/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Back up now/ })).toBeNull();
    expect(screen.queryByText(/13 months/)).toBeNull();
    expect(screen.queryByText(/not enabled/i)).toBeNull();
  });

  it("is also absent while the device holds no sync token", async () => {
    syncToken.value = null;
    statusFn.mockResolvedValue({ ok: false, error: "Owner unlock required" });
    const { container } = await renderCard();
    expect(container.innerHTML).toBe("");
    expect(screen.queryByText(/Not connected to the salon cloud yet/)).toBeNull();
    syncToken.value = "tok";
  });

  it("looks exactly as before when storage is enabled", async () => {
    const at = Date.UTC(2026, 9, 20, 10, 30);
    statusFn.mockResolvedValue({ ok: true, at, rows: 42, bills: 7 });
    const { container } = await renderCard();
    expect(container.textContent).toContain("Cloud backup (automatic)");
    expect(container.textContent).toContain("kept for 13 months");
    expect(container.textContent).toContain("Last cloud backup:");
    expect(container.textContent).toContain("42 rows / 7 bills");
    const btn = screen.getByRole("button", { name: /Back up now/ });
    expect(btn).toBeEnabled();
    // The status check only runs with a token in hand.
    expect(statusFn).toHaveBeenCalledWith({ data: { token: "tok" } });
  });
});
