import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  describeObservation,
  type ActionResult,
  type Key,
  type Observation,
  type AgentThumbs,
} from "./core/index.js";
import { InvocationError } from "./errors.js";
import type { Invocation, InvocationResult, WireObservation } from "./protocol.js";
import type { PhoneService } from "./tools.js";

const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

/** Runs invocations on phones attached to this machine. */
export class LocalPhoneService implements PhoneService {
  constructor(private readonly pw: AgentThumbs) {}

  async invoke(invocation: Invocation): Promise<InvocationResult> {
    if (invocation.method === "devices") {
      const devices = await this.pw.devices();
      const problems = devices.length === 0 ? await this.pw.diagnose() : [];
      return { kind: "devices", devices, problems };
    }

    const session = await this.pw.device(invocation.device);
    const opts = "observe" in invocation ? { observe: invocation.observe } : undefined;
    switch (invocation.method) {
      case "observe":
        return observed(await session.observe());
      case "tap":
        return acted(await session.tap(invocation.target, opts));
      case "long_press":
        return acted(await session.longPress(invocation.target, invocation.durationMs, opts));
      case "swipe":
        return acted(await session.swipe(invocation.from, invocation.to, invocation.durationMs, opts));
      case "scroll":
        return acted(await session.scroll(invocation.direction, invocation.amount, opts));
      case "type":
        return acted(await session.type(invocation.text, opts));
      case "key":
        return acted(await session.key(invocation.key as Key, opts));
      case "open_app":
        return acted(await session.openApp(invocation.appId, opts));
      case "list_apps":
        return { kind: "apps", apps: await session.listApps() };
      case "push_media": {
        if (invocation.path) return { kind: "media", remotePath: await session.pushMedia(invocation.path) };
        if (!invocation.url) throw new InvocationError("push_media needs a path or a url.");
        const { file, cleanup } = await download(invocation.url);
        try {
          return { kind: "media", remotePath: await session.pushMedia(file) };
        } finally {
          await cleanup();
        }
      }
      default:
        throw new InvocationError(`Unknown method "${(invocation as { method: string }).method}".`);
    }
  }
}

export function toWireObservation(observation: Observation): WireObservation {
  return {
    device: observation.device,
    image: {
      data: observation.image.data.toString("base64"),
      mimeType: observation.image.mimeType,
      width: observation.image.width,
      height: observation.image.height,
    },
    elements: observation.elements,
    description: describeObservation(observation),
    takenAt: observation.takenAt,
  };
}

function observed(observation: Observation): InvocationResult {
  return { kind: "observation", observation: toWireObservation(observation) };
}

function acted(result: ActionResult): InvocationResult {
  return result.observation ? observed(result.observation) : { kind: "done", action: result.action };
}

/** Downloads a media URL to a temp file, keeping a usable file name for the gallery. */
async function download(url: string): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!response.ok || !response.body) throw new InvocationError(`Could not download ${url}: HTTP ${response.status}.`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_DOWNLOAD_BYTES) throw new InvocationError("Media is larger than 512 MB.");

  const dir = await mkdtemp(join(tmpdir(), "agentthumbs-media-"));
  const name = basename(new URL(url).pathname) || "media";
  const ext = extname(name) || extensionFor(response.headers.get("content-type"));
  const file = join(dir, `${basename(name, extname(name))}${ext}`);
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(file));
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function extensionFor(contentType: string | null): string {
  const type = contentType?.split(";")[0]?.trim();
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/heic": ".heic",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
  };
  return (type && map[type]) || "";
}
