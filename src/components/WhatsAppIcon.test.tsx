import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WhatsAppIcon } from "./WhatsAppIcon";

describe("WhatsAppIcon — the real logo, inline, no dependency", () => {
  it("renders the brand green field with the white phone-in-bubble glyph", () => {
    const { container } = render(<WhatsAppIcon className="size-4" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    // Same size hook as every other icon, so button spacing is unchanged.
    expect(svg!.getAttribute("class")).toBe("size-4");
    const circle = svg!.querySelector("circle");
    const path = svg!.querySelector("path");
    expect(circle?.getAttribute("fill")).toBe("#25D366");
    expect(path?.getAttribute("fill")).toBe("#FFFFFF");
    // It is a logo, not text: hidden from screen readers by default because
    // the surrounding button already carries the accessible label.
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
    expect(svg!.querySelector("title")).toBeNull();
  });

  it("can name itself when a button has no accessible label of its own", () => {
    render(<WhatsAppIcon title="WhatsApp" />);
    const img = screen.getByRole("img", { name: "WhatsApp" });
    expect(img).toBeTruthy();
    expect(img.getAttribute("aria-hidden")).toBeNull();
  });
});
