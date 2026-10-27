import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { ServiceRow } from "./catalog";
import { bulkProblem, computePrice, planBulk, type BulkMode } from "@/lib/bulkPrice";
import type { Service } from "@/lib/db";

/* --------------------------------- mocks ---------------------------------- */

const servicesUpdate = vi.fn((_id: number, _patch: Partial<Service>) => Promise.resolve(1));
vi.mock("@/lib/db", () => ({
  db: {
    services: { update: (id: number, patch: Partial<Service>) => servicesUpdate(id, patch) },
    products: { update: () => Promise.resolve(1) },
    stylists: { update: () => Promise.resolve(1) },
    categories: {},
    bills: {},
  },
  logAudit: () => Promise.resolve(),
  deviceLabel: () => "Counter",
}));
vi.mock("@/components/PinGate", () => ({
  OwnerOnly: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("sonner", () => {
  const toast = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  });
  return { toast };
});

/* --------------------------------- plans ---------------------------------- */

const mode = (over: Partial<BulkMode> = {}): BulkMode => ({
  dir: "up",
  unit: "pct",
  amount: 10,
  rounding: 1,
  includeDisabled: false,
  ...over,
});

const item = (id: number, price: number, active = true) => ({
  id,
  name: `Service ${id}`,
  price,
  active,
});

describe("bulk price arithmetic matches the preview exactly", () => {
  it("percent up and down", () => {
    expect(computePrice(300, mode({ dir: "up", amount: 10 }))).toBe(330);
    expect(computePrice(300, mode({ dir: "down", amount: 10 }))).toBe(270);
    expect(computePrice(301, mode({ dir: "up", amount: 10 }))).toBe(331); // 331.1 → 331
  });

  it("flat ₹ up and down", () => {
    expect(computePrice(300, mode({ unit: "inr", amount: 20 }))).toBe(320);
    expect(computePrice(300, mode({ unit: "inr", amount: 20, dir: "down" }))).toBe(280);
  });

  it("rounds to the nearest ₹1 or ₹5", () => {
    expect(computePrice(310, mode({ amount: 10, rounding: 1 }))).toBe(341);
    expect(computePrice(310, mode({ amount: 10, rounding: 5 }))).toBe(340);
    expect(computePrice(312, mode({ unit: "inr", amount: 7, rounding: 5 }))).toBe(320); // 319 → 320
    expect(computePrice(300, mode({ unit: "inr", amount: 12, rounding: 5 }))).toBe(310);
  });

  it("the plan's `to` is exactly what computePrice returns (preview = result)", () => {
    const items = [item(1, 300), item(2, 310), item(3, 999)];
    const m = mode({ amount: 7, rounding: 5 });
    const plan = planBulk(items, m);
    expect(plan.map((l) => l.to)).toEqual(items.map((i) => computePrice(i.price, m)));
    // Rows whose price would not change are not counted as work.
    const unchanged = planBulk([item(1, 0)], mode({ dir: "down", amount: 10 }));
    expect(unchanged).toHaveLength(0);
  });
});

describe("disabled services are skipped unless asked for", () => {
  it("skips them by default and includes them on the checkbox", () => {
    const items = [item(1, 300), item(2, 300, false)];
    expect(planBulk(items, mode())).toHaveLength(1);
    expect(planBulk(items, mode({ includeDisabled: true }))).toHaveLength(2);
  });
});

describe("empty amounts and results below ₹0 are blocked", () => {
  it("an empty, zero or unparseable amount refuses to apply", () => {
    expect(bulkProblem(mode({ amount: 0 }), [])).toBe("Enter an amount");
    expect(bulkProblem(mode({ amount: Number.NaN }), [])).toBe("Enter an amount");
    expect(bulkProblem(mode({ amount: -5 }), [])).toBe("Enter an amount");
  });

  it("a plan that would push any price under ₹0 is refused", () => {
    const m = mode({ dir: "down", unit: "inr", amount: 50 });
    const plan = planBulk([item(1, 300), item(2, 30)], m);
    expect(plan.find((l) => l.id === 2)?.to).toBe(-20);
    expect(bulkProblem(m, plan)).toBe("A price would fall below ₹0");
  });

  it("a decrease over 100% is refused", () => {
    const m = mode({ dir: "down", amount: 150 });
    expect(bulkProblem(m, planBulk([item(1, 300)], m))).toMatch(/100%/);
  });

  it("a valid plan reports no problem", () => {
    const m = mode({ amount: 10 });
    expect(bulkProblem(m, planBulk([item(1, 300)], m))).toBeNull();
  });
});

describe("the dialog is the only way prices change in bulk", () => {
  it("writes one service update per planned row — never a bill", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "routes", "catalog.tsx"), "utf8");
    const dialog = src.slice(src.indexOf("function BulkPriceDialog"));
    const body = dialog.slice(0, dialog.indexOf("/* --------------------------------- rows"));
    expect(body).toMatch(
      /for \(const l of plan\) await db\.services\.update\(l\.id, \{ price: l\.to \}\)/,
    );
    expect(body).not.toMatch(/db\.bills/);
    expect(body).not.toMatch(/prompt\(/);
    expect(body).toMatch(/toast\.success\(`Updated \$\{plan\.length\} prices`\)/);
    expect(body).toMatch(/Apply to \$\{plan\.length\}/);
    expect(body).toMatch(/data-testid="bulk-preview"/);
    expect(body).toMatch(/disabled=\{!!problem \|\| busy\}/);
    expect(body).toMatch(/Include disabled services/);
    expect(body).toMatch(/Nearest ₹5/);
    // The old implementation (percent prompt + Collection.modify) is gone.
    expect(src).not.toMatch(/Change prices in this category by %/);
    expect(src).not.toMatch(/\.where\("categoryId"\)\s*\.equals\(/);
    // Saved bills keep their own line price snapshot — no code path rewrites it.
    expect(src).not.toMatch(/bills\.(update|put|modify)/);
  });
});

/* ------------------------ live list + smooth typing ------------------------ */

const base: Service = {
  id: 7,
  categoryId: 1,
  name: "Men's Haircut",
  price: 300,
  duration: 30,
  gstRate: 18,
  commissionPct: 10,
  active: true,
};

describe("a price changed elsewhere shows up without reloading", () => {
  it("adopts the stored price while the box is untouched", () => {
    const { rerender } = render(<ServiceRow s={base} usedCount={0} onDeleteClick={() => {}} />);
    const box = screen.getByLabelText("Price (₹)") as HTMLInputElement;
    expect(box.value).toBe("300");

    // What the bulk dialog (or another device's sync) just wrote.
    rerender(<ServiceRow s={{ ...base, price: 330 }} usedCount={0} onDeleteClick={() => {}} />);
    expect(box.value).toBe("330");

    rerender(<ServiceRow s={{ ...base, price: 0 }} usedCount={0} onDeleteClick={() => {}} />);
    expect((screen.getByLabelText("Price (₹)") as HTMLInputElement).value).toBe("0");
    // The other boxes keep their own values — only the price is adopted.
    expect((screen.getByLabelText("Duration (min)") as HTMLInputElement).value).toBe("30");
  });

  it("never overwrites what the cashier is typing", () => {
    const { rerender } = render(<ServiceRow s={base} usedCount={0} onDeleteClick={() => {}} />);
    const box = screen.getByLabelText("Price (₹)") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "355" } });
    rerender(<ServiceRow s={{ ...base, price: 330 }} usedCount={0} onDeleteClick={() => {}} />);
    expect(box.value).toBe("355"); // half-typed edit wins over the external value
  });
});

describe("typing fast produces exactly one save after the pause", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    servicesUpdate.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("no write per keystroke, no write on focus/blur alone, one write after 600ms", () => {
    render(<ServiceRow s={base} usedCount={0} onDeleteClick={() => {}} />);
    const box = screen.getByLabelText("Price (₹)") as HTMLInputElement;

    fireEvent.change(box, { target: { value: "3" } });
    fireEvent.change(box, { target: { value: "31" } });
    fireEvent.change(box, { target: { value: "315" } });
    fireEvent.blur(box);
    expect(servicesUpdate).not.toHaveBeenCalled(); // still inside the pause

    act(() => {
      vi.advanceTimersByTime(599);
    });
    expect(servicesUpdate).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(servicesUpdate).toHaveBeenCalledTimes(1);
    expect(servicesUpdate).toHaveBeenCalledWith(7, { price: 315 });

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(servicesUpdate).toHaveBeenCalledTimes(1); // still just the one
  });

  it("an unchanged value schedules nothing at all", () => {
    render(<ServiceRow s={base} usedCount={0} onDeleteClick={() => {}} />);
    const box = screen.getByLabelText("Price (₹)") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "300" } }); // same as stored
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(servicesUpdate).not.toHaveBeenCalled();
  });

  it("a blank or negative box never reaches the database", () => {
    render(<ServiceRow s={base} usedCount={0} onDeleteClick={() => {}} />);
    const box = screen.getByLabelText("Price (₹)") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "-9" } });
    fireEvent.blur(box);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(servicesUpdate).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
    expect(box.value).toBe("300"); // restored, never left invalid
  });
});
