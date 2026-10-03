import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Anything with McpServer's registerTool. Structural, so servers built on a
 * different copy or version of the MCP SDK can host the phone tools too.
 */
export interface ToolHost {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK's own overloads differ between versions
  registerTool: (...args: any[]) => unknown;
}
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorCode, InvocationError } from "./errors.js";
import type { Invocation, InvocationResult, WireObservation, WireTarget } from "./protocol.js";

/** Runs invocations somewhere: on local phones, or through a relay on someone else's. */
export interface PhoneService {
  invoke(invocation: Invocation): Promise<InvocationResult>;
}

export const VERSION = "0.0.1";

export const INSTRUCTIONS = `agentthumbs controls real phones.

Loop: call observe, read the numbered elements and the screenshot, act, then read the observation the action returns. Every action returns a fresh screenshot unless you pass observe: false, so you rarely need to call observe twice.

Targets: prefer { element: <id> } from the latest observation. Use x/y (screenshot pixels) only for things without an element. Element ids expire after any action; use the ids from the most recent observation.

Safety: taps on elements labelled like Post, Share, Send, Buy or Pay wait for a human to approve. If the human declines, stop and ask them what to do instead of trying another way to do the same thing. Never type passwords or payment details the user did not give you for this task.`;

const KEYS = ["home", "back", "enter", "delete", "app_switch", "volume_up", "volume_down", "lock"] as const;

const device = z.string().optional().describe("Device id from devices. Optional when one device is connected.");
const observeFlag = z
  .boolean()
  .optional()
  .describe("Return a fresh screenshot after the action. Defaults to true.");
const targetShape = {
  element: z.number().int().positive().optional().describe("Element id from the latest observation."),
  x: z.number().optional().describe("X in screenshot pixels, when there is no element to target."),
  y: z.number().optional().describe("Y in screenshot pixels."),
};
const pointTarget = z.union([
  z.object({ element: z.number().int().positive() }),
  z.object({ x: z.number(), y: z.number() }),
]);

export interface RegisterPhoneToolsOptions {
  /** Prepended to every tool name, for servers that host other tools (e.g. "phone_"). */
  prefix?: string;
}

/** Registers the phone tools on an MCP server, backed by any PhoneService (local or relayed). */
export function registerPhoneTools(
  mcp: ToolHost,
  service: PhoneService,
  { prefix = "" }: RegisterPhoneToolsOptions = {},
): void {
  const call = (invocation: Invocation) => run(() => service.invoke(invocation));
  // Typed as this package's McpServer so the tool definitions below are checked against the SDK.
  const server = {
    registerTool: ((name: string, ...rest: unknown[]) => mcp.registerTool(`${prefix}${name}`, ...rest)) as McpServer["registerTool"],
  };

  server.registerTool(
    "devices",
    {
      title: "List phones",
      description: "Lists connected phones with their ids, platform and screen size.",
      annotations: { readOnlyHint: true },
    },
    () => call({ method: "devices" }),
  );

  server.registerTool(
    "observe",
    {
      title: "Look at the screen",
      description: "Screenshot of the phone with numbered boxes over tappable elements, plus the element list.",
      inputSchema: { device },
      annotations: { readOnlyHint: true },
    },
    ({ device: id }) => call({ method: "observe", device: id }),
  );

  server.registerTool(
    "tap",
    {
      title: "Tap",
      description: "Taps an element by id, or a point by x/y in screenshot pixels.",
      inputSchema: { device, ...targetShape, observe: observeFlag },
    },
    ({ device: id, observe, ...target }) =>
      run(() => service.invoke({ method: "tap", device: id, target: toTarget(target), observe })),
  );

  server.registerTool(
    "long_press",
    {
      title: "Long press",
      description: "Presses and holds an element or point.",
      inputSchema: {
        device,
        ...targetShape,
        duration_ms: z.number().int().min(100).max(10_000).optional(),
        observe: observeFlag,
      },
    },
    ({ device: id, observe, duration_ms, ...target }) =>
      run(() =>
        service.invoke({ method: "long_press", device: id, target: toTarget(target), durationMs: duration_ms, observe }),
      ),
  );

  server.registerTool(
    "swipe",
    {
      title: "Swipe",
      description: "Drags from one element or point to another. For plain scrolling, use scroll.",
      inputSchema: {
        device,
        from: pointTarget,
        to: pointTarget,
        duration_ms: z.number().int().min(50).max(5_000).optional(),
        observe: observeFlag,
      },
    },
    ({ device: id, from, to, duration_ms, observe }) =>
      call({ method: "swipe", device: id, from, to, durationMs: duration_ms, observe }),
  );

  server.registerTool(
    "scroll",
    {
      title: "Scroll",
      description: 'Scrolls the screen. "down" reveals content below, like reading further down a feed.',
      inputSchema: {
        device,
        direction: z.enum(["up", "down", "left", "right"]),
        amount: z.number().min(0.1).max(1).optional().describe("Fraction of the screen, default 0.5."),
        observe: observeFlag,
      },
    },
    ({ device: id, direction, amount, observe }) => call({ method: "scroll", device: id, direction, amount, observe }),
  );

  server.registerTool(
    "type",
    {
      title: "Type text",
      description: "Types into the focused text field. Tap the field first. Newlines press enter.",
      inputSchema: { device, text: z.string().min(1), observe: observeFlag },
    },
    ({ device: id, text, observe }) => call({ method: "type", device: id, text, observe }),
  );

  server.registerTool(
    "key",
    {
      title: "Press a key",
      description:
        "Presses a system key. Android: home, back, enter, delete, app_switch, volume_up, volume_down, lock. iOS: home, enter, delete, plus lock and volume over WebDriverAgent or app_switch through iPhone Mirroring.",
      inputSchema: { device, key: z.enum(KEYS), observe: observeFlag },
    },
    ({ device: id, key, observe }) => call({ method: "key", device: id, key, observe }),
  );

  server.registerTool(
    "open_app",
    {
      title: "Open an app",
      description:
        "Launches an app. Android: package name (see list_apps). iOS over WebDriverAgent: bundle id (see list_apps). iOS through iPhone Mirroring: the app's name as shown on the Home Screen.",
      inputSchema: { device, app_id: z.string().min(1), observe: observeFlag },
    },
    ({ device: id, app_id, observe }) => call({ method: "open_app", device: id, appId: app_id, observe }),
  );

  server.registerTool(
    "list_apps",
    {
      title: "List apps",
      description: "Lists apps installed on the phone.",
      inputSchema: { device },
      annotations: { readOnlyHint: true },
    },
    ({ device: id }) => call({ method: "list_apps", device: id }),
  );

  server.registerTool(
    "push_media",
    {
      title: "Copy media to the phone",
      description:
        "Copies an image or video into the phone's gallery so apps can pick it, for example when posting. Pass a path on the phone's computer or an https URL to download.",
      inputSchema: {
        device,
        path: z.string().min(1).optional().describe("Absolute path on the computer the phone is connected to."),
        url: z.string().url().optional().describe("URL the phone's computer downloads first."),
      },
    },
    ({ device: id, path, url }) =>
      run(() => {
        if (!path && !url) throw new InvocationError("Pass a path or a url.");
        return service.invoke({
          method: "push_media",
          device: id,
          ...(path ? { path } : {}),
          ...(url ? { url } : {}),
        });
      }),
  );
}

function toTarget(input: { element?: number | undefined; x?: number | undefined; y?: number | undefined }): WireTarget {
  if (input.element !== undefined) return { element: input.element };
  if (input.x !== undefined && input.y !== undefined) return { x: input.x, y: input.y };
  throw new InvocationError("Pass an element id, or both x and y.");
}

export function toToolResult(result: InvocationResult): CallToolResult {
  switch (result.kind) {
    case "observation":
      return observationResult(result.observation);
    case "devices":
      if (result.devices.length === 0) {
        return text(
          [
            "No phones connected.",
            "Android: enable USB debugging and check `adb devices`; emulators work too.",
            ...result.problems,
          ].join("\n"),
        );
      }
      return text(JSON.stringify(result.devices, null, 2));
    case "apps":
      return text(JSON.stringify(result.apps, null, 2));
    case "media":
      return text(`Copied to ${result.remotePath}. It is in the gallery now.`);
    case "done":
      return text(`${result.action}: done`);
  }
}

function observationResult(observation: WireObservation): CallToolResult {
  return {
    content: [
      { type: "text", text: observation.description },
      { type: "image", data: observation.image.data, mimeType: observation.image.mimeType },
    ],
  };
}

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

async function run(fn: () => Promise<InvocationResult>): Promise<CallToolResult> {
  try {
    return toToolResult(await fn());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = errorCode(error);
    return { isError: true, content: [{ type: "text", text: `${code ? `${code}: ` : ""}${message}` }] };
  }
}
