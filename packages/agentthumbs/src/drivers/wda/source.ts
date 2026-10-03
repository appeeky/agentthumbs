import type { UiElement } from "../../core/index.js";

/** A node of WebDriverAgent's `GET /source?format=json` tree. Rects are in points. */
export interface WdaNode {
  type?: string;
  label?: string | null;
  name?: string | null;
  value?: string | null;
  placeholderValue?: string | null;
  rawIdentifier?: string | null;
  rect?: { x: number; y: number; width: number; height: number };
  isEnabled?: string | boolean;
  isVisible?: string | boolean;
  children?: WdaNode[];
}

const ROLES: Record<string, string> = {
  Button: "button",
  Link: "link",
  Cell: "cell",
  Icon: "app icon",
  TextField: "text field",
  SecureTextField: "password field",
  SearchField: "search field",
  TextView: "text field",
  Switch: "toggle",
  Slider: "slider",
  Stepper: "stepper",
  PickerWheel: "picker",
  MenuItem: "menu item",
  PageIndicator: "page indicator",
};

const TEXT_TYPES = new Set(["StaticText"]);
/** Keyboard keys are typed through `type`; listing each one only adds noise. */
const SKIPPED_TYPES = new Set(["Key", "Keyboard"]);
const MAX_ABSORBED_LABELS = 3;

/**
 * Turns a WebDriverAgent tree into elements in screenshot pixels: every
 * tappable or editable node, labelled with its own label or its children's
 * text, plus standalone text no tappable node claimed.
 */
export function parseWdaSource(root: WdaNode, scale: number): UiElement[] {
  const output: UiElement[] = [];

  /** Returns text-only descendants not yet claimed by an actionable ancestor. */
  const visit = (node: WdaNode): UiElement[] => {
    const type = node.type ?? "";
    if (SKIPPED_TYPES.has(type)) return [];
    const pending = (node.children ?? []).flatMap(visit);
    const rect = node.rect && toPixels(node.rect, scale);
    // WDA marks some containers invisible while their children are on screen,
    // so visibility only drops the node itself; each child is judged on its own.
    if (!rect || flag(node.isVisible) === false) return pending;

    const role = ROLES[type];
    if (role) {
      const own = ownLabel(node, role);
      const absorbed = pending.slice(0, MAX_ABSORBED_LABELS).map((e) => e.label);
      output.push({
        label: own || absorbed.join(" · ") || "",
        role,
        rect,
        clickable: true,
        enabled: flag(node.isEnabled) !== false,
        source: "tree",
      });
      return [];
    }
    if (TEXT_TYPES.has(type)) {
      const text = clean(node.label ?? node.value ?? node.name);
      if (text) return [...pending, { label: text, role: "text", rect, clickable: false, source: "tree" }];
    }
    return pending;
  };

  output.push(...visit(root));
  return output;
}

function ownLabel(node: WdaNode, role: string): string {
  const field = role.endsWith("field");
  return clean(
    node.label ||
      (field ? node.value || node.placeholderValue : undefined) ||
      node.name ||
      node.value ||
      node.rawIdentifier,
  );
}

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function flag(value: string | boolean | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === true || value === "1" || value === "true";
}

function toPixels(rect: { x: number; y: number; width: number; height: number }, scale: number) {
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  return {
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
  };
}
