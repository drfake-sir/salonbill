import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PersonChip } from "./PersonChip";
import { setSession } from "@/lib/lock";

/* --------------------------------- mocks ---------------------------------- */

type SessionShape = { role: "staff" | "owner"; name: string; staffId?: number } | null;
let session: SessionShape = null;

vi.mock("@/lib/lock", () => ({
  useSession: () => session,
  setSession: vi.fn(),
  useOwner: () => session?.role === "owner",
}));

const DEVICE = vi.fn(() => "Counter");
vi.mock("@/lib/db", () => ({
  getDeviceName: () => DEVICE(),
  deviceLabel: (b: { deviceName?: string }) => b.deviceName?.trim() || "Unknown device",
}));

/* --------------------------------- tests ---------------------------------- */

describe("the top bar says who is using this device", () => {
  it("nobody signed in → “Locked - tap to sign in”", () => {
    session = null;
    render(<PersonChip />);
    expect(screen.getByTestId("person-name").textContent).toBe("Locked - tap to sign in");
    expect(screen.getByTestId("person-name-wide").textContent).toBe("Locked - tap to sign in");
    expect(screen.getByTestId("person-avatar").textContent).toBe("?");
  });

  it("a signed-in stylist shows their name (first name on phones)", () => {
    session = { role: "staff", staffId: 3, name: "Arun Kumar" };
    render(<PersonChip />);
    expect(screen.getByTestId("person-name").textContent).toBe("Arun"); // phone
    expect(screen.getByTestId("person-name-wide").textContent).toBe("Arun Kumar"); // desktop
    expect(screen.getByTestId("person-avatar").textContent).toBe("A");
  });

  it("the owner shows as Owner", () => {
    session = { role: "owner", name: "Owner" };
    render(<PersonChip />);
    expect(screen.getByTestId("person-name-wide").textContent).toBe("Owner");
    expect(screen.getByTestId("person-avatar").textContent).toBe("O");
  });

  it("the device name rides along in the bar on wide screens only", () => {
    session = { role: "staff", staffId: 1, name: "Priya" };
    render(<PersonChip />);
    const dev = screen.getByTestId("person-device");
    expect(dev.textContent).toBe("Counter");
    expect(dev.className).toContain("hidden"); // phones hide it…
    expect(dev.className).toContain("md:block"); // …desktop shows it
    expect(screen.getByTestId("person-chip").textContent).toContain("Priya");
  });
});

describe("the chip is in the layout — it can never cover a control", () => {
  it("uses no floating positioning of its own", () => {
    session = { role: "staff", staffId: 1, name: "Priya" };
    render(<PersonChip />);
    const chip = screen.getByTestId("person-chip");
    expect(chip.className).not.toMatch(/\b(fixed|absolute|sticky)\b/);
    expect(chip.className).toContain("shrink-0"); // never squeezes the sync text
  });

  it("shows nothing but the name until it is tapped", () => {
    session = { role: "staff", staffId: 1, name: "Priya" };
    render(<PersonChip />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("person-chip"));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("the sheet: signed in as …, device …, Switch person, Lock now", () => {
  it("names the person and the device", () => {
    session = { role: "owner", name: "Owner" };
    render(<PersonChip />);
    fireEvent.click(screen.getByTestId("person-chip"));
    expect(screen.getByTestId("sheet-person").textContent).toBe("Owner");
    expect(screen.getByTestId("sheet-device").textContent).toBe("Counter");
    expect(screen.getByText("Switch person")).toBeTruthy();
    expect(screen.getByText("Lock now")).toBeTruthy();
  });

  it("says “nobody (locked)” when nothing is signed in", () => {
    session = null;
    render(<PersonChip />);
    fireEvent.click(screen.getByTestId("person-chip"));
    expect(screen.getByTestId("sheet-person").textContent).toBe("nobody (locked)");
    expect(screen.getByTestId("sheet-device").textContent).toBe("Counter");
  });

  it("Switch person and Lock now both end the session", () => {
    session = { role: "staff", staffId: 2, name: "Karthik" };
    render(<PersonChip />);
    fireEvent.click(screen.getByTestId("person-chip"));
    fireEvent.click(screen.getByTestId("lock-now"));
    expect(vi.mocked(setSession)).toHaveBeenCalledWith(null);
    expect(screen.queryByRole("dialog")).toBeNull();

    vi.mocked(setSession).mockClear();
    fireEvent.click(screen.getByTestId("person-chip"));
    fireEvent.click(screen.getByTestId("switch-person"));
    expect(vi.mocked(setSession)).toHaveBeenCalledWith(null);
  });

  it("Escape closes the sheet", () => {
    session = { role: "owner", name: "Owner" };
    render(<PersonChip />);
    fireEvent.click(screen.getByTestId("person-chip"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("device naming happens once, in-app, with the two real suggestions", () => {
  it("SyncGate keeps its one-time dialog and never calls window.prompt", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "components", "SyncGate.tsx"), "utf8");
    expect(src).toMatch(/\{!named && \(\s*<DeviceNameDialog/);
    expect(src).toMatch(
      /setNamed\(!!getDeviceName\(\)\); \/\/ already named → the dialog never reappears/,
    );
    expect(src).toContain('["Counter", "Owner phone"]');
    expect(src).not.toMatch(/[^\w.]prompt\(/); // no live prompt() call (comments may name it)
    // The suggestion is used as the fallback inside the normalizer.
    expect(src).toMatch(/setDeviceName\(askDeviceName\(suggested, \(\) => answer\)\)/);
  });

  it("Settings → This device is the rename path, for future bills only", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "routes", "settings.tsx"), "utf8");
    expect(src).toMatch(/function DeviceNameCard/);
    expect(src).toMatch(/This device\s*<\/h2>/);
    expect(src).toMatch(/setDeviceName\(clean\)/);
    // The card itself is an input field — renaming never goes through a prompt.
    const card = src.slice(src.indexOf("function DeviceNameCard"));
    const body = card.slice(0, card.indexOf("function ", 10));
    expect(body).not.toMatch(/[^\w.]prompt\(/);
    expect(body).toMatch(/<input/);
  });
});
