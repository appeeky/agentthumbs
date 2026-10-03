/** A point in native device pixels, origin at the top-left of the screen. */
export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Something on screen an agent can refer to. Drivers that expose an
 * accessibility or UI tree report elements with `source: "tree"`; element
 * sources that read the pixels (OCR) report `source: "ocr"`.
 */
export interface UiElement {
  label: string;
  role?: string;
  /** Bounds in native device pixels. */
  rect: Rect;
  clickable?: boolean;
  enabled?: boolean;
  source: "tree" | "ocr";
}

export type Key =
  | "home"
  | "back"
  | "enter"
  | "delete"
  | "app_switch"
  | "volume_up"
  | "volume_down"
  | "lock";

export type Platform = "android" | "ios";

export interface DeviceInfo {
  /** Stable id, unique across drivers (for example `adb:emulator-5554`). */
  id: string;
  name: string;
  platform: Platform;
  driver: string;
  /** Native screen size in pixels. */
  screen: { width: number; height: number };
  /** The hardware id when the driver knows it: the adb serial, or the iPhone's UDID. */
  serial?: string;
}

export interface AppInfo {
  /** Bundle id on iOS, package name on Android. */
  id: string;
  name: string;
}

export interface DriverCapabilities {
  uiTree: boolean;
  listApps: boolean;
  openApp: boolean;
  pushMedia: boolean;
  keys: readonly Key[];
}

/**
 * The only thing a new transport (adb, WebDriverAgent, iPhone Mirroring,
 * Bluetooth HID) has to implement. Drivers stay dumb: they move pixels and
 * events. Waiting, element resolution, scaling and safety live in the runtime.
 */
export interface DeviceDriver {
  readonly info: DeviceInfo;
  readonly capabilities: DriverCapabilities;

  /** PNG at native resolution. */
  screenshot(): Promise<Buffer>;
  tap(point: Point): Promise<void>;
  longPress(point: Point, durationMs: number): Promise<void>;
  swipe(from: Point, to: Point, durationMs: number): Promise<void>;
  /** Types into the focused field. */
  type(text: string): Promise<void>;
  key(key: Key): Promise<void>;

  uiTree?(): Promise<UiElement[]>;
  listApps?(): Promise<AppInfo[]>;
  openApp?(appId: string): Promise<void>;
  /** Copies a local image or video into the phone's gallery. Returns the on-device path. */
  pushMedia?(localPath: string): Promise<string>;
}

/** Finds devices reachable through one transport. */
export interface DriverProvider {
  readonly name: string;
  discover(): Promise<DeviceDriver[]>;
  /** Human-readable reasons this provider finds no devices, such as missing permissions. */
  diagnose?(): Promise<string[]>;
}

/** Produces elements from pixels when a driver has no UI tree (for example OCR). */
export interface ElementSource {
  readonly name: string;
  detect(png: Buffer): Promise<UiElement[]>;
}
