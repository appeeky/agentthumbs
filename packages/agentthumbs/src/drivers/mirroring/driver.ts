import type {
  DeviceDriver,
  DeviceInfo,
  DriverCapabilities,
  DriverProvider,
  ElementSource,
  Key,
  Point,
  UiElement,
} from "../../core/index.js";
import { sharedHelper, type MirroringHelper } from "./helper.js";

interface Status {
  running: boolean;
  window: { x: number; y: number; width: number; height: number } | null;
  permissions: { screenRecording: boolean; accessibility: boolean };
}

interface Screenshot {
  png: string;
  width: number;
  height: number;
}

interface OcrElement {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const KEYS = ["home", "app_switch", "enter", "delete"] as const satisfies readonly Key[];

/**
 * Drives the iPhone shown in the macOS iPhone Mirroring window. The Mac's
 * pointer and keyboard stand in for a finger, so nothing runs on the iPhone.
 * The pointer is moved for each action and put back afterwards.
 */
export class MirroringDriver implements DeviceDriver {
  readonly capabilities: DriverCapabilities = {
    uiTree: false,
    listApps: false,
    openApp: true,
    pushMedia: false,
    keys: KEYS,
  };

  constructor(
    private readonly helper: MirroringHelper,
    readonly info: DeviceInfo,
  ) {}

  async screenshot(): Promise<Buffer> {
    const shot = await this.helper.request<Screenshot & Record<string, unknown>>("screenshot");
    // The window can be resized; keep the reported screen in step with what we capture.
    this.info.screen = { width: shot.width, height: shot.height };
    return Buffer.from(shot.png, "base64");
  }

  async tap({ x, y }: Point): Promise<void> {
    await this.helper.request("tap", { x, y });
  }

  async longPress({ x, y }: Point, durationMs: number): Promise<void> {
    await this.helper.request("long_press", { x, y, ms: durationMs });
  }

  async swipe(from: Point, to: Point, durationMs: number): Promise<void> {
    await this.helper.request("swipe", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, ms: durationMs });
  }

  async type(text: string): Promise<void> {
    await this.helper.request("type", { text }, 120_000);
  }

  async key(key: Key): Promise<void> {
    await this.helper.request("key", { key });
  }

  /** iOS has no launch-by-id from the Mac, so this searches Spotlight for the app's name. */
  async openApp(appName: string): Promise<void> {
    await this.helper.request("key", { key: "spotlight" });
    await sleep(500);
    await this.helper.request("type", { text: appName });
    await sleep(700);
    await this.helper.request("key", { key: "enter" });
  }
}

/** Finds the iPhone in an open iPhone Mirroring window. */
export class MirroringProvider implements DriverProvider {
  readonly name = "mirroring";
  private driver: MirroringDriver | undefined;

  constructor(private readonly helper: MirroringHelper = sharedHelper()) {}

  async discover(): Promise<DeviceDriver[]> {
    if (!this.helper.available) return [];
    const status = await this.status();
    if (!status?.window || !status.permissions.screenRecording) return [];
    if (!this.driver) {
      this.driver = new MirroringDriver(this.helper, {
        id: "mirroring:iphone",
        name: "iPhone (iPhone Mirroring)",
        platform: "ios",
        driver: "mirroring",
        screen: { width: 0, height: 0 },
      });
      // Learn the real pixel size before anyone resolves coordinates.
      await this.driver.screenshot();
    }
    return [this.driver];
  }

  async diagnose(): Promise<string[]> {
    if (process.platform !== "darwin") return [];
    if (!this.helper.available) return ["iPhone Mirroring: the helper binary is missing; run `npm run build:helper`."];
    const status = await this.status();
    if (!status) return ["iPhone Mirroring: the helper could not start."];
    const problems: string[] = [];
    if (!status.permissions.screenRecording) {
      problems.push(
        "iPhone Mirroring: allow Screen Recording for the app running agentthumbs (System Settings > Privacy & Security).",
      );
    }
    if (!status.permissions.accessibility) {
      problems.push(
        "iPhone Mirroring: allow Accessibility for the app running agentthumbs (System Settings > Privacy & Security).",
      );
    }
    if (!status.window) problems.push("iPhone Mirroring: open the iPhone Mirroring app and connect to your iPhone.");
    return problems;
  }

  private async status(): Promise<Status | undefined> {
    try {
      return await this.helper.request<Status & Record<string, unknown>>("status", {}, 10_000);
    } catch {
      return undefined;
    }
  }
}

/** Apple Vision text recognition, on the Mac, for drivers without a UI tree. */
export class VisionOcrSource implements ElementSource {
  readonly name = "vision-ocr";

  constructor(private readonly helper: MirroringHelper = sharedHelper()) {}

  get available(): boolean {
    return this.helper.available;
  }

  async detect(png: Buffer): Promise<UiElement[]> {
    const { elements } = await this.helper.request<{ elements: OcrElement[] }>("ocr", {
      png: png.toString("base64"),
    });
    return elements.map((e) => ({
      label: e.label,
      role: "text",
      rect: { x: e.x, y: e.y, width: e.width, height: e.height },
      source: "ocr" as const,
    }));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
