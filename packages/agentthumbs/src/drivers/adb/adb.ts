import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_BUFFER = 64 * 1024 * 1024;

/** Finds adb: $ADB, then the Android SDK, then PATH. */
export function findAdb(): string {
  if (process.env.ADB) return process.env.ADB;
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), "Library/Android/sdk"),
    join(homedir(), "Android/Sdk"),
  ].filter((root): root is string => Boolean(root));
  for (const root of sdkRoots) {
    const candidate = join(root, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
    if (existsSync(candidate)) return candidate;
  }
  return "adb";
}

export interface RunOptions {
  timeoutMs?: number;
}

/** Thin wrapper over the adb binary, scoped to one device when a serial is given. */
export class Adb {
  constructor(
    readonly bin: string = findAdb(),
    readonly serial?: string,
  ) {}

  forDevice(serial: string): Adb {
    return new Adb(this.bin, serial);
  }

  run(args: string[], options: RunOptions = {}): Promise<string> {
    return this.exec(args, options).then((out) => out.toString("utf8"));
  }

  runBinary(args: string[], options: RunOptions = {}): Promise<Buffer> {
    return this.exec(args, options);
  }

  /** Runs a command in the device shell. Arguments are quoted for the remote sh. */
  shell(args: string[], options?: RunOptions): Promise<string> {
    return this.run(["shell", args.map(quote).join(" ")], options);
  }

  private exec(args: string[], { timeoutMs = 30_000 }: RunOptions): Promise<Buffer> {
    const fullArgs = this.serial ? ["-s", this.serial, ...args] : args;
    return new Promise((resolve, reject) => {
      execFile(
        this.bin,
        fullArgs,
        { encoding: "buffer", maxBuffer: MAX_BUFFER, timeout: timeoutMs },
        (error, stdout, stderr) => {
          if (error) {
            const detail = stderr.toString("utf8").trim() || error.message;
            reject(new Error(`adb ${args.join(" ")} failed: ${detail}`));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }
}

/** Single-quotes an argument for the device's POSIX shell. */
export function quote(arg: string): string {
  if (/^[A-Za-z0-9_\-.,:/=@%+]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface AdbDeviceLine {
  serial: string;
  state: string;
  model?: string;
}

/** Parses `adb devices -l`. */
export function parseDevices(output: string): AdbDeviceLine[] {
  const devices: AdbDeviceLine[] = [];
  for (const line of output.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("*")) continue;
    const [serial, state, ...rest] = trimmed.split(/\s+/);
    if (!serial || !state) continue;
    const model = rest.find((part) => part.startsWith("model:"))?.slice("model:".length);
    devices.push({ serial, state, ...(model ? { model: model.replace(/_/g, " ") } : {}) });
  }
  return devices;
}

/** Parses `wm size`, preferring the override size when one is set. */
export function parseWmSize(output: string): { width: number; height: number } | undefined {
  const override = /Override size:\s*(\d+)x(\d+)/.exec(output);
  const physical = /Physical size:\s*(\d+)x(\d+)/.exec(output);
  const match = override ?? physical;
  if (!match) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}
