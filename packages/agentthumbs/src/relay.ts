import { randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import WebSocket, { WebSocketServer } from "ws";
import { canElicit, elicitApproval } from "./elicit.js";
import { fromWireError, InvocationError } from "./errors.js";
import type {
  ConnectorMessage,
  Invocation,
  InvocationResult,
  RelayMessage,
  WireApprovalRequest,
  WireDevice,
} from "./protocol.js";
import { INSTRUCTIONS, registerPhoneTools, VERSION, type PhoneService } from "./tools.js";

export interface ConnectorInfo {
  id: string;
  /** Whose connector this is, as returned by `authenticate`. */
  tenant: string;
  name: string;
  version: string;
  platform: string;
  /** Device ids here are already namespaced as `<connector name>/<device id>`. */
  devices: WireDevice[];
  problems: string[];
  connectedAt: string;
}

export interface InvokeOptions {
  /** Only this tenant's connectors are considered. Defaults to the single-tenant "default". */
  tenant?: string;
  /** Called when the connector needs a human to approve something for this invocation. */
  onApproval?: (request: WireApprovalRequest) => Promise<boolean>;
  timeoutMs?: number;
}

interface LiveConnector extends ConnectorInfo {
  socket: WebSocket;
  alive: boolean;
}

interface PendingInvocation {
  connectorId: string;
  resolve: (result: InvocationResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  onApproval?: InvokeOptions["onApproval"];
}

export interface RelayHubOptions {
  /**
   * Decides whether a connector may join and whose it is. Receives the bearer
   * token without the prefix; returns a tenant id, or null to refuse.
   */
  authenticate: (token: string, request: IncomingMessage) => string | null | Promise<string | null>;
  pingIntervalMs?: number;
}

export const DEFAULT_TENANT = "default";

/**
 * The relay side of the protocol: accepts connector WebSockets and routes
 * invocations to the connector that owns the target device. Embed it in any
 * HTTP server through `handleUpgrade`. Connectors belong to the tenant
 * `authenticate` returns, and invocations only reach their own tenant's.
 * Emits "connectors" with (tenant, connectors) when a tenant's set changes.
 */
export class RelayHub extends EventEmitter {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  private readonly live = new Map<string, LiveConnector>();
  private readonly pending = new Map<string, PendingInvocation>();
  private readonly pingTimer: NodeJS.Timeout;

  constructor(private readonly options: RelayHubOptions) {
    super();
    this.pingTimer = setInterval(() => this.ping(), options.pingIntervalMs ?? 25_000);
    this.pingTimer.unref();
  }

  async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const token = bearer(request);
    const tenant = token ? await this.options.authenticate(token, request) : null;
    if (!tenant) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws, tenant));
  }

  connectors(tenant = DEFAULT_TENANT): ConnectorInfo[] {
    return this.of(tenant).map(({ socket: _socket, alive: _alive, ...info }) => info);
  }

  devices(tenant = DEFAULT_TENANT): WireDevice[] {
    return this.of(tenant).flatMap((c) => c.devices);
  }

  /** Every tenant with at least one live connector. */
  tenants(): string[] {
    return [...new Set([...this.live.values()].map((c) => c.tenant))];
  }

  async invoke(invocation: Invocation, options: InvokeOptions = {}): Promise<InvocationResult> {
    const tenant = options.tenant ?? DEFAULT_TENANT;
    if (invocation.method === "devices") {
      const connectors = this.of(tenant);
      const devices = connectors.flatMap((c) => c.devices);
      const problems =
        connectors.length === 0
          ? ["No connector is online. Run `agentthumbs serve` on the computer the phones are plugged into."]
          : connectors.flatMap((c) => c.problems.map((p) => `${c.name}: ${p}`));
      return { kind: "devices", devices, problems: devices.length === 0 ? problems : [] };
    }

    const { connector, localId } = this.route(tenant, "device" in invocation ? invocation.device : undefined);
    const id = randomUUID();
    const forwarded = { ...invocation, device: localId } as Invocation;
    return new Promise<InvocationResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new InvocationError(`${connector.name} did not answer in time.`));
      }, options.timeoutMs ?? 15 * 60_000);
      this.pending.set(id, {
        connectorId: connector.id,
        resolve: (result) => resolve(this.namespaceResult(connector, result)),
        reject,
        timer,
        ...(options.onApproval ? { onApproval: options.onApproval } : {}),
      });
      this.send(connector.socket, { type: "invoke", id, invocation: forwarded });
    });
  }

  close(): void {
    clearInterval(this.pingTimer);
    for (const connector of this.live.values()) connector.socket.close(1001, "relay shutting down");
    this.wss.close();
  }

  private of(tenant: string): LiveConnector[] {
    return [...this.live.values()].filter((c) => c.tenant === tenant);
  }

  private accept(socket: WebSocket, tenant: string): void {
    const id = randomUUID();
    let connector: LiveConnector | undefined;

    socket.on("message", (data) => {
      let message: ConnectorMessage;
      try {
        message = JSON.parse(data.toString()) as ConnectorMessage;
      } catch {
        return;
      }
      if (message.type === "hello") {
        connector = {
          id,
          tenant,
          name: this.uniqueName(tenant, message.connector.name),
          version: message.connector.version,
          platform: message.connector.platform,
          devices: [],
          problems: message.problems,
          connectedAt: new Date().toISOString(),
          socket,
          alive: true,
        };
        connector.devices = message.devices.map((d) => namespaced(connector!, d));
        this.live.set(id, connector);
        this.send(socket, { type: "welcome", connectorId: id });
        this.emit("connectors", tenant, this.connectors(tenant));
        return;
      }
      if (connector) void this.handle(connector, message);
    });

    socket.on("pong", () => {
      if (connector) connector.alive = true;
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      this.live.delete(id);
      for (const [pendingId, pending] of this.pending) {
        if (pending.connectorId !== id) continue;
        clearTimeout(pending.timer);
        pending.reject(new InvocationError("The phone's computer disconnected."));
        this.pending.delete(pendingId);
      }
      if (connector) this.emit("connectors", tenant, this.connectors(tenant));
    });
  }

  private async handle(connector: LiveConnector, message: ConnectorMessage): Promise<void> {
    switch (message.type) {
      case "devices":
        connector.devices = message.devices.map((d) => namespaced(connector, d));
        connector.problems = message.problems;
        this.emit("connectors", connector.tenant, this.connectors(connector.tenant));
        return;
      case "pong":
        connector.alive = true;
        return;
      case "result": {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(fromWireError(message.error));
        return;
      }
      case "approval_request": {
        const pending = this.pending.get(message.invocationId);
        const request = { ...message.request, device: namespaced(connector, message.request.device) };
        if (!pending?.onApproval) {
          this.send(connector.socket, {
            type: "approval_response",
            id: message.id,
            approved: false,
            unavailable: `${request.reason} Nobody is available to approve it.`,
          });
          return;
        }
        try {
          const approved = await pending.onApproval(request);
          this.send(connector.socket, { type: "approval_response", id: message.id, approved });
        } catch (error) {
          this.send(connector.socket, {
            type: "approval_response",
            id: message.id,
            approved: false,
            unavailable: (error as Error).message,
          });
        }
        return;
      }
    }
  }

  private route(
    tenant: string,
    device: string | undefined,
  ): { connector: LiveConnector; localId: string | undefined } {
    const connectors = this.of(tenant);
    if (device) {
      const slash = device.indexOf("/");
      const name = slash === -1 ? undefined : device.slice(0, slash);
      const connector = connectors.find((c) => c.name === name);
      if (!connector) throw new InvocationError(`No device "${device}". Call devices to see what is online.`);
      return { connector, localId: device.slice(slash + 1) };
    }
    const all = connectors.flatMap((c) => c.devices.map((d) => ({ c, d })));
    if (all.length === 1) return { connector: all[0]!.c, localId: undefined };
    if (all.length === 0) throw new InvocationError("No phones are online.");
    throw new InvocationError(`Several phones are online, pass a device id: ${all.map((x) => x.d.id).join(", ")}`);
  }

  private namespaceResult(connector: LiveConnector, result: InvocationResult): InvocationResult {
    if (result.kind === "observation") {
      const device = namespaced(connector, result.observation.device);
      const description = result.observation.description.replace(
        `(${result.observation.device.id})`,
        `(${device.id})`,
      );
      return { kind: "observation", observation: { ...result.observation, device, description } };
    }
    return result;
  }

  private uniqueName(tenant: string, requested: string): string {
    const taken = new Set(this.of(tenant).map((c) => c.name));
    const base = requested.replace(/\//g, "-") || "connector";
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }

  private ping(): void {
    for (const connector of this.live.values()) {
      if (!connector.alive) {
        connector.socket.terminate();
        continue;
      }
      connector.alive = false;
      connector.socket.ping();
      this.send(connector.socket, { type: "ping" });
    }
  }

  private send(socket: WebSocket, message: RelayMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}

function namespaced(connector: { name: string }, device: WireDevice): WireDevice {
  return device.id.startsWith(`${connector.name}/`) ? device : { ...device, id: `${connector.name}/${device.id}` };
}

function bearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
}

export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface RelayServerOptions {
  port: number;
  host?: string;
  /** Shared secret for connectors and MCP clients. */
  token: string;
}

/**
 * A single-tenant relay: connectors join at /connect, remote agents use MCP
 * over HTTP at /mcp, both with `Authorization: Bearer <token>`. Approvals go
 * to the agent's MCP client through elicitation.
 */
export async function runRelay(options: RelayServerOptions): Promise<{ close: () => void; url: string }> {
  const hub = new RelayHub({
    authenticate: (token) => (tokensMatch(token, options.token) ? DEFAULT_TENANT : null),
  });
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://relay");
    if (url.pathname === "/health") {
      return json(res, 200, { ok: true, version: VERSION, connectors: hub.connectors().length });
    }
    if (url.pathname !== "/mcp") return json(res, 404, { error: "Not found" });
    const token = bearer(req);
    if (!token || !tokensMatch(token, options.token)) return json(res, 401, { error: "Unauthorized" });

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const body = req.method === "POST" ? await readJson(req) : undefined;
    let transport = sessionId ? sessions.get(sessionId) : undefined;

    if (!transport) {
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        return json(res, 400, { error: "Unknown or missing MCP session." });
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport!);
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) sessions.delete(transport!.sessionId);
      };
      const mcp = new McpServer({ name: "agentthumbs-relay", version: VERSION }, { instructions: INSTRUCTIONS });
      registerPhoneTools(mcp, relayService(hub, mcp));
      await mcp.connect(transport);
    }
    await transport.handleRequest(req, res, body);
  });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://relay");
    if (pathname === "/connect") void hub.handleUpgrade(req, socket, head);
    else socket.destroy();
  });

  await new Promise<void>((resolve) => server.listen(options.port, options.host ?? "0.0.0.0", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://${options.host ?? "localhost"}:${port}`,
    close: () => {
      hub.close();
      server.close();
    },
  };
}

/** Phone tools for one MCP session: routed through the hub, approvals asked of that session's client. */
function relayService(hub: RelayHub, mcp: McpServer): PhoneService {
  return {
    invoke: (invocation) =>
      hub.invoke(invocation, {
        onApproval: async (request) => {
          if (!canElicit(mcp)) {
            throw new Error(
              `${request.reason} This MCP client cannot show an approval prompt. Ask the user to do this step on the phone themselves.`,
            );
          }
          return elicitApproval(
            mcp,
            `${request.device.name} (${request.device.id}): ${request.reason}\n\nAllow the agent to ${request.action.replace("_", " ")}${
              request.label ? ` "${request.label}"` : ""
            }?`,
          );
        },
      }),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
