import type { Point, Rect, UiElement } from "./types.js";

export function center(rect: Rect): Point {
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  };
}

export function contains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x <= rect.x + rect.width &&
    point.y <= rect.y + rect.height
  );
}

/** The smallest element whose bounds contain the point: the most specific hit. */
export function hitTest(elements: readonly UiElement[], point: Point): UiElement | undefined {
  let best: UiElement | undefined;
  for (const element of elements) {
    if (!contains(element.rect, point)) continue;
    if (!best || area(element.rect) < area(best.rect)) best = element;
  }
  return best;
}

export function area(rect: Rect): number {
  return rect.width * rect.height;
}

export function clamp(point: Point, width: number, height: number): Point {
  return {
    x: Math.min(Math.max(Math.round(point.x), 0), width - 1),
    y: Math.min(Math.max(Math.round(point.y), 0), height - 1),
  };
}
