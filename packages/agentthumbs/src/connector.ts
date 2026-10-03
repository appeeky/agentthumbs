import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import { PolicyError, type AgentThumbs, type Approver, type PolicyConfig } from "./core/index.js";
import WebSocket from "ws";
import { macDialogApprover } from "./approval.js";
import {
  PROTOCOL_VERSION,
  type ConnectorMessage,
  type Invocation,
  type RelayMessage,
  type WireDevice,
} from "./protocol.js";
import { toWireError } from "./errors.js";
import { LocalPhoneService } from "./service.js";
import { createAgentThumbs } from "./setup.js";
import { VERSION } from "./tools.js";

export type ConnectorApproval = "relay" | "dialog" | "off";

export interface ConnectorOptions {
  /** WebSocket URL of the relay, for example wss://relay.example.com/connect. */
  relayUrl: string;
  /**
   * Sent as `Authorization: Bearer <token>`. A function is called before every
   * connection attempt, for short-lived tokens that refresh.
   */
  token: string | (() => string | Promise<string>);
  /** Shown to the relay and its users. Defaults to the host name. */
  name?: string;
  /**
   * relay: the relay asks a human (default). dialog: a macOS dialog on this machine.
   * off: publish-like taps go straight through.
   */
  approval?: ConnectorApproval;
  policy?: Partial<PolicyConfig>;
  /**
   * Run invocations on this AgentThumbs instead of creating one, so an app that
   * also drives the phones itself shares one runtime: one queue and one set of
   * rate limits per phone. `approval` and `policy` are then the instance's own;
   * give it `connector.approver()` so relay invocations still ask the relay.
   */
  thumbs?: AgentThumbs;
  /** How long an approval may wait for a human. */
  approvalTimeoutMs?: number;
  /** How often to look for plugged or unplugged phones. */
  devicePollMs?: number;
}

export type ConnectorStatus =
  | { state: "connecting" }
  | { state: "connected"; connectorId: string }
  | { state: "disconnected"; reason: string; retryInMs: number }
  | { state: "stopped" };

interface PendingApproval {
  resolve: (approved: boolean) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const MAX_BACKOFF_MS = 30_000;

/**
 * Keeps an outbound WebSocket to a relay and runs its invocations on the
 * phones attached to this machine. Emits "status" with a ConnectorStatus.
 */
export class Connector extends EventEmitter {
  private socket: WebSocket | undefined;
  private stopped = false;
  private backoffMs = 1_000;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private lastDevices = "";
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly context = new AsyncLocalStorage<{ invocationId: string }>();
  private readonly service: LocalPhoneService;
  private readonly pw: AgentThumbs;
  private readonly name: string;
  private statusValue: ConnectorStatus = { state: "connecting" };

  constructor(private readonly options: ConnectorOptions) {
    super();
    this.name = options.name ?? hostname();
    const mode = options.approval ?? "relay";
    const approver: Approver | undefined =
      mode === "off" ? undefined : mode === "dialog" ? macDialogApprover() : (request) => this.askRelay(request);
    this.pw =
      options.thumbs ??
      createAgentThumbs({
        ...(approver ? { approver } : {}),
        policy: { ...options.policy, ...(mode === "off" ? { requireApproval: false } : {}) },
      });
    this.service = new LocalPhoneService(this.pw);
  }

  /**
   * An approver for a shared AgentThumbs (see `thumbs`): actions that come from
   * the relay ask the relay's human; anything else goes to `fallback`, or is
   * refused when there is none.
   */
  approver(fallback?: Approver): Approver {
    return (request) => {
      if (this.context.getStore()) return this.askRelay(request);
      if (fallback) return fallback(request);
      return Promise.reject(new PolicyError("APPROVAL_UNAVAILABLE", `${request.reason} No approver for local actions.`));
    };
  }

  get status(): ConnectorStatus {
    return this.statusValue;
  }

  start(): this {
    this.stopped = false;
    void this.connect();
    return this;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pollTimer);
    this.socket?.close(1000, "connector stopped");
    this.socket = undefined;
    for (const [id, pending] of this.approvals) {
      clearTimeout(pending.timer);
      pending.resolve(false);
      this.approvals.delete(id);
    }
    this.setStatus({ state: "stopped" });
  }

  private async connect(): Promise<void> {
    this.setStatus({ state: "connecting" });
    let token: string;
    try {
      token = typeof this.options.token === "function" ? await this.options.token() : this.options.token;
    } catch (error) {
      this.scheduleReconnect(`Could not get a relay token: ${(error as Error).message}`);
      return;
    }
    if (this.stopped) return;
    const socket = new WebSocket(this.options.relayUrl, {
      headers: { authorization: `Bearer ${token}` },
      handshakeTimeout: 15_000,
    });
    this.socket = socket;

    socket.on("open", async () => {
      const { devices, problems } = await this.scanDevices();
      this.send({
        type: "hello",
        protocol: PROTOCOL_VERSION,
        connector: { name: this.name, version: VERSION, platform: process.platform },
        devices,
        problems,
      });
      clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => void this.pushDevices(), this.options.devicePollMs ?? 10_000);
    });

    socket.on("message", (data) => {
      let message: RelayMessage;
      try {
        message = JSON.parse(data.toString()) as RelayMessage;
      } catch {
        return;
      }
      void this.handle(message);
    });

    socket.on("unexpected-response", (_request, response) => {
      // 401/403 will not fix themselves; say so instead of retrying silently.
      const reason =
        response.statusCode === 401 || response.statusCode === 403
          ? "The relay rejected the token."
          : `The relay answered HTTP ${response.statusCode}.`;
      socket.terminate();
      this.scheduleReconnect(reason);
    });

    socket.on("error", (error) => this.scheduleReconnect(error.message));
    socket.on("close", (code, reason) => this.scheduleReconnect(reason.toString() || `closed (${code})`));
  }

  private async handle(message: RelayMessage): Promise<void> {
    switch (message.type) {
      case "welcome":
        this.backoffMs = 1_000;
        this.setStatus({ state: "connected", connectorId: message.connectorId });
        return;
      case "ping":
        this.send({ type: "pong" });
        return;
      case "approval_response": {
        const pending = this.approvals.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.approvals.delete(message.id);
        if (message.unavailable) pending.reject(new PolicyError("APPROVAL_UNAVAILABLE", message.unavailable));
        else pending.resolve(message.approved);
        return;
      }
      case "invoke":
        await this.invoke(message.id, message.invocation);
        return;
    }
  }

  private async invoke(id: string, invocation: Invocation): Promise<void> {
    try {
      const result = await this.context.run({ invocationId: id }, () => this.service.invoke(invocation));
      this.send({ type: "result", id, ok: true, result });
    } catch (error) {
      this.send({ type: "result", id, ok: false, error: toWireError(error) });
    }
  }

  /** Forwards an approval to the relay, tagged with the invocation that needs it. */
  private askRelay(request: Parameters<Approver>[0]): Promise<boolean> {
    const invocationId = this.context.getStore()?.invocationId;
    if (!invocationId || this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new PolicyError("APPROVAL_UNAVAILABLE", `${request.reason} The relay is not connected.`));
    }
    const id = randomUUID();
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.approvals.delete(id);
        resolve(false);
      }, this.options.approvalTimeoutMs ?? 10 * 60_000);
      this.approvals.set(id, { resolve, reject, timer });
      this.send({
        type: "approval_request",
        id,
        invocationId,
        request: {
          device: request.device,
          action: request.action,
          ...(request.label ? { label: request.label } : {}),
          reason: request.reason,
          ...(request.screenshot
            ? { screenshot: request.screenshot.toString("base64"), screenshotMimeType: sniffMime(request.screenshot) }
            : {}),
        },
      });
    });
  }

  private async scanDevices(): Promise<{ devices: WireDevice[]; problems: string[] }> {
    try {
      const devices = await this.pw.devices();
      const problems = devices.length === 0 ? await this.pw.diagnose() : [];
      this.lastDevices = JSON.stringify(devices);
      return { devices, problems };
    } catch (error) {
      return { devices: [], problems: [(error as Error).message] };
    }
  }

  private async pushDevices(): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const before = this.lastDevices;
    const { devices, problems } = await this.scanDevices();
    if (this.lastDevices !== before) this.send({ type: "devices", devices, problems });
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer) return;
    clearInterval(this.pollTimer);
    if (this.socket) {
      this.socket.removeAllListeners();
      // A late error on a dead socket must not crash the process.
      this.socket.on("error", () => undefined);
      this.socket.terminate();
      this.socket = undefined;
    }
    const retryInMs = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.setStatus({ state: "disconnected", reason, retryInMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, retryInMs);
  }

  private send(message: ConnectorMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private setStatus(status: ConnectorStatus): void {
    this.statusValue = status;
    this.emit("status", status);
  }
}

function sniffMime(image: Buffer): string {
  return image[0] === 0x89 ? "image/png" : "image/jpeg";
}
