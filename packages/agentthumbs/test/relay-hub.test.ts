import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { RelayHub } from "../src/relay.js";
import type { ConnectorMessage, RelayMessage, WireDevice } from "../src/protocol.js";

const phone = (id: string): WireDevice => ({
  id,
  name: id,
  platform: "android",
  driver: "adb",
  screen: { width: 1080, height: 2400 },
});

let server: Server | undefined;
let hub: RelayHub | undefined;
const sockets: WebSocket[] = [];

afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
  hub?.close();
  server?.close();
});

async function relay(): Promise<string> {
  hub = new RelayHub({ authenticate: (token) => (token.startsWith("user-") ? token.slice(5) : null) });
  server = createServer();
  server.on("upgrade", (req, socket, head) => void hub!.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

/** A fake connector that answers every invoke with the device it was asked for. */
async function connector(url: string, token: string, name: string, devices: WireDevice[]): Promise<WebSocket> {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => {
      const hello: ConnectorMessage = {
        type: "hello",
        protocol: 1,
        connector: { name, version: "test", platform: "linux" },
        devices,
        problems: [],
      };
      ws.send(JSON.stringify(hello));
    });
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString()) as RelayMessage;
      if (message.type === "welcome") resolve();
      if (message.type === "invoke") {
        const reply: ConnectorMessage = {
          type: "result",
          id: message.id,
          ok: true,
          result: { kind: "done", action: `${name}:${"device" in message.invocation ? message.invocation.device : ""}` },
        };
        ws.send(JSON.stringify(reply));
      }
    });
    ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on("error", reject);
  });
  return ws;
}

describe("RelayHub tenants", () => {
  it("refuses tokens authenticate rejects", async () => {
    const url = await relay();
    await expect(connector(url, "nope", "x", [])).rejects.toThrow("HTTP 401");
  });

  it("keeps each tenant's connectors and devices apart", async () => {
    const url = await relay();
    await connector(url, "user-alice", "mac", [phone("adb:1")]);
    await connector(url, "user-bob", "mac", [phone("adb:2")]);

    expect(hub!.devices("alice").map((d) => d.id)).toEqual(["mac/adb:1"]);
    expect(hub!.devices("bob").map((d) => d.id)).toEqual(["mac/adb:2"]);
    expect(hub!.tenants().sort()).toEqual(["alice", "bob"]);

    const devices = await hub!.invoke({ method: "devices" }, { tenant: "alice" });
    expect(devices).toMatchObject({ kind: "devices", devices: [{ id: "mac/adb:1" }] });
  });

  it("routes invocations only to the caller's own connector", async () => {
    const url = await relay();
    await connector(url, "user-alice", "mac", [phone("adb:1")]);
    await connector(url, "user-bob", "mac", [phone("adb:2")]);

    const result = await hub!.invoke({ method: "observe", device: "mac/adb:1" }, { tenant: "alice" });
    expect(result).toEqual({ kind: "done", action: "mac:adb:1" });
    // Same connector name, but Bob's device id never resolves for Alice's
    // connector: the invoke goes to Alice's connector with Bob's local id.
    const crossed = await hub!.invoke({ method: "observe", device: "mac/adb:2" }, { tenant: "alice" });
    expect(crossed).toEqual({ kind: "done", action: "mac:adb:2" });
    // A tenant without connectors reaches nobody.
    await expect(hub!.invoke({ method: "observe" }, { tenant: "carol" })).rejects.toThrow("No phones are online");
  });

  it("names clashing connectors apart within a tenant", async () => {
    const url = await relay();
    await connector(url, "user-alice", "mac", [phone("adb:1")]);
    await connector(url, "user-alice", "mac", [phone("adb:2")]);
    expect(hub!.connectors("alice").map((c) => c.name).sort()).toEqual(["mac", "mac-2"]);
  });
});
