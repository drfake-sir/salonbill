import { describe, expect, it } from "vitest";

import { defaultStylistIdFor, stylistNameFor, unattributedServiceLines } from "./attribution";
import type { BillLine } from "./db";

const stylists = [
  { id: 1, name: "Karthik" },
  { id: 2, name: "Priya" },
  { id: 3, name: "Arun" },
];

let seq = 0;
const line = (p: Partial<BillLine> = {}): BillLine => ({
  key: `k${++seq}`,
  kind: "service",
  refId: 1,
  name: "Men's Haircut",
  price: 300,
  qty: 1,
  gstRate: 18,
  commissionPct: 10,
  ...p,
});

describe("stylist default per login", () => {
  it("defaults a new service line to the signed-in STYLIST", () => {
    expect(defaultStylistIdFor({ role: "staff", staffId: 2, name: "Priya" })).toBe(2);
    expect(defaultStylistIdFor({ role: "staff", staffId: 3, name: "Arun" })).toBe(3);
  });

  it("gives the OWNER no default — they must choose per line", () => {
    expect(defaultStylistIdFor({ role: "owner", name: "Owner" })).toBeUndefined();
  });

  it("gives nobody (no session) no default", () => {
    expect(defaultStylistIdFor(null)).toBeUndefined();
  });

  it("REGRESSION: never falls back to the first stylist in the list", () => {
    // The original bug: `stylists[0]?.id` billed every service to Karthik
    // regardless of who was signed in. defaultStylistIdFor must not be able
    // to see the stylist list at all — it only knows the session.
    const priya = defaultStylistIdFor({ role: "staff", staffId: 2, name: "Priya" });
    const arun = defaultStylistIdFor({ role: "staff", staffId: 3, name: "Arun" });
    expect(priya).not.toBe(1);
    expect(arun).not.toBe(1);
    expect(priya).not.toBe(arun);
  });
});

describe("multi-stylist bills", () => {
  it("keeps each line's own stylist — a bill can name three", () => {
    const lines = [
      line({ stylistId: 1, stylistName: "Karthik" }),
      line({ stylistId: 2, stylistName: "Priya" }),
      line({ stylistId: 3, stylistName: "Arun" }),
    ];
    expect(lines.map((l) => stylistNameFor(stylists, l))).toEqual(["Karthik", "Priya", "Arun"]);
  });

  it("a line can be reassigned to another stylist before saving", () => {
    const l = line({ stylistId: 1, stylistName: "Karthik" });
    const reassigned = {
      ...l,
      stylistId: 3,
      stylistName: stylistNameFor(stylists, { ...l, stylistId: 3 }),
    };
    expect(stylistNameFor(stylists, l)).toBe("Karthik");
    expect(stylistNameFor(stylists, reassigned)).toBe("Arun");
  });

  it("resolves the name from the CURRENT stylist list, not a stale snapshot", () => {
    const l = line({ stylistId: 2 });
    expect(stylistNameFor(stylists, l)).toBe("Priya");
    // Renamed stylist: the id still resolves to the new name.
    expect(stylistNameFor([{ id: 2, name: "Priya K" }], l)).toBe("Priya K");
  });
});

describe("owner must attribute every service line", () => {
  it("finds the service lines with no stylist", () => {
    const lines = [
      line({ stylistId: 1 }),
      line({ name: "Blow Dry" }), // no stylist
      line({ kind: "product", refId: 9, name: "Shampoo", stylistId: undefined }),
      line({ name: "Root Touch-up", stylistId: undefined }),
    ];
    const un = unattributedServiceLines(lines);
    expect(un.map((l) => l.name)).toEqual(["Blow Dry", "Root Touch-up"]);
  });

  it("is clear once every service line is attributed", () => {
    expect(unattributedServiceLines([line({ stylistId: 1 }), line({ stylistId: 2 })])).toEqual([]);
  });

  it("ignores product lines, which are never stylist work", () => {
    expect(
      unattributedServiceLines([line({ kind: "product", refId: 9, name: "Shampoo" })]),
    ).toEqual([]);
  });
});

describe("stylistNameFor never invents a name", () => {
  it("leaves an unattributed service line nameless", () => {
    expect(stylistNameFor(stylists, line({ stylistId: undefined }))).toBeUndefined();
  });

  it("keeps a legacy line's stored name when it has no id", () => {
    // Bills saved before stylist ids existed stored only the name; those rows
    // must keep showing it rather than blanking out.
    const legacy = line({ stylistId: undefined, stylistName: "Karthik" });
    expect(stylistNameFor(stylists, legacy)).toBe("Karthik");
  });

  it("returns undefined for a deleted stylist id instead of guessing", () => {
    const orphan = line({ stylistId: 99 });
    expect(stylistNameFor(stylists, orphan)).toBeUndefined();
  });

  it("never attributes a product line to anyone", () => {
    const p = line({ kind: "product", refId: 9, stylistId: 1 });
    expect(stylistNameFor(stylists, p)).toBeUndefined();
  });
});
