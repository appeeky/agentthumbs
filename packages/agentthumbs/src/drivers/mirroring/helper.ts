import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

type HelperProcess = ChildProcessByStdio<Writable, Readable, null>;

/** The Swift helper shipped in `native/`, or `$AGENTTHUMBS_MIRRORING_HELPER`. */
export function helperPath(): string {
  return (
    process.env.AGENTTHUMBS_MIRRORING_HELPER ??
    fileURLToPath(new URL("../../../native/agentthumbs-mirroring", import.meta.url))
  );
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One long-lived helper process, spoken to in JSON lines. Started on first use
 * and restarted if it dies.
 */
export class MirroringHelper {
  private child: HelperProcess | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly path: string = helperPath()) {}

  get available(): boolean {
    return process.platform === "darwin" && existsSync(this.path);
  }

  request<T extends Record<string, unknown>>(
    cmd: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<T> {
    const child = this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`iPhone Mirroring helper did not answer "${cmd}" in ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as Pending["resolve"], reject, timer });
      child.stdin.write(`${JSON.stringify({ id, cmd, ...params })}\n`);
    });
  }

  close(): void {
    this.child?.kill();
    this.child = undefined;
  }

  private start(): HelperProcess {
    if (this.child) return this.child;
    if (!this.available) throw new Error(`iPhone Mirroring helper not found at ${this.path}.`);
    const child = spawn(this.path, [], { stdio: ["pipe", "pipe", "ignore"] });
    // Do not keep the Node process alive just for the helper.
    child.unref();
    (child.stdout as unknown as { unref?: () => void }).unref?.();
    (child.stdin as unknown as { unref?: () => void }).unref?.();

    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const pending = this.pending.get(message.id as number);
      if (!pending) return;
      this.pending.delete(message.id as number);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message);
      else pending.reject(new Error(String(message.error ?? "iPhone Mirroring helper failed.")));
    });
    child.on("exit", () => {
      this.child = undefined;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("iPhone Mirroring helper exited."));
        this.pending.delete(id);
      }
    });
    this.child = child;
    return child;
  }
}

let shared: MirroringHelper | undefined;

export function sharedHelper(): MirroringHelper {
  shared ??= new MirroringHelper();
  return shared;
}
