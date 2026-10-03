// End-to-end check against a connected phone or emulator: node scripts/e2e-mcp.mjs
// Uses "settings" as the approval word so the Settings icon on the home screen exercises elicitation.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const answers = [false, true];
const client = new Client({ name: "e2e", version: "0" }, { capabilities: { elicitation: {} } });
client.setRequestHandler(ElicitRequestSchema, async (req) => {
  const approve = answers.shift();
  console.log("ELICIT:", JSON.stringify(req.params.message), "->", approve);
  return { action: "accept", content: { approve } };
});
const server = `import("agentthumbs").then(m => m.runMcpServer({ approval: "elicit", policy: { approvalWords: ["settings"] } }))`;
await client.connect(new StdioClientTransport({ command: "node", args: ["--input-type=module", "-e", server], env: process.env }));

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  const img = r.content.find((c) => c.type === "image");
  console.log(`\n# ${name} ${JSON.stringify(args)} error=${!!r.isError} image=${img ? Math.round(img.data.length * 0.75 / 1024) + "KB" : "none"}`);
  console.log(text.split("\n").slice(0, 6).join("\n"));
  return text;
};
await call("devices");
await call("key", { key: "home" });
const obs = await call("observe");
const id = Number(/\[(\d+)\] "Settings"/.exec(obs)?.[1]);
await call("tap", { element: id });          // declined
await call("tap", { element: id });          // stale ids? no: declined taps do not act
await call("tap", { x: 9999, y: 1 , observe: false });
await call("scroll", { direction: "down" });
await call("key", { key: "home" });
await client.close();
