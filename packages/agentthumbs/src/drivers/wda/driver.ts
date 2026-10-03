import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AppInfo,
  DeviceDriver,
  DeviceInfo,
  DriverCapabilities,
  DriverProvider,
  Key,
  Point,
  UiElement,
} from "../../core/index.js";
import { parseWdaSource, type WdaNode } from "./source.js";
import { discoverIosDevices, findSigningTeams, NoSigningTeamError, pickTeam } from "./ios-setup.js";
import { WdaRunner } from "./wda-runner.js";

/** Attributes that are slow to compute and not needed for targeting. */
const EXCLUDED_ATTRIBUTES = "accessible,frame,nativeFrame,traits,customActions,minValue,maxValue";

const KEYS = ["home", "enter", "delete", "lock", "volume_up", "volume_down"] as const satisfies readonly Key[];

interface WdaResponse<T> {
  value: T;
  sessionId?: string;
}

class WdaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Minimal WebDriverAgent HTTP client that keeps one session alive. */
export class WdaClient {
  private sessionId: string | undefined;

  constructor(readonly baseUrl: string) {}

  async get<T>(path: string, timeoutMs = 30_000): Promise<T> {
    return this.call<T>("GET", path, undefined, timeoutMs);
  }

  async post<T>(path: string, body: unknown = {}, timeoutMs = 60_000): Promise<T> {
    return this.call<T>("POST", path, body, timeoutMs);
  }

  /** Runs a session-scoped command, opening or reopening the session as needed. */
  async session<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = this.sessionId ?? (await this.openSession());
      try {
        return await this.call<T>(method, `/session/${id}${path}`, body, timeoutMs);
      } catch (error) {
        const stale = error instanceof WdaError && error.status === 404 && /session/i.test(error.message);
        if (!stale || attempt > 0) throw error;
        this.sessionId = undefined;
      }
    }
    throw new Error("unreachable");
  }

  private async openSession(): Promise<string> {
    const response = await this.call<{ sessionId?: string }>("POST", "/session", {
      capabilities: { alwaysMatch: { "appium:shouldWaitForQuiescence": false } },
    }, 60_000);
    const id = response.sessionId;
    if (!id) throw new Error("WebDriverAgent did not return a session id.");
    this.sessionId = id;
    return id;
  }

  private async call<T>(method: string, path: string, body: unknown, timeoutMs: number): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`WebDriverAgent is not reachable at ${this.baseUrl}: ${(error as Error).message}`);
    }
    const payload = (await response.json().catch(() => ({}))) as WdaResponse<T & { error?: string; message?: string }>;
    if (!response.ok || payload.value?.error) {
      const message = payload.value?.message ?? payload.value?.error ?? `HTTP ${response.status}`;
      throw new WdaError(`WebDriverAgent ${method} ${path}: ${message}`, response.status);
    }
    // Session creation returns the id at the top level or inside value.
    if (path === "/session") {
      return { sessionId: payload.sessionId ?? (payload.value as { sessionId?: string }).sessionId } as T;
    }
    return payload.value;
  }
}

/**
 * Drives an iPhone through WebDriverAgent running on it (developer devices).
 * WDA works in points; the runtime works in screenshot pixels, so every
 * coordinate is divided by the screen scale on the way in.
 */
export class WdaDriver implements DeviceDriver {
  readonly capabilities: DriverCapabilities = {
    uiTree: true,
    listApps: true,
    openApp: true,
    pushMedia: false,
    keys: KEYS,
  };

  /** Screenshot pixels per WDA point. Measured from real screenshots, since WDA may downscale them. */
  private pixelsPerPoint: number;

  constructor(
    private readonly client: WdaClient,
    readonly info: DeviceInfo,
    private readonly pointSize: { width: number; height: number },
    screenScale: number,
    private readonly udid: string | undefined,
    /** Visibility costs ~3 s per tree on a real device but hides elements covered by sheets and overlays. */
    private readonly checkVisibility: boolean,
  ) {
    this.pixelsPerPoint = screenScale;
  }

  async screenshot(): Promise<Buffer> {
    const png = Buffer.from(await this.client.get<string>("/screenshot"), "base64");
    const size = pngSize(png);
    if (size) {
      this.pixelsPerPoint = size.width / this.pointSize.width;
      this.info.screen = size;
    }
    return png;
  }

  async tap(point: Point): Promise<void> {
    await this.client.session("POST", "/wda/tap", this.toPoints(point));
  }

  async longPress(point: Point, durationMs: number): Promise<void> {
    await this.client.session("POST", "/wda/touchAndHold", { ...this.toPoints(point), duration: durationMs / 1000 });
  }

  async swipe(from: Point, to: Point, durationMs: number): Promise<void> {
    const start = this.toPoints(from);
    const end = this.toPoints(to);
    // W3C actions give a real flick; dragfromtoforduration long-presses first.
    await this.client.session("POST", "/actions", {
      actions: [
        {
          type: "pointer",
          id: "finger",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: start.x, y: start.y },
            { type: "pointerDown", button: 0 },
            { type: "pointerMove", duration: durationMs, x: end.x, y: end.y },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
  }

  async type(text: string): Promise<void> {
    await this.client.session("POST", "/wda/keys", { value: [...text] }, 120_000);
  }

  async key(key: Key): Promise<void> {
    switch (key) {
      case "home":
        await this.client.post("/wda/homescreen");
        return;
      case "enter":
        await this.type("\n");
        return;
      case "delete":
        await this.type("\b");
        return;
      case "lock":
        await this.client.post("/wda/lock");
        return;
      case "volume_up":
      case "volume_down":
        await this.client.session("POST", "/wda/pressButton", {
          name: key === "volume_up" ? "volumeUp" : "volumeDown",
        });
        return;
      default:
        throw new Error(`WebDriverAgent has no "${key}" key.`);
    }
  }

  async uiTree(): Promise<UiElement[]> {
    const excluded = this.checkVisibility ? EXCLUDED_ATTRIBUTES : `visible,${EXCLUDED_ATTRIBUTES}`;
    const tree = await this.client.get<WdaNode>(`/source?format=json&excluded_attributes=${excluded}`);
    return parseWdaSource(tree, this.pixelsPerPoint);
  }

  async openApp(bundleId: string): Promise<void> {
    await this.client.session("POST", "/wda/apps/launch", { bundleId });
  }

  /** WDA cannot list apps; Xcode's devicectl can, when the device's UDID is known. */
  async listApps(): Promise<AppInfo[]> {
    if (!this.udid) throw new Error("Listing apps needs the device UDID (AGENTTHUMBS_WDA_UDID).");
    const dir = await mkdtemp(join(tmpdir(), "agentthumbs-"));
    const out = join(dir, "apps.json");
    try {
      await run("xcrun", ["devicectl", "device", "info", "apps", "--device", this.udid, "--json-output", out]);
      const json = JSON.parse(await readFile(out, "utf8")) as {
        result?: { apps?: Array<{ bundleIdentifier?: string; name?: string; builtByDeveloper?: boolean }> };
      };
      return (json.result?.apps ?? [])
        .filter((app) => app.bundleIdentifier)
        .map((app) => ({ id: app.bundleIdentifier!, name: app.name ?? app.bundleIdentifier! }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private toPoints({ x, y }: Point): Point {
    return { x: x / this.pixelsPerPoint, y: y / this.pixelsPerPoint };
  }
}

export interface WdaProviderOptions {
  /** WDA base URLs, typically forwarded with `iproxy 8100 8100`. */
  urls?: string[];
  /**
   * Device UDID. With `urls`, it is used for listing apps through devicectl.
   * With `autoStart`, only this iPhone is started.
   */
  udid?: string;
  /** Drop elements hidden behind sheets and overlays. Slower; on by default. */
  checkVisibility?: boolean;
  /**
   * Build WebDriverAgent and start it on every connected, ready iPhone, each on
   * its own local port, unless a WebDriverAgent is already reachable at `urls`.
   * Off unless set here or via AGENTTHUMBS_WDA_AUTOSTART=1.
   */
  autoStart?: boolean;
  /** Preferred signing team id or name. Falls back to AGENTTHUMBS_IOS_TEAM, then the newest cert. */
  team?: string;
  /** First local port to forward WDA to when auto-starting; each further iPhone takes the next free one. */
  autoStartPort?: number;
  onLog?: (line: string) => void;
}

/** How often auto-start looks for newly plugged-in iPhones. */
const RESCAN_INTERVAL_MS = 30_000;

interface ManagedDevice {
  udid: string;
  name: string;
  runner: WdaRunner;
}

/** Finds iPhones with a reachable WebDriverAgent. */
export class WdaProvider implements DriverProvider {
  readonly name = "wda";
  private readonly urls: string[];
  private readonly udid: string | undefined;
  private readonly checkVisibility: boolean;
  private readonly autoStart: boolean;
  private readonly team: string | undefined;
  private readonly autoStartPort: number;
  private readonly onLog: (line: string) => void;
  private readonly drivers = new Map<string, WdaDriver>();
  /** Auto-started WebDriverAgents by base URL. */
  private readonly managed = new Map<string, ManagedDevice>();
  /** Decided on the first discovery: someone else runs WebDriverAgent at `urls`, so never auto-start. */
  private external: boolean | undefined;
  private starting: Promise<void> | undefined;
  private lastScan = 0;

  constructor(options: WdaProviderOptions = {}) {
    this.autoStartPort = options.autoStartPort ?? 8100;
    this.urls =
      options.urls ??
      (process.env.AGENTTHUMBS_WDA_URLS ?? `http://127.0.0.1:${this.autoStartPort}`)
        .split(",")
        .map((u) => u.trim().replace(/\/$/, ""));
    this.udid = options.udid ?? process.env.AGENTTHUMBS_WDA_UDID;
    this.checkVisibility = options.checkVisibility ?? process.env.AGENTTHUMBS_WDA_FAST !== "1";
    this.autoStart = options.autoStart ?? process.env.AGENTTHUMBS_WDA_AUTOSTART === "1";
    this.team = options.team;
    this.onLog = options.onLog ?? (() => undefined);
  }

  async discover(): Promise<DeviceDriver[]> {
    if (this.autoStart) {
      if (this.external === undefined) this.external = (await this.connectAll(this.urls)).length > 0;
      if (!this.external) await this.ensureStarted();
    }
    return this.connectAll([...new Set([...this.urls, ...this.managed.keys()])]);
  }

  async diagnose(): Promise<string[]> {
    if ((await this.discover()).length > 0) return [];
    if (!this.autoStart) {
      return [
        `iOS: no WebDriverAgent at ${this.urls.join(", ")}. Run \`agentthumbs ios setup\` (see docs/platforms/ios-wda.mdx).`,
      ];
    }
    // Auto-start is on but produced nothing: surface why (no device, dev mode off, no team).
    const devices = await discoverIosDevices();
    if (devices.length === 0) return ["iOS: no iPhone found. Connect one with a cable and unlock it."];
    const blocked = devices.filter((d) => d.blocker).map((d) => `iOS: ${d.name}: ${d.blocker}`);
    if (blocked.length > 0) return blocked;
    if ((await findSigningTeams()).length === 0) return [new NoSigningTeamError().message];
    return ["iOS: WebDriverAgent could not start. See the agentthumbs logs."];
  }

  /** Stops every auto-started WebDriverAgent. */
  stop(): void {
    for (const device of this.managed.values()) device.runner.stop();
    this.managed.clear();
    this.starting = undefined;
    this.lastScan = 0;
  }

  /** Starts WebDriverAgent on ready iPhones that have none, one at a time, at most every RESCAN_INTERVAL_MS. */
  private ensureStarted(): Promise<void> {
    if (!this.starting && (this.managed.size === 0 || Date.now() - this.lastScan >= RESCAN_INTERVAL_MS)) {
      this.lastScan = Date.now();
      this.starting = this.startReadyDevices().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting ?? Promise.resolve();
  }

  private async startReadyDevices(): Promise<void> {
    await this.dropDeadRunners();
    const running = new Set([...this.managed.values()].map((d) => d.udid));
    const devices = await discoverIosDevices();
    const candidates = devices.filter((d) => (this.udid ? d.udid === this.udid : true) && !running.has(d.udid));
    const ready = candidates.filter((d) => !d.blocker);
    if (ready.length === 0) {
      if (this.managed.size === 0) {
        const reason = this.udid
          ? `Device ${this.udid} is not ready.`
          : candidates[0]?.blocker ?? "No connected iPhone with Developer Mode on.";
        this.onLog(`iOS auto-start skipped: ${reason}`);
      }
      return;
    }

    const team = pickTeam(await findSigningTeams(), this.team);
    for (const device of ready) {
      const port = await this.freePort();
      const runner = new WdaRunner({
        udid: device.udid,
        teamId: team.id,
        port,
        onLog: (line) => this.onLog(`${device.name}: ${line}`),
      });
      this.onLog(`iOS auto-start: ${device.name} on port ${port} with team ${team.name} (${team.id}).`);
      try {
        await runner.start();
        this.managed.set(runner.baseUrl, { udid: device.udid, name: device.name, runner });
      } catch (error) {
        runner.stop();
        this.onLog(`iOS auto-start failed for ${device.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Forgets runners whose WebDriverAgent stopped answering, so the next scan starts them again. */
  private async dropDeadRunners(): Promise<void> {
    for (const [url, device] of this.managed) {
      if (!(await reachable(url))) {
        device.runner.stop();
        this.managed.delete(url);
        this.drivers.delete(url);
      }
    }
  }

  /** The first port from autoStartPort that no runner holds and nothing answers on. */
  private async freePort(): Promise<number> {
    const taken = new Set([...this.managed.keys()].map((url) => Number(new URL(url).port)));
    for (let port = this.autoStartPort; ; port++) {
      if (!taken.has(port) && !(await reachable(`http://127.0.0.1:${port}`))) return port;
    }
  }

  private async connectAll(urls: string[]): Promise<WdaDriver[]> {
    const found = await Promise.all(urls.map((url) => this.connect(url)));
    return found.filter((d): d is WdaDriver => d !== undefined);
  }

  private async connect(url: string): Promise<WdaDriver | undefined> {
    const cached = this.drivers.get(url);
    if (!(await reachable(url))) {
      this.drivers.delete(url);
      return undefined;
    }
    if (cached) return cached;

    const client = new WdaClient(url);
    const screen = await client.get<{ screenSize: { width: number; height: number }; scale: number }>(
      "/wda/screen",
    );
    const scale = screen.scale || 1;
    const host = new URL(url).host;
    const managed = this.managed.get(url);
    const driver = new WdaDriver(
      client,
      {
        // The id stays tied to the port, so it does not change when the phone is renamed.
        id: `wda:${host}`,
        name: managed?.name ?? `iPhone (${host})`,
        platform: "ios",
        driver: "wda",
        screen: {
          width: Math.round(screen.screenSize.width * scale),
          height: Math.round(screen.screenSize.height * scale),
        },
        ...((managed?.udid ?? this.udid) ? { serial: managed?.udid ?? this.udid } : {}),
      },
      screen.screenSize,
      scale,
      managed?.udid ?? this.udid,
      this.checkVisibility,
    );
    this.drivers.set(url, driver);
    return driver;
  }
}

async function reachable(url: string): Promise<boolean> {
  try {
    await new WdaClient(url).get("/status", 3_000);
    return true;
  } catch {
    return false;
  }
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || error.message}`));
      else resolve(stdout);
    });
  });
}

/** Width and height from a PNG header, without decoding the image. */
function pngSize(png: Buffer): { width: number; height: number } | undefined {
  if (png.length < 24 || png.readUInt32BE(12) !== 0x49484452) return undefined;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
