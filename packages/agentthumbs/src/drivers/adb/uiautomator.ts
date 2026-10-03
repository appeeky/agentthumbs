import type { Rect, UiElement } from "../../core/index.js";

interface Frame {
  attrs: Record<string, string>;
  /** Text-only descendants not yet claimed by an actionable ancestor. */
  pending: UiElement[];
}

const TAG = /<node\b([^>]*?)(\/?)>|<\/node>/g;
const ATTR = /([\w-]+)="([^"]*)"/g;
const BOUNDS = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/;
const MAX_ABSORBED_LABELS = 3;

/**
 * Turns a `uiautomator dump` into the elements an agent needs: every tappable
 * or editable node, labelled with its own text or the text of its children,
 * plus standalone text that no tappable node claimed.
 */
export function parseUiAutomator(xml: string): UiElement[] {
  const output: UiElement[] = [];
  const stack: Frame[] = [{ attrs: {}, pending: [] }];

  const close = (frame: Frame) => {
    const parent = stack[stack.length - 1]!;
    const rect = parseBounds(frame.attrs.bounds);
    const own = ownLabel(frame.attrs);
    if (rect && isActionable(frame.attrs)) {
      const absorbed = frame.pending.slice(0, MAX_ABSORBED_LABELS).map((e) => e.label);
      const label = own || absorbed.join(" · ") || resourceName(frame.attrs["resource-id"]) || "";
      output.push({
        label,
        role: role(frame.attrs.class),
        rect,
        clickable: true,
        enabled: frame.attrs.enabled !== "false",
        source: "tree",
      });
      return;
    }
    parent.pending.push(...frame.pending);
    if (rect && own) {
      parent.pending.push({
        label: own,
        role: role(frame.attrs.class),
        rect,
        clickable: false,
        enabled: frame.attrs.enabled !== "false",
        source: "tree",
      });
    }
  };

  for (const match of xml.matchAll(TAG)) {
    if (match[0] === "</node>") {
      const frame = stack.pop();
      if (frame && stack.length > 0) close(frame);
      else if (frame) stack.push(frame);
      continue;
    }
    const frame: Frame = { attrs: parseAttrs(match[1] ?? ""), pending: [] };
    if (match[2] === "/") {
      close(frame);
    } else {
      stack.push(frame);
    }
  }

  while (stack.length > 1) close(stack.pop()!);
  output.push(...stack[0]!.pending);
  return output;
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const [, name, value] of source.matchAll(ATTR)) {
    if (name) attrs[name] = decodeEntities(value ?? "");
  }
  return attrs;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseBounds(bounds: string | undefined): Rect | undefined {
  const match = bounds ? BOUNDS.exec(bounds) : null;
  if (!match) return undefined;
  const [x1, y1, x2, y2] = match.slice(1).map(Number) as [number, number, number, number];
  if (x2 <= x1 || y2 <= y1) return undefined;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function ownLabel(attrs: Record<string, string>): string {
  return (attrs.text || attrs["content-desc"] || attrs.hint || "").replace(/\s+/g, " ").trim();
}

function isActionable(attrs: Record<string, string>): boolean {
  return (
    attrs.clickable === "true" ||
    attrs["long-clickable"] === "true" ||
    attrs.checkable === "true" ||
    /EditText$/.test(attrs.class ?? "")
  );
}

function role(className: string | undefined): string | undefined {
  const name = className?.split(".").pop();
  if (!name) return undefined;
  if (/EditText$/.test(name)) return "text field";
  if (/Button$/.test(name)) return "button";
  if (/Switch|CheckBox|RadioButton/.test(name)) return "toggle";
  if (/ImageView$/.test(name)) return "image";
  if (/TextView$/.test(name)) return "text";
  return undefined;
}

/** `com.zhiliaoapp.musically:id/send_button` → `send button`. */
function resourceName(id: string | undefined): string | undefined {
  const name = id?.split("/").pop();
  return name ? name.replace(/_/g, " ") : undefined;
}
