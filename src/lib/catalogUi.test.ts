import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards for the phone-first catalog (Services / Products / Stylists).
 *
 * jsdom has no layout engine, so geometry is verified in the browser matrix
 * (see the test report); these tests pin the exact source rules so a refactor
 * cannot silently drop visible labels, the delete confirmation, the Add form
 * (which must be the ONLY way rows are created) or the tombstone wiring.
 */

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const src = read("routes/catalog.tsx");
const dbSrc = read("lib/db.ts");
const clientSrc = read("lib/syncClient.ts");
const syncSrc = read("server/syncCore.ts");

/** Slice of source from `from` up to (not including) `to`. */
const between = (from: string, to: string) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};

describe("every number box has a VISIBLE label and a numeric keypad", () => {
  it("services: Service name, Price (₹), Duration (min)", () => {
    expect(src).toMatch(/<Field label="Price \(₹\)">/);
    expect(src).toMatch(/<Field label="Duration \(min\)">/);
    expect(src).toMatch(/aria-label="Service name"/);
    // The label text is rendered, not just used as a placeholder attribute.
    const names = [...src.matchAll(/<Field label="([^"]+)">/g)].map((m) => m[1]);
    expect(names).toContain("Price (₹)");
    expect(names).toContain("Duration (min)");
  });

  it("products: Price (₹), Stock, Low-stock alert", () => {
    expect(src).toMatch(/<Field label="Stock">/);
    expect(src).toMatch(/<Field label="Low-stock alert">/);
    expect(src).toMatch(/aria-label="Product name"/);
  });

  it("stylists: Name, Phone (optional), Commission %", () => {
    expect(src).toMatch(/<Field label="Phone \(optional\)">/);
    expect(src).toMatch(/<Field label="Commission %">/);
    expect(src).toMatch(/aria-label="Name"/);
  });

  it("numeric inputs ask for the numeric keypad", () => {
    expect(src).toMatch(/inputMode="decimal"/); // prices
    expect(src).toMatch(/inputMode="numeric"/); // duration / stock / commission
    expect(src).toMatch(/inputMode="tel"/); // stylist phone
    // Every Field renders its label visibly on phones (sm:hidden span).
    expect(src).toMatch(
      /<span className="mb-1 block text-\[11px\] font-semibold uppercase tracking-wide text-muted-foreground sm:hidden">/,
    );
  });

  it("column headers exist for the wide-screen row layout", () => {
    expect(src).toContain("Service name</span>");
    expect(src).toContain("Duration (min)</span>");
    expect(src).toContain("Low-stock alert</span>");
    expect(src).toContain("Commission %</span>");
  });
});

describe("auto-save shows Saving → Saved and errors surface as a toast", () => {
  it("the per-card status renders Saving… then Saved ✓", () => {
    expect(src).toMatch(/data-testid="save-status"/);
    expect(src).toContain('"Saving…"');
    expect(src).toContain('"Saved ✓"');
    expect(src).toMatch(/status === "fading" \? "opacity-0"/); // fades out
    expect(src).toMatch(/setTimeout\(\(\) => setStatus\("fading"\), 1500\)/);
    expect(src).toMatch(/setTimeout\(\(\) => setStatus\("idle"\), 2000\)/);
  });

  it("a failed save shows an error toast and never claims success", () => {
    expect(src).toMatch(/toast\.error\("Could not save — please try again"\)/);
    const useCardSave = between(
      "function useCardSave",
      "/* ------------------------------ add forms",
    );
    expect(useCardSave.indexOf('setStatus("saved")')).toBeGreaterThan(useCardSave.indexOf("try {"));
    expect(useCardSave).toMatch(/catch \(e\) \{[\s\S]*setStatus\("idle"\);[\s\S]*toast\.error\(/);
  });
});

describe("delete needs confirmation and offers Disable instead when used", () => {
  it("a dialog opens before anything is deleted", () => {
    expect(src).toMatch(/function DeleteDialog/);
    expect(src).toMatch(/<Dialog open=\{!!pending\}/);
    expect(src).toMatch(/`Delete “\$\{pending\?\.name\}”\?`/);
    expect(src).toMatch(/setPending\(\{ kind, id, name, count \}\)/);
  });

  it("items used in saved bills get “Disable instead” with an explanation", () => {
    expect(src).toContain("Disable instead");
    expect(src).toMatch(/This \{what\} is used in/);
    expect(src).toMatch(/saved bill\s*\{pending\?\.count === 1 \? "" : "s"\}/);
    expect(src).toMatch(/shows up in Earnings and in your\s*exports/);
    expect(src).toMatch(/Disabling keeps every past bill intact/);
    // The destructive button only exists in the unused branch.
    const dialog = between("function DeleteDialog", "/* --------------------------------- rows");
    const iUsed = dialog.indexOf("{used ? (");
    const iElse = dialog.indexOf(") : (");
    expect(iUsed).toBeGreaterThan(-1);
    expect(iElse).toBeGreaterThan(iUsed);
    // Both affordances exist, in this order: “Disable instead” for used items
    // (description + footer button), then the red Delete only for unused ones —
    // never both for the same item.
    expect(dialog).toContain("Disable instead");
    expect(dialog).toContain("bg-destructive px-4");
    expect(dialog.indexOf("bg-destructive px-4")).toBeGreaterThan(
      dialog.indexOf("Disable instead"),
    );
    expect(dialog.slice(iUsed, iElse)).not.toContain("bg-destructive px-4");
  });

  it("usage is counted from issued (saved) bills only", () => {
    expect(src).toMatch(/db\.bills\.where\("status"\)\.notEqual\("held"\)\.toArray\(\)/);
    expect(src).toMatch(/counts\.svc\.get\(s\.id!\) \?\? 0/);
    expect(src).toMatch(/counts\.sty\.get\(s\.id!\) \?\? 0/);
  });
});

describe("Add form creates a row only on Save", () => {
  it("there is exactly one insert per table and it lives in AddForm.save()", () => {
    const count = (needle: string) => src.split(needle).length - 1;
    expect(count("db.services.add(")).toBe(1);
    expect(count("db.products.add(")).toBe(1);
    expect(count("db.stylists.add(")).toBe(1);
    const addForm = between("function AddForm", "/* --------------------------- delete / disable");
    expect(addForm).toMatch(/const save = async \(\) =>/);
    expect(addForm).toMatch(/await db\.services\.add\(\{/);
    expect(addForm).toMatch(/await db\.products\.add\(\{/);
    expect(addForm).toMatch(/await db\.stylists\.add\(\{/);
    // Cancel just closes the form — no insert path exists outside save().
    expect(addForm).toMatch(/onClick=\{onDone\}[\s\S]{0,80}Cancel/);
  });

  it("Save is disabled until the required fields are valid", () => {
    const addForm = between("function AddForm", "/* --------------------------- delete / disable");
    expect(addForm).toMatch(/const valid =/);
    expect(addForm).toMatch(/disabled=\{!valid\}/);
    expect(addForm).toMatch(/name\.trim\(\)\.length > 0/);
  });

  it("the add form keeps the real field set (service / product / stylist)", () => {
    const addForm = between("function AddForm", "/* --------------------------- delete / disable");
    expect(addForm).toContain('"Service name"');
    expect(addForm).toContain('"Product name"');
    expect(addForm).toContain('"Stylist name"');
    expect(addForm).toContain('label="Phone (optional)"');
    expect(addForm).toContain('label="Commission %"');
    expect(addForm).toContain('label="Low-stock alert"');
  });
});

describe("no placeholder rows are ever created", () => {
  it("no code inserts a “New …” starter row", () => {
    expect(src).not.toMatch(/name:\s*"New /);
    expect(src).not.toMatch(/New stylist/i);
    expect(src).not.toMatch(/New product/i);
    // The only literal "New service" in the file is explanatory prose.
    const hits = src.split("New service").length - 1;
    expect(hits).toBeLessThanOrEqual(1);
    expect(src).toMatch(/there are never blank "New service" rows/);
  });

  it("empty categories say “No services yet” and offer an Add button", () => {
    expect(src).toContain('"No services yet"');
    expect(src).toContain('"No products yet"');
    expect(src).toContain('"No stylists yet"');
    expect(src).toMatch(/emptyRow\("No services yet", "service", c\.id\)/);
  });
});

describe("tabs reachable and the bottom nav never covers the last button", () => {
  it("all three tabs are rendered as buttons", () => {
    expect(src).toMatch(/\(\["services", "products", "stylists"\] as const\)\.map/);
    expect(src).toContain("{t}");
  });

  it("the screen reserves room below the fixed bottom nav", () => {
    expect(src).toMatch(/className="pb-32 md:pb-10"/);
  });
});

describe("deletions sync as ordinary tombstones", () => {
  it("the catalog uses a plain per-row delete so db.ts hooks enqueue it", () => {
    expect(src).toMatch(/await db\.services\.delete\(p\.id\)/);
    expect(src).toMatch(/await db\.products\.delete\(p\.id\)/);
    expect(src).toMatch(/await db\.stylists\.delete\(p\.id\)/);
  });

  it("db.ts registers deleting hooks that enqueue the row for the outbox", () => {
    expect(dbSrc).toMatch(/table\.hook\("deleting"/);
    expect(dbSrc).toMatch(/function enqueueSync\(table: string, id: number\)/);
    // The deleting hook feeds the same enqueueSync as create/update.
    const hooks = dbSrc.slice(dbSrc.indexOf('table.hook("deleting"'));
    expect(hooks.slice(0, 300)).toMatch(/enqueueSync\(t, primKey\)/);
  });

  it('a deleted row is pushed as an `op: "del"` tombstone', () => {
    // Missing row on push → del; that is how catalog deletes reach the cloud.
    expect(clientSrc).toMatch(/if \(!row\) return \{ t: table, id: q\.id, op: "del" \};/);
    expect(syncSrc).toMatch(/op: "put" \| "del"/);
    expect(syncSrc).toMatch(/p\.op === "del"/);
  });

  it("the sync layer transports deletes as tombstones", () => {
    expect(syncSrc).toMatch(/op: "put" \| "del"/);
    expect(syncSrc).toMatch(/p\.op === "del"/);
  });
});

describe("existing rows are untouched by the new add flow", () => {
  it("edits are per-field updates, never whole-table rewrites", () => {
    expect(src).not.toMatch(/db\.services\.bulkPut/);
    expect(src).not.toMatch(/db\.stylists\.bulkPut/);
    expect(src).not.toMatch(/db\.products\.bulkPut/);
    expect(src).toMatch(/db\.services\.update\(s\.id!, \{ price \}\)/);
  });

  it("auto-save only fires on blur, not on every keystroke", () => {
    expect(src).not.toMatch(/onChange=\{\(e\) => void run\(/);
    expect(src.split("onBlur=").length - 1).toBeGreaterThan(6);
  });
});
