import { area, center, clamp, hitTest } from "./geometry.js";
import {
  renderObservation,
  screenSignature,
  signatureDistance,
  type RenderOptions,
  type RenderedImage,
} from "./image.js";
import {
  DEFAULT_POLICY,
  matchApprovalWord,
  PolicyError,
  RateLimiter,
  type Approver,
  type PolicyConfig,
} from "./policy.js";
import type {
  AppInfo,
  DeviceDriver,
  DeviceInfo,
  DriverProvider,
  ElementSource,
  Key,
  Point,
  Rect,
  UiElement,
} from "./types.js";

/** Where to act: an element id from the last observation, or x/y in observation image pixels. */
export type Target = { element: number } | { x: number; y: number };

export type Direction = "up" | "down" | "left" | "right";

export interface ObservedElement {
  id: number;
  label: string;
  role?: string;
  clickable?: boolean;
  /** Center in observation image pixels. */
  x: number;
  y: number;
}

export interface Observation {
  device: DeviceInfo;
  image: RenderedImage;
  elements: ObservedElement[];
  takenAt: string;
}

export interface ActionResult {
  action: string;
  observation?: Observation;
}

export interface ActionOptions {
  /** Return a fresh observation once the screen settles. Defaults to true. */
  observe?: boolean;
}

export interface SettleOptions {
  /** Wait at least this long after an action before sampling the screen. */
  initialDelayMs: number;
  timeoutMs: number;
  /** Signature distance below which two frames count as the same. */
  threshold: number;
}

export interface ActionLogEntry {
  at: string;
  device: string;
  action: string;
  detail?: Record<string, unknown>;
}

export interface AgentThumbsOptions {
  providers: DriverProvider[];
  /** Used for drivers without a UI tree, for example OCR. */
  elementSource?: ElementSource;
  policy?: Partial<PolicyConfig>;
  /** Asks a human. Without one, actions that need approval are refused. */
  approver?: Approver;
  render?: Partial<RenderOptions>;
  settle?: Partial<SettleOptions>;
  onAction?: (entry: ActionLogEntry) => void;
}

const DEFAULT_RENDER: RenderOptions = { maxEdge: 1280, format: "jpeg", marks: true };
const DEFAULT_SETTLE: SettleOptions = { initialDelayMs: 250, timeoutMs: 3000, threshold: 1.5 };
const MAX_ELEMENTS = 150;
/** Containers bigger than this share of the screen are layout, not targets. */
const MAX_ELEMENT_SCREEN_SHARE = 0.7;

export class AgentThumbs {
  private readonly sessions = new Map<string, DeviceSession>();
  private readonly policy: PolicyConfig;
  private readonly render: RenderOptions;
  private readonly settle: SettleOptions;

  constructor(private readonly options: AgentThumbsOptions) {
    this.policy = { ...DEFAULT_POLICY, ...options.policy };
    this.render = { ...DEFAULT_RENDER, ...options.render };
    this.settle = { ...DEFAULT_SETTLE, ...options.settle };
  }

  /** Discovers devices on every provider. Sessions for devices that stay connected are kept. */
  async devices(): Promise<DeviceInfo[]> {
    const found = (await Promise.all(this.options.providers.map((p) => p.discover()))).flat();
    const seen = new Set<string>();
    for (const driver of found) {
      seen.add(driver.info.id);
      if (!this.sessions.has(driver.info.id)) {
        this.sessions.set(
          driver.info.id,
          new DeviceSession(driver, {
            policy: this.policy,
            render: this.render,
            settle: this.settle,
            limiter: new RateLimiter(this.policy),
            elementSource: this.options.elementSource,
            approver: this.options.approver,
            onAction: this.options.onAction,
          }),
        );
      }
    }
    for (const id of this.sessions.keys()) if (!seen.has(id)) this.sessions.delete(id);
    return [...this.sessions.values()].map((s) => s.info);
  }

  /** Setup problems reported by providers, for when a device is missing. */
  async diagnose(): Promise<string[]> {
    const results = await Promise.all(this.options.providers.map((p) => p.diagnose?.() ?? []));
    return results.flat();
  }

  /** The session for a device. Without an id, the only connected device. */
  async device(id?: string): Promise<DeviceSession> {
    if (id && this.sessions.has(id)) return this.sessions.get(id)!;
    const devices = await this.devices();
    if (id) {
      const session = this.sessions.get(id);
      if (!session) throw new Error(`No device with id "${id}". Connected: ${list(devices)}`);
      return session;
    }
    if (devices.length === 0) throw new Error("No devices connected.");
    if (devices.length > 1) {
      throw new Error(`Several devices are connected, pass a device id: ${list(devices)}`);
    }
    return this.sessions.get(devices[0]!.id)!;
  }
}

function list(devices: DeviceInfo[]): string {
  return devices.length === 0 ? "none" : devices.map((d) => `${d.id} (${d.name})`).join(", ");
}

interface SessionConfig {
  policy: PolicyConfig;
  render: RenderOptions;
  settle: SettleOptions;
  limiter: RateLimiter;
  elementSource: ElementSource | undefined;
  approver: Approver | undefined;
  onAction: ((entry: ActionLogEntry) => void) | undefined;
}

/** Element ids and scale from the last observation, so targets can be resolved. */
export interface ObservationState {
  scale: number;
  elements: UiElement[];
  /** Actions performed since this observation was taken. */
  stale: boolean;
}

export class DeviceSession {
  private state: ObservationState | undefined;
  private lastImage: RenderedImage | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly driver: DeviceDriver,
    private readonly config: SessionConfig,
  ) {}

  get info(): DeviceInfo {
    return this.driver.info;
  }

  get capabilities() {
    return this.driver.capabilities;
  }

  /** Lets stateless callers (the CLI) resolve element ids across processes. */
  exportState(): ObservationState | undefined {
    return this.state;
  }

  importState(state: ObservationState): void {
    this.state = state;
  }

  observe(): Promise<Observation> {
    return this.exclusive(() => this.observeNow());
  }

  /**
   * A cheap scaled screenshot with no element detection, for a live mirror.
   * Sets the coordinate scale so a following `tap({x,y})` in this image's
   * pixels lands correctly, but marks no elements (so element-id targets and
   * approval-label lookup are unavailable until the next `observe`).
   */
  frame(maxEdge?: number): Promise<RenderedImage> {
    return this.exclusive(async () => {
      const png = await this.driver.screenshot();
      const render = maxEdge ? { ...this.config.render, marks: false, maxEdge } : { ...this.config.render, marks: false };
      const image = await renderObservation(png, [], render);
      this.state = { scale: image.scale, elements: [], stale: false };
      this.lastImage = image;
      return image;
    });
  }

  tap(target: Target, options?: ActionOptions): Promise<ActionResult> {
    return this.act("tap", options, async () => {
      const { point, label } = this.resolve(target);
      await this.approveTap("tap", label);
      await this.driver.tap(point);
      return { target, label };
    });
  }

  /**
   * Taps a point in native device pixels, bypassing element resolution and the
   * approval gate — for direct human control (a mirror the user clicks), where
   * the person is the one acting. Not for agents.
   */
  tapNative(point: Point, options?: ActionOptions): Promise<ActionResult> {
    return this.act("tap", options, async () => {
      await this.driver.tap(clamp(point, this.driver.info.screen.width, this.driver.info.screen.height));
      return { point };
    });
  }

  /** Swipes between two points in native device pixels, for direct human control. */
  swipeNative(from: Point, to: Point, durationMs = 300, options?: ActionOptions): Promise<ActionResult> {
    return this.act("swipe", options, async () => {
      const { width, height } = this.driver.info.screen;
      await this.driver.swipe(clamp(from, width, height), clamp(to, width, height), durationMs);
      return { from, to, durationMs };
    });
  }

  longPress(target: Target, durationMs = 800, options?: ActionOptions): Promise<ActionResult> {
    return this.act("long_press", options, async () => {
      const { point, label } = this.resolve(target);
      await this.approveTap("long_press", label);
      await this.driver.longPress(point, durationMs);
      return { target, label, durationMs };
    });
  }

  swipe(from: Target, to: Target, durationMs = 300, options?: ActionOptions): Promise<ActionResult> {
    return this.act("swipe", options, async () => {
      await this.driver.swipe(this.resolve(from).point, this.resolve(to).point, durationMs);
      return { from, to, durationMs };
    });
  }

  /**
   * Scrolls content the way a reader thinks about it: "down" reveals what is
   * below, so the finger moves up.
   */
  scroll(direction: Direction, amount = 0.5, options?: ActionOptions): Promise<ActionResult> {
    return this.act("scroll", options, async () => {
      const { width, height } = this.driver.info.screen;
      const mid = { x: width / 2, y: height / 2 };
      const dx = (direction === "right" ? 1 : direction === "left" ? -1 : 0) * width * amount * 0.5;
      const dy = (direction === "down" ? 1 : direction === "up" ? -1 : 0) * height * amount * 0.5;
      const from = clamp({ x: mid.x + dx, y: mid.y + dy }, width, height);
      const to = clamp({ x: mid.x - dx, y: mid.y - dy }, width, height);
      await this.driver.swipe(from, to, 350);
      return { direction, amount };
    });
  }

  type(text: string, options?: ActionOptions): Promise<ActionResult> {
    return this.act("type", options, async () => {
      await this.driver.type(text);
      return { length: text.length };
    });
  }

  key(key: Key, options?: ActionOptions): Promise<ActionResult> {
    return this.act("key", options, async () => {
      if (!this.driver.capabilities.keys.includes(key)) {
        throw new Error(
          `${this.driver.info.driver} does not support the "${key}" key. Supported: ${this.driver.capabilities.keys.join(", ")}`,
        );
      }
      await this.driver.key(key);
      return { key };
    });
  }

  openApp(appId: string, options?: ActionOptions): Promise<ActionResult> {
    return this.act("open_app", options, async () => {
      if (!this.driver.openApp) throw new Error(`${this.driver.info.driver} cannot open apps directly.`);
      await this.driver.openApp(appId);
      return { appId };
    });
  }

  listApps(): Promise<AppInfo[]> {
    return this.exclusive(async () => {
      if (!this.driver.listApps) throw new Error(`${this.driver.info.driver} cannot list apps.`);
      return this.driver.listApps();
    });
  }

  pushMedia(localPath: string): Promise<string> {
    return this.exclusive(async () => {
      if (!this.driver.pushMedia) throw new Error(`${this.driver.info.driver} cannot push media.`);
      this.config.limiter.check();
      const remote = await this.driver.pushMedia(localPath);
      this.config.limiter.record();
      this.log("push_media", { localPath, remote });
      return remote;
    });
  }

  private async act(
    action: string,
    options: ActionOptions | undefined,
    run: () => Promise<Record<string, unknown>>,
  ): Promise<ActionResult> {
    return this.exclusive(async () => {
      this.config.limiter.check();
      const detail = await run();
      this.config.limiter.record();
      if (this.state) this.state.stale = true;
      this.log(action, detail);
      if (options?.observe === false) return { action };
      return { action, observation: await this.observeNow(true) };
    });
  }

  private async observeNow(afterAction = false): Promise<Observation> {
    const png = afterAction ? await this.waitForStable() : await this.driver.screenshot();
    const elements = normalizeElements(await this.detectElements(png), this.driver.info.screen);
    const image = await renderObservation(png, elements, this.config.render);
    this.state = { scale: image.scale, elements, stale: false };
    this.lastImage = image;
    return {
      device: this.driver.info,
      image,
      elements: elements.map((element, index) => {
        const c = center(element.rect);
        return {
          id: index + 1,
          label: element.label,
          ...(element.role ? { role: element.role } : {}),
          ...(element.clickable !== undefined ? { clickable: element.clickable } : {}),
          x: Math.round(c.x / image.scale),
          y: Math.round(c.y / image.scale),
        };
      }),
      takenAt: new Date().toISOString(),
    };
  }

  private async detectElements(png: Buffer): Promise<UiElement[]> {
    if (this.driver.capabilities.uiTree && this.driver.uiTree) {
      try {
        return await this.driver.uiTree();
      } catch {
        // Trees are flaky while the screen animates; fall through to pixels.
      }
    }
    return this.config.elementSource ? this.config.elementSource.detect(png) : [];
  }

  /** Samples the screen until two frames match or the timeout passes. Returns the last frame. */
  private async waitForStable(): Promise<Buffer> {
    const { initialDelayMs, timeoutMs, threshold } = this.config.settle;
    await sleep(initialDelayMs);
    const deadline = Date.now() + timeoutMs;
    let png = await this.driver.screenshot();
    let signature = await screenSignature(png);
    while (Date.now() < deadline) {
      const next = await this.driver.screenshot();
      const nextSignature = await screenSignature(next);
      const distance = signatureDistance(signature, nextSignature);
      png = next;
      signature = nextSignature;
      if (distance < threshold) break;
    }
    return png;
  }

  private resolve(target: Target): { point: Point; label: string | undefined } {
    const { width, height } = this.driver.info.screen;
    if ("element" in target) {
      const state = this.state;
      if (!state) throw new Error("Observe the screen before targeting an element by id.");
      if (state.stale) {
        throw new Error("The screen changed since the last observation. Observe again before targeting elements by id.");
      }
      const element = state.elements[target.element - 1];
      if (!element) {
        throw new Error(`No element ${target.element}. The last observation has ${state.elements.length}.`);
      }
      return { point: center(element.rect), label: element.label };
    }
    const scale = this.state?.scale ?? 1;
    const point = clamp({ x: target.x * scale, y: target.y * scale }, width, height);
    const hit = this.state && !this.state.stale ? hitTest(this.state.elements, point) : undefined;
    return { point, label: hit?.label };
  }

  private async approveTap(action: string, label: string | undefined): Promise<void> {
    const { policy, approver } = this.config;
    if (!policy.requireApproval) return;
    const word = matchApprovalWord(label, policy.approvalWords);
    const unlabeled = label === undefined && policy.approveUnlabeledTaps;
    if (!word && !unlabeled) return;

    const reason = word
      ? `Tapping "${label}" may publish, send or pay for something.`
      : "Tapping a point that is not on any known element.";
    if (!approver) {
      throw new PolicyError(
        "APPROVAL_UNAVAILABLE",
        `${reason} This needs a human's approval and no approver is configured.`,
      );
    }
    const approved = await approver({
      device: this.driver.info,
      action,
      label,
      reason,
      ...(this.lastImage ? { screenshot: this.lastImage.data } : {}),
    });
    this.log("approval", { action, label, approved });
    if (!approved) throw new PolicyError("APPROVAL_DENIED", `A human declined: ${reason}`);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private log(action: string, detail?: Record<string, unknown>): void {
    this.config.onAction?.({
      at: new Date().toISOString(),
      device: this.driver.info.id,
      action,
      ...(detail ? { detail } : {}),
    });
  }
}

/**
 * Drops invisible elements, screen-sized containers and duplicates, then
 * numbers the rest top-to-bottom, left-to-right.
 */
function normalizeElements(elements: UiElement[], screen: { width: number; height: number }): UiElement[] {
  const screenArea = screen.width * screen.height;
  const kept: UiElement[] = [];
  for (const e of elements) {
    const visible =
      e.rect.width > 2 &&
      e.rect.height > 2 &&
      e.rect.x < screen.width &&
      e.rect.y < screen.height &&
      e.rect.x + e.rect.width > 0 &&
      e.rect.y + e.rect.height > 0;
    if (!visible || area(e.rect) > screenArea * MAX_ELEMENT_SCREEN_SHARE) continue;
    const duplicate = kept.findIndex((k) => sameRect(k.rect, e.rect));
    if (duplicate === -1) kept.push(e);
    else if (!kept[duplicate]!.label && e.label) kept[duplicate] = e;
  }
  return kept.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x).slice(0, MAX_ELEMENTS);
}

function sameRect(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) <= 4 &&
    Math.abs(a.y - b.y) <= 4 &&
    Math.abs(a.width - b.width) <= 4 &&
    Math.abs(a.height - b.height) <= 4
  );
}

/** A compact, model-friendly description to send next to the screenshot. */
export function describeObservation(observation: Observation): string {
  const { device, image, elements } = observation;
  const lines = [
    `${device.name} (${device.id}), screenshot ${image.width}x${image.height}.`,
    elements.length > 0
      ? "Tap by element id, or by x,y in screenshot pixels. Numbered boxes on the image match these ids:"
      : "No elements detected. Tap by x,y in screenshot pixels.",
  ];
  for (const e of elements) {
    const flags = [e.role, e.clickable ? "clickable" : undefined].filter(Boolean).join(", ");
    lines.push(`[${e.id}] ${JSON.stringify(e.label)}${flags ? ` (${flags})` : ""} at ${e.x},${e.y}`);
  }
  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
