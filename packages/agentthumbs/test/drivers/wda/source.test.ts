import { describe, expect, it } from "vitest";
import { parseWdaSource, type WdaNode } from "../../../src/drivers/wda/index.js";

const tree: WdaNode = {
  type: "Application",
  label: "Instagram",
  rect: { x: 0, y: 0, width: 402, height: 874 },
  children: [
    { type: "StaticText", label: "New post", rect: { x: 150, y: 60, width: 100, height: 20 } },
    {
      type: "Button",
      label: null,
      name: null,
      rect: { x: 330, y: 55, width: 60, height: 30 },
      children: [{ type: "StaticText", label: "Share", rect: { x: 335, y: 60, width: 50, height: 20 } }],
    },
    { type: "TextField", label: "", value: null, placeholderValue: "Write a caption…", rect: { x: 16, y: 120, width: 370, height: 44 } },
    { type: "Icon", label: "Settings", isEnabled: "1", rect: { x: 20, y: 200, width: 64, height: 64 } },
    { type: "Button", label: "Hidden", isVisible: "0", rect: { x: 0, y: 0, width: 10, height: 10 } },
    {
      type: "Other",
      isVisible: "0",
      rect: { x: 0, y: 300, width: 402, height: 100 },
      children: [{ type: "Button", label: "Cancel", isVisible: "1", rect: { x: 300, y: 320, width: 80, height: 40 } }],
    },
    { type: "Keyboard", rect: { x: 0, y: 600, width: 402, height: 274 }, children: [{ type: "Key", label: "q", rect: { x: 0, y: 600, width: 30, height: 40 } }] },
    { type: "Other", rect: { x: 0, y: 0, width: 0, height: 0 } },
  ],
};

describe("parseWdaSource", () => {
  const elements = parseWdaSource(tree, 3);

  it("labels buttons with their text and converts points to pixels", () => {
    expect(elements.find((e) => e.label === "Share")).toMatchObject({
      role: "button",
      clickable: true,
      rect: { x: 990, y: 165, width: 180, height: 90 },
    });
  });

  it("uses placeholders for empty fields and keeps app icons", () => {
    expect(elements.find((e) => e.label === "Write a caption…")).toMatchObject({ role: "text field" });
    expect(elements.find((e) => e.label === "Settings")).toMatchObject({ role: "app icon", enabled: true });
  });

  it("keeps unclaimed text, skips hidden nodes and keyboard keys, keeps visible children of hidden containers", () => {
    expect(elements.find((e) => e.label === "New post")).toMatchObject({ clickable: false, role: "text" });
    expect(elements.map((e) => e.label)).not.toContain("Hidden");
    expect(elements.map((e) => e.label)).not.toContain("q");
    expect(elements.map((e) => e.label)).toContain("Cancel");
    expect(elements).toHaveLength(5);
  });
});
