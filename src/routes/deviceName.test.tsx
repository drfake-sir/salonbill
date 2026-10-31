import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * "This device" name field is a DRAFT until Save:
 *  - typing changes nothing in storage or in the promise made to the owner,
 *  - Save is disabled until the draft differs and is not empty,
 *  - Save stores it, shows "Saved ✓", toasts and updates the helper text,
 *  - Cancel restores the saved name,
 *  - new bills read the SAVED name (getDeviceName() is only read up front).
 */

const h = vi.hoisted(() => ({
  stored: "Counter",
  setDeviceName: vi.fn((n: string) => {
    h.stored = n;
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/syncFns", () => ({ backupStatusFn: vi.fn(), backupNowFn: vi.fn() }));
vi.mock("@/lib/syncClient", () => ({ getSyncToken: () => null }));
vi.mock("@/lib/db", () => ({
  db: {
    settings: { get: async () => undefined, update: async () => 0 },
    stylists: { toArray: async () => [], update: async () => 0 },
    bills: { toArray: async () => [] },
  },
  getDeviceName: () => h.stored,
  setDeviceName: (n: string) => h.setDeviceName(n),
  deviceLabel: () => h.stored,
  logAudit: vi.fn(async () => undefined),
  restoreBackup: vi.fn(async () => ({ bills: 0 })),
  validateBackup: vi.fn(() => true),
  RESTORABLE: [
    "categories",
    "services",
    "products",
    "stylists",
    "customers",
    "bills",
    "settings",
    "audit",
  ],
  defaultSettings: {},
}));

import { DeviceNameCard } from "./settings";
import { toast } from "sonner";

const input = () => screen.getByPlaceholderText("Counter, Owner phone…") as HTMLInputElement;
const helper = () => screen.getByText(/New bills on this device will read/);
const saveBtn = () => screen.getByRole("button", { name: "Save" });
const cancelBtn = () => screen.getByRole("button", { name: "Cancel" });

beforeEach(() => {
  vi.clearAllMocks();
  h.stored = "Counter";
});

describe("device name is a draft until saved", () => {
  it("starts with the saved name, Save disabled and Cancel disabled", () => {
    render(<DeviceNameCard />);
    expect(input().value).toBe("Counter");
    expect(saveBtn()).toBeDisabled();
    expect(cancelBtn()).toBeDisabled();
    expect(helper()).toHaveTextContent("New bills on this device will read “Counter”.");
  });

  it("typing changes only the draft — nothing is stored, the promise is unchanged", () => {
    render(<DeviceNameCard />);
    fireEvent.change(input(), { target: { value: "Front desk" } });
    expect(input().value).toBe("Front desk");
    expect(h.setDeviceName).not.toHaveBeenCalled();
    expect(screen.queryByTestId("device-saved")).toBeNull();
    // helper text still promises the SAVED name
    expect(helper()).toHaveTextContent("New bills on this device will read “Counter”.");
    expect(saveBtn()).toBeEnabled();
    expect(cancelBtn()).toBeEnabled();
  });

  it("Save stores it, shows “Saved ✓”, toasts and updates the helper text", () => {
    render(<DeviceNameCard />);
    fireEvent.change(input(), { target: { value: "Front desk" } });
    fireEvent.click(saveBtn());
    expect(h.setDeviceName).toHaveBeenCalledWith("Front desk");
    expect(screen.getByTestId("device-saved")).toHaveTextContent("Saved ✓");
    expect(toast.success).toHaveBeenCalled();
    expect(helper()).toHaveTextContent("New bills on this device will read “Front desk”.");
    expect(input().value).toBe("Front desk");
    // nothing left to save or cancel
    expect(saveBtn()).toBeDisabled();
    expect(cancelBtn()).toBeDisabled();
  });

  it("Cancel restores the saved name and leaves storage alone", () => {
    render(<DeviceNameCard />);
    fireEvent.change(input(), { target: { value: "Front desk" } });
    fireEvent.click(cancelBtn());
    expect(input().value).toBe("Counter");
    expect(h.setDeviceName).not.toHaveBeenCalled();
    expect(saveBtn()).toBeDisabled();
    expect(helper()).toHaveTextContent("New bills on this device will read “Counter”.");
  });

  it("Save stays disabled for an empty (or blank) name", () => {
    render(<DeviceNameCard />);
    fireEvent.change(input(), { target: { value: "   " } });
    expect(input().value).toBe("   ");
    expect(saveBtn()).toBeDisabled();
    fireEvent.change(input(), { target: { value: "" } });
    expect(saveBtn()).toBeDisabled();
    expect(h.setDeviceName).not.toHaveBeenCalled();
  });

  it("Save has no auto-save on blur — storage changes on Save only", () => {
    const src = readFileSync(join(__dirname, "settings.tsx"), "utf8");
    const start = src.indexOf("export function DeviceNameCard");
    const end = src.indexOf("function DataSafetyCard", start);
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, end);
    expect(body).not.toContain("onBlur");
    expect(body).toContain("setDeviceName(clean)");
    expect(body).toContain('data-testid="device-saved"');
  });
});
