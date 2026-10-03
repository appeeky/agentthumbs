// End-to-end check of the remote path: relay + connector + remote MCP clients.
// Needs one connected phone or emulator: node scripts/e2e-relay.mjs
// Uses "settings" as the approval word so the Settings icon exercises approvals.
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import sharp from "sharp";
import { Connector, runRelay } from "@appeeky/agentthumbs";

const TOKEN = "e2e-secret";
const relay = await runRelay({ port: 0, host: "127.0.0.1", token: TOKEN });
const wsUrl = `${relay.url.replace("http", "ws")}/connect`;
const log = (...args) => console.log(...args);
const check = (label, ok, detail = "") => {
  log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};
const waitFor = (connector, state) =>
  new Promise((resolve) => {
    if (connector.status.state === state) return resolve(connector.status);
    connector.on("status", (s) => s.state === state && resolve(s));
  });

// 1. A wrong token is refused.
const intruder = new Connector({ relayUrl: wsUrl, token: "wrong", name: "intruder" }).start();
const refused = await waitFor(intruder, "disconnected");
intruder.stop();
check("wrong token rejected", /rejected the token/.test(refused.reason), refused.reason);

// 2. The real connector joins.
const connector = new Connector({
  relayUrl: wsUrl,
  token: TOKEN,
  name: "desk-mac",
  policy: { approvalWords: ["settings"] },
}).start();
await waitFor(connector, "connected");
check("connector connected", true);

async function mcpClient({ elicit }) {
  const client = new Client({ name: "remote-agent", version: "0" }, { capabilities: elicit ? { elicitation: {} } : {} });
  if (elicit) client.setRequestHandler(ElicitRequestSchema, async (req) => elicit(req.params.message));
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${relay.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }),
  );
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return {
      error: !!r.isError,
      text: r.content.find((c) => c.type === "text")?.text ?? "",
      image: r.content.find((c) => c.type === "image"),
    };
  };
  return { client, call };
}

// 3. Remote agent with approval prompts.
const answers = [false, true];
const asked = [];
const agent = await mcpClient({
  elicit: async (message) => {
    asked.push(message);
    return { action: "accept", content: { approve: answers.shift() } };
  },
});

const devices = await agent.call("devices");
const list = JSON.parse(devices.text);
check("devices are namespaced", list.length === 1 && list[0].id.startsWith("desk-mac/"), list[0]?.id);
const deviceId = list[0].id;

await agent.call("key", { key: "home", observe: false });
const home = await agent.call("observe");
check("observe returns image", home.image?.mimeType === "image/jpeg", `${Math.round(home.image.data.length * 0.75 / 1024)} KB`);
check("description uses the relay id", home.text.includes(`(${deviceId})`));
const settings = Number(/\[(\d+)\] "Settings"/.exec(home.text)?.[1]);

const denied = await agent.call("tap", { element: settings });
check("declined approval blocks the tap", denied.error && denied.text.startsWith("APPROVAL_DENIED"), denied.text);
const allowed = await agent.call("tap", { element: settings });
check("approved tap goes through", !allowed.error && /Search Settings/.test(allowed.text));
check("approval reached the remote client", asked.length === 2 && asked[0].includes(deviceId), asked[0]);

// 4. A client that cannot show prompts gets APPROVAL_UNAVAILABLE, not a fake denial.
const headless = await mcpClient({});
await headless.call("key", { key: "home", observe: false });
const obs = await headless.call("observe");
const again = Number(/\[(\d+)\] "Settings"/.exec(obs.text)?.[1]);
const unavailable = await headless.call("tap", { element: again });
check("no prompt → APPROVAL_UNAVAILABLE", unavailable.text.startsWith("APPROVAL_UNAVAILABLE"), unavailable.text);

// 5. push_media from a URL the connector downloads.
const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#4f46e5" } }).png().toBuffer();
const media = createServer((_, res) => res.writeHead(200, { "content-type": "image/png" }).end(png));
await new Promise((r) => media.listen(0, "127.0.0.1", r));
const mediaUrl = `http://127.0.0.1:${media.address().port}/agentthumbs-e2e.png`;
const pushed = await agent.call("push_media", { url: mediaUrl });
check("push_media downloads a URL", !pushed.error && pushed.text.includes("agentthumbs-e2e.png"), pushed.text);

// 6. The connector leaving is visible to agents.
connector.stop();
await new Promise((r) => setTimeout(r, 300));
const gone = await agent.call("devices");
check("offline connector reported", gone.text.includes("No connector is online"));

await agent.client.close();
await headless.client.close();
media.close();
relay.close();
process.exit();
