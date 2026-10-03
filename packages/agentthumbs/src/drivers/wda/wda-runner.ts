import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Builds WebDriverAgent, installs its runner on a USB iPhone and forwards its
 * port to localhost — the steps `scripts/ios-wda.sh` runs, in-process and
 * automatic. It shells out only to the standard toolchain: git, xcodebuild and
 * iproxy. Nothing here speaks a device protocol directly.
 */

const WDA_REPO = "https://github.com/appium/WebDriverAgent.git";
const READY_TIMEOUT_MS = 8 * 60_000;
const BUNDLE_ID = "com.appeeky.agentthumbs.WebDriverAgentRunner";

export interface WdaRunnerOptions {
  udid: string;
  teamId: string;
  /** Local port the device's WDA (8100) is forwarded to. */
  port: number;
  /** Base dir for the WDA checkout and build cache. Defaults to ~/.agentthumbs. */
  home?: string;
  bundleId?: string;
  onLog?: (line: string) => void;
}

type Phase = "idle" | "cloning" | "building" | "installing" | "ready" | "stopped";

export class WdaRunner {
  private xcodebuild: ChildProcess | undefined;
  private iproxy: ChildProcess | undefined;
  private phase: Phase = "idle";
  private readonly home: string;
  private readonly bundleId: string;

  constructor(private readonly options: WdaRunnerOptions) {
    this.home = options.home ?? process.env.AGENTTHUMBS_HOME ?? join(homedir(), ".agentthumbs");
    this.bundleId = options.bundleId ?? BUNDLE_ID;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.options.port}`;
  }

  /**
   * Ensures WebDriverAgent is built, the runner is on the device, and its port
   * is forwarded. Resolves once WDA answers /status. Rebuilds when the build
   * cache is missing (which also covers an expired free-team signature).
   */
  async start(): Promise<void> {
    const wdaDir = join(this.home, "WebDriverAgent");
    // One build per iPhone: the provisioning profile of a build lists the device it was built for.
    const buildDir = join(this.home, "wda-build", this.options.udid);
    await mkdir(this.home, { recursive: true });

    if (!existsSync(wdaDir)) {
      this.setPhase("cloning");
      await this.exec("git", ["clone", "--depth", "1", WDA_REPO, wdaDir]);
    }

    if (!(await hasXctestrun(buildDir))) {
      this.setPhase("building");
      await this.exec("xcodebuild", [
        "build-for-testing",
        "-project",
        join(wdaDir, "WebDriverAgent.xcodeproj"),
        "-scheme",
        "WebDriverAgentRunner",
        "-destination",
        `id=${this.options.udid}`,
        "-derivedDataPath",
        buildDir,
        "-allowProvisioningUpdates",
        `DEVELOPMENT_TEAM=${this.options.teamId}`,
        "CODE_SIGN_STYLE=Automatic",
        `PRODUCT_BUNDLE_IDENTIFIER=${this.bundleId}`,
      ]);
    }

    const xctestrun = await findXctestrun(buildDir);
    if (!xctestrun) throw new Error("WebDriverAgent build produced no .xctestrun file.");

    this.setPhase("installing");
    this.forwardPort();
    this.launchRunner(xctestrun);
    await this.waitUntilReady();
    this.setPhase("ready");
  }

  stop(): void {
    this.setPhase("stopped");
    this.iproxy?.kill();
    this.xcodebuild?.kill();
    this.iproxy = undefined;
    this.xcodebuild = undefined;
  }

  private forwardPort(): void {
    this.iproxy = spawn("iproxy", [`${this.options.port}`, "8100", "-u", this.options.udid], { stdio: "ignore" });
    this.iproxy.on("error", (error) => {
      this.log(`iproxy failed: ${error.message}. Install it with \`brew install libimobiledevice\`.`);
    });
  }

  private launchRunner(xctestrun: string): void {
    const child = spawn(
      "xcodebuild",
      ["test-without-building", "-xctestrun", xctestrun, "-destination", `id=${this.options.udid}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    this.xcodebuild = child;
    const watch = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (/ServerURLHere|error:|Test Suite .* (started|failed)/.test(line)) this.log(line.trim());
      }
    };
    child.stdout?.on("data", watch);
    child.stderr?.on("data", watch);
    child.on("exit", (code) => {
      if (this.phase !== "stopped") this.log(`WebDriverAgent runner exited (code ${code ?? "?"}).`);
    });
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.phase === "stopped") throw new Error("Stopped before WebDriverAgent was ready.");
      if (this.xcodebuild?.exitCode != null) {
        throw new Error(this.trustHint(`The runner exited before it was ready (code ${this.xcodebuild.exitCode}).`));
      }
      try {
        const res = await fetch(`${this.baseUrl}/status`, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) return;
      } catch {
        // Not up yet.
      }
      await sleep(1_000);
    }
    throw new Error(this.trustHint("WebDriverAgent did not become ready in time."));
  }

  private trustHint(message: string): string {
    return `${message} If this is the first run, trust the developer on the phone: Settings > General > VPN & Device Management.`;
  }

  private exec(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      const capture = (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (/error:|BUILD (SUCCEEDED|FAILED)|fatal:/.test(line)) this.log(line.trim());
        }
      };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);
      child.on("error", (error) =>
        reject(new Error(`${command} could not start: ${error.message}. Is Xcode installed?`)),
      );
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`${command} ${args[0]} failed (exit ${code ?? "?"}).`)),
      );
    });
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    if (phase !== "idle" && phase !== "stopped") this.log(`phase: ${phase}`);
  }

  private log(line: string): void {
    this.options.onLog?.(line);
  }
}

async function hasXctestrun(buildDir: string): Promise<boolean> {
  return (await findXctestrun(buildDir)) !== undefined;
}

async function findXctestrun(buildDir: string): Promise<string | undefined> {
  const productsDir = join(buildDir, "Build", "Products");
  try {
    const file = (await readdir(productsDir)).find((name) => name.endsWith(".xctestrun"));
    return file ? join(productsDir, file) : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
