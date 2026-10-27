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
    // Row fields show their own label below lg (card layout); the title row
    // takes over at lg. Add forms pass `always`, so they are never bare.
    expect(src).toContain(
      'className={`mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground ${always ? "" : "lg:hidden"}`}',
    );
    const addForm = between("function AddForm", "/* --------------------------- delete / disable");
    const fields = [...addForm.matchAll(/<Field label=(?:"[^"]+"|\{label\})( always)?>/g)];
    expect(fields.length).toBeGreaterThan(5);
    expect(fields.every((m) => m[1] === " always")).toBe(true); // never bare
  });

  it("column headers exist for the wide-screen row layout", () => {
    expect(src).toContain("Service name</span>");
    expect(src).toContain("Duration (min)</span>");
    expect(src).toContain("Low-stock alert</span>");
    expect(src).toContain("Commission %</span>");
  });
});

describe("one shared grid: titles and every data row use the same fixed tracks", () => {
  const tpl = between("const colTpl =", "/** One labelled field");

  it("each list defines fixed tracks (no content-sized `auto` column)", () => {
    expect(tpl).toMatch(/services: "lg:grid-cols-\[minmax\(0,1fr\)/);
    expect(tpl).toMatch(/products: "lg:grid-cols-\[minmax\(0,1fr\)/);
    expect(tpl).toMatch(/stylists: "lg:grid-cols-\[minmax\(0,1fr\)/);
    // An `auto` track is exactly what let the caption width shift the boxes.
    expect(tpl).not.toMatch(/_auto\]/);
    // Every column after the name has an explicit rem width.
    const trackStrings = tpl
      .split("lg:grid-cols-[")
      .slice(1)
      .map((t) => t.slice(0, t.indexOf("]")));
    expect(trackStrings.length).toBe(3);
    for (const tracks of trackStrings) {
      const parts = tracks.split("_");
      expect(parts.length).toBeGreaterThan(3);
      const isRem = (t: string) => t.endsWith("rem") && t.slice(0, -3) === String(parseFloat(t));
      expect(parts.slice(1).every((t) => isRem(t))).toBe(true);
    }
  });

  it("the title row and all three row components reuse that one template", () => {
    for (const key of ["services", "products", "stylists"]) {
      const uses = src.split(`\${colTpl.${key}}`).length - 1;
      expect(uses).toBe(2); // one title row + one data row component
      expect(src).toContain(`headCls} \${colTpl.${key}}`);
    }
  });

  it("titles never wrap and the title row only renders when there are rows", () => {
    expect(src).toMatch(/const headCell = "whitespace-nowrap"/);
    expect(src).toMatch(/\{rows\.length > 0 && \(\s*<div className=\{`\$\{headCls\}/);
    expect(src).toMatch(/\{products\.length > 0 && \(/);
    expect(src).toMatch(/\{stylists\.length > 0 && \(/);
    // And an empty list still shows its own empty state + Add button.
    expect(src).toMatch(/emptyRow\("No services yet", "service", c\.id\)/);
  });

  it("the caption is its own grid cell, never inside the button row", () => {
    // Buttons: one flex row below lg, `display: contents` at lg so Disable /
    // Delete / Earnings each take their own fixed track.
    expect(src).toMatch(/order-4 flex items-center gap-2 lg:order-none lg:contents/);
    // Caption: second cell of the card (right under the name), last track at lg.
    expect(src).toMatch(/className="order-2 text-\[11px\] text-muted-foreground lg:order-none"/);
    expect(src).not.toMatch(/w-full text-\[11px\] text-muted-foreground sm:w-auto/);
    // The caption is a sibling of the field group, not inside the button row:
    // in each row component the button wrapper closes before the caption opens.
    const caps =
      src.match(
        /<\/div>\s*(?:\{\/\*[\s\S]*?\*\/}\s*)?\{usedCount > 0 && \(\s*<span className="order-2/g,
      ) ?? [];
    expect(caps.length).toBe(3);
    // …and no `used in` string sits between the button wrapper's opening tag
    // and its close, i.e. the caption is never a button-row child.
    for (const m of src.matchAll(/<div className="order-4[^>]*>/g)) {
      const end = src.indexOf("</div>", m.index ?? 0);
      expect(src.slice(m.index ?? 0, end)).not.toContain("used in {usedCount");
    }
  });

  it("every row orders name → caption → fields → buttons in card layout", () => {
    expect(src.match(/order-1 flex min-w-0 items-center gap-2 lg:order-none/g)?.length).toBe(3);
    expect(src.match(/order-3 grid grid-cols-2 gap-2/g)?.length).toBe(3);
    expect(src.match(/order-4 flex items-center gap-2 lg:order-none lg:contents/g)?.length).toBe(3);
    expect(
      src.match(/className="order-2 text-\[11px\] text-muted-foreground lg:order-none"/g)?.length,
    ).toBe(3);
  });
});

describe("row buttons are one shape: 44px tall, centred, never clipped", () => {
  it("Disable / Delete / Earnings all come from the same 44px class", () => {
    const cls = between("const btnCls =", "const colTpl =");
    expect(cls).toMatch(/h-11/);
    expect(cls).toMatch(/inline-flex/);
    expect(cls).toMatch(/items-center/);
    expect(cls).toMatch(/justify-center/);
    expect(cls).toMatch(/whitespace-nowrap/);
    expect(cls).toMatch(/rounded-xl/);
    expect(cls).toMatch(/const btn = `\$\{btnCls\} bg-secondary`/);
    expect(cls).toMatch(/const btnAccent = `\$\{btnCls\} bg-accent/);
    expect(cls).toMatch(/const btnDanger = `\$\{btnCls\} bg-destructive\/10/);
    // The Earnings link is an <a> — it must use the same class as the buttons.
    expect(src).toMatch(
      /<Link to="\/earnings" search=\{\{ stylist: s\.id \?\? 0 \}\} className=\{btnAccent\}>/,
    );
    // No row button may fall back to the old bare classes.
    expect(src).not.toMatch(
      /className="tap shrink-0 rounded-xl bg-(secondary|accent|destructive\/10) px-3/,
    );
  });

  it("the Add button is the same height as the row buttons", () => {
    expect(src).toMatch(
      /className="tap flex h-11 shrink-0 items-center gap-1 rounded-xl bg-accent/,
    );
  });
});

describe("auto-save is debounced and only fires when a value changed", () => {
  it("one write ~600ms after typing stops, rescheduled per keystroke", () => {
    expect(src).toMatch(/const AUTO_SAVE_MS = 600/);
    expect(src).toMatch(/const schedule = \(key: string, job: \(\) => Promise<unknown>\) =>/);
    expect(src).toMatch(/clearTimeout\(prev\)/);
    expect(src).toMatch(
      /window\.setTimeout\(\(\) => \{[\s\S]*?void run\(job\);\s*\}, AUTO_SAVE_MS\)/,
    );
    expect(src.match(/schedule\("/g)?.length).toBeGreaterThanOrEqual(10);
  });

  it("no field writes on focus/blur alone or per keystroke", () => {
    // Never a direct write from onChange, never a write without a change guard.
    expect(src).not.toMatch(/onChange=\{\(e\) => void run\(/);
    expect(src).not.toMatch(/onFocus=/);
    expect(src).not.toMatch(/if \(v !== s\.phone\) void run\(/);
    // Every numeric onChange bails out when the parsed value equals the stored one.
    expect(src.match(/if \(\w+ === (s|p)\.\w+\) return;/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("the SaveStatus slot is always rendered at a fixed width", () => {
    expect(src).not.toMatch(/if \(status === "idle"\) return null/);
    expect(src).toContain("className={`w-16 shrink-0 text-right text-xs font-semibold");
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

  it("a short reason sits beside the disabled Save button", () => {
    const addForm = between("function AddForm", "/* --------------------------- delete / disable");
    expect(addForm).toMatch(/const reason = !name\.trim\(\)/);
    expect(addForm).toContain('"Enter a name"');
    expect(addForm).toContain('"Enter a price"');
    expect(addForm).toMatch(/data-testid="add-reason"/);
    expect(addForm).toMatch(/mr-auto text-xs font-medium text-muted-foreground/);
  });

  it("the add form is one column on phones", () => {
    const addForm = between("function AddForm", "/* --------------------------- delete / disable");
    expect(addForm).toMatch(/grid grid-cols-1 gap-2 sm:grid-cols-2/);
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

describe("duration 0 reads as an empty box with the “min” hint", () => {
  it("a zero duration is stored as 0 but shown empty", () => {
    expect(src).toMatch(/defaultValue=\{s\.duration > 0 \? s\.duration : ""\}/);
    expect(src).toMatch(/placeholder="min"/);
    // Clearing the box means 0, and 0 never round-trips into a visible "0".
    expect(src).toMatch(/const n = raw === "" \? 0 : Number\(raw\)/);
    // Prices take whole numbers and decimals, never negatives.
    expect(src).toMatch(/step="any"/);
    expect((src.match(/min=\{0\}/g) ?? []).length).toBeGreaterThan(5);
    expect(src).not.toMatch(/type="number"[^>]*min=\{-/);
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
    expect(src).toMatch(/db\.services\.update\(s\.id!, \{ price[: }]/);
  });

  it("name edits are debounced, and a blank name never reaches the database", () => {
    expect(src).not.toMatch(/onChange=\{\(e\) => void run\(/);
    expect(src.split("onBlur=").length - 1).toBeGreaterThan(6);
    expect(src).toMatch(/if \(v && v !== s\.name\) schedule\("name"/);
    expect(src).toMatch(/if \(!v\) e\.currentTarget\.value = s\.name/);
  });
});
