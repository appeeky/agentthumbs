import sharp from "sharp";
import type { DeviceDriver, DriverProvider, Key, Point, UiElement } from "../../src/core/index.js";

/** In-memory driver: a solid-color screen and a fixed element list. */
export class FakeDriver implements DeviceDriver {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly info = {
    id: "fake:1",
    name: "Fake Phone",
    platform: "android" as const,
    driver: "fake",
    screen: { width: 1080, height: 2400 },
  };
  readonly capabilities = {
    uiTree: true,
    listApps: false,
    openApp: false,
    pushMedia: false,
    keys: ["home", "back", "enter"] as const satisfies readonly Key[],
  };

  constructor(public elements: UiElement[] = []) {}

  async screenshot(): Promise<Buffer> {
    return sharp({
      create: { width: 1080, height: 2400, channels: 3, background: "#ffffff" },
    })
      .png()
      .toBuffer();
  }
  async tap(point: Point) {
    this.calls.push({ method: "tap", args: [point] });
  }
  async longPress(point: Point, ms: number) {
    this.calls.push({ method: "longPress", args: [point, ms] });
  }
  async swipe(from: Point, to: Point, ms: number) {
    this.calls.push({ method: "swipe", args: [from, to, ms] });
  }
  async type(text: string) {
    this.calls.push({ method: "type", args: [text] });
  }
  async key(key: Key) {
    this.calls.push({ method: "key", args: [key] });
  }
  async uiTree() {
    return this.elements;
  }
}

export function provider(driver: FakeDriver): DriverProvider {
  return { name: "fake", discover: async () => [driver] };
}

export function element(label: string, x: number, y: number, width = 200, height = 100): UiElement {
  return { label, rect: { x, y, width, height }, clickable: true, source: "tree" };
}
