import { basename } from "node:path";
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
import { Adb, parseDevices, parseWmSize } from "./adb.js";
import { parseUiAutomator } from "./uiautomator.js";

const KEYCODES: Record<Key, number> = {
  home: 3,
  back: 4,
  enter: 66,
  delete: 67,
  app_switch: 187,
  volume_up: 24,
  volume_down: 25,
  lock: 26,
};

const ADB_KEYBOARD_IME = "com.android.adbkeyboard/.AdbIME";
const DUMP_PATH = "/sdcard/window_dump.xml";
const MEDIA_DIR = "/sdcard/Pictures/agentthumbs";
const TEXT_CHUNK = 200;
const IME_BIND_MS = 800;

export class AdbDriver implements DeviceDriver {
  readonly capabilities: DriverCapabilities = {
    uiTree: true,
    listApps: true,
    openApp: true,
    pushMedia: true,
    keys: Object.keys(KEYCODES) as Key[],
  };

  constructor(
    private readonly adb: Adb,
    readonly info: DeviceInfo,
  ) {}

  screenshot(): Promise<Buffer> {
    return this.adb.runBinary(["exec-out", "screencap", "-p"]);
  }

  async tap({ x, y }: Point): Promise<void> {
    await this.adb.shell(["input", "tap", String(x), String(y)]);
  }

  async longPress({ x, y }: Point, durationMs: number): Promise<void> {
    await this.adb.shell(["input", "swipe", String(x), String(y), String(x), String(y), String(durationMs)]);
  }

  async swipe(from: Point, to: Point, durationMs: number): Promise<void> {
    await this.adb.shell([
      "input",
      "swipe",
      String(from.x),
      String(from.y),
      String(to.x),
      String(to.y),
      String(durationMs),
    ]);
  }

  /**
   * `input text` only handles plain ASCII. Anything else (accented letters, emoji) goes
   * through ADBKeyBoard when it is installed, restoring the user's keyboard after.
   */
  async type(text: string): Promise<void> {
    if (!isPlain(text)) return this.typeWithAdbKeyboard(text);
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      for (let i = 0; i < line.length; i += TEXT_CHUNK) {
        await this.adb.shell(["input", "text", escapeInputText(line.slice(i, i + TEXT_CHUNK))]);
      }
      if (index < lines.length - 1) await this.key("enter");
    }
  }

  async key(key: Key): Promise<void> {
    await this.adb.shell(["input", "keyevent", String(KEYCODES[key])]);
  }

  async uiTree(): Promise<UiElement[]> {
    // uiautomator refuses to dump while the screen animates; one retry covers most cases.
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await this.adb.shell(["uiautomator", "dump", DUMP_PATH], { timeoutMs: 15_000 });
      if (out.includes("dumped to")) {
        return parseUiAutomator(await this.adb.run(["exec-out", "cat", DUMP_PATH]));
      }
    }
    throw new Error("uiautomator could not dump the screen.");
  }

  async listApps(): Promise<AppInfo[]> {
    const out = await this.adb.shell(["pm", "list", "packages", "-3"]);
    return out
      .split("\n")
      .map((line) => line.trim().replace(/^package:/, ""))
      .filter(Boolean)
      .sort()
      .map((id) => ({ id, name: id }));
  }

  async openApp(appId: string): Promise<void> {
    const out = await this.adb.shell([
      "monkey",
      "-p",
      appId,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ]);
    if (/No activities found|monkey aborted/i.test(out)) {
      throw new Error(`Could not open ${appId}. Is it installed? Use list_apps to check.`);
    }
  }

  async pushMedia(localPath: string): Promise<string> {
    const remote = `${MEDIA_DIR}/${basename(localPath)}`;
    await this.adb.shell(["mkdir", "-p", MEDIA_DIR]);
    await this.adb.run(["push", localPath, remote], { timeoutMs: 120_000 });
    // Ask the media scanner to index it so it shows up in the gallery and share pickers.
    await this.adb
      .shell([
        "am",
        "broadcast",
        "-a",
        "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
        "-d",
        `file://${remote}`,
      ])
      .catch(() => undefined);
    return remote;
  }

  private async typeWithAdbKeyboard(text: string): Promise<void> {
    const installed = await this.adb.shell(["pm", "list", "packages", "com.android.adbkeyboard"]);
    if (!installed.includes("com.android.adbkeyboard")) {
      throw new Error(
        "Typing non-ASCII text on Android needs ADBKeyBoard. Download the latest APK from https://github.com/senzhk/ADBKeyBoard/releases and run `adb install <apk>`.",
      );
    }
    const previous = (await this.adb.shell(["settings", "get", "secure", "default_input_method"])).trim();
    await this.adb.shell(["ime", "enable", ADB_KEYBOARD_IME]);
    await this.adb.shell(["ime", "set", ADB_KEYBOARD_IME]);
    try {
      // The new IME needs a moment to bind to the focused field before it accepts input.
      await sleep(IME_BIND_MS);
      await this.adb.shell([
        "am",
        "broadcast",
        "-a",
        "ADB_INPUT_B64",
        "--es",
        "msg",
        Buffer.from(text, "utf8").toString("base64"),
      ]);
      await sleep(IME_BIND_MS / 2);
    } finally {
      if (previous && previous !== "null" && previous !== ADB_KEYBOARD_IME) {
        await this.adb.shell(["ime", "set", previous]);
      }
    }
  }
}

export class AdbProvider implements DriverProvider {
  readonly name = "adb";

  constructor(private readonly adb: Adb = new Adb()) {}

  async discover(): Promise<DeviceDriver[]> {
    let output: string;
    try {
      output = await this.adb.run(["devices", "-l"]);
    } catch {
      // No adb on this machine means no Android devices, not an error.
      return [];
    }
    const drivers: DeviceDriver[] = [];
    for (const line of parseDevices(output)) {
      if (line.state !== "device") continue;
      const adb = this.adb.forDevice(line.serial);
      const screen = parseWmSize(await adb.shell(["wm", "size"]));
      if (!screen) continue;
      drivers.push(
        new AdbDriver(adb, {
          id: `adb:${line.serial}`,
          name: line.model ?? line.serial,
          platform: "android",
          driver: "adb",
          screen,
          serial: line.serial,
        }),
      );
    }
    return drivers;
  }
}

/** Text `input text` can type verbatim: printable ASCII, and no literal "%s" (it means space). */
function isPlain(text: string): boolean {
  return /^[\x20-\x7e\n]*$/.test(text) && !text.includes("%s");
}

/** `input text` splits on spaces and reads `%s` as one. */
export function escapeInputText(text: string): string {
  return text.replace(/ /g, "%s");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
