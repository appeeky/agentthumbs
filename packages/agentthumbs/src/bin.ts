#!/usr/bin/env node
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  describeObservation,
  type ActionResult,
  type DeviceSession,
  type Direction,
  type Key,
  type Observation,
  type ObservationState,
  type Target,
} from "./core/index.js";
import { discoverIosDevices, findSigningTeams, pickTeam, WdaProvider } from "./drivers/wda/index.js";
import { macDialogApprover, ttyApprover } from "./approval.js";
import { Connector, type ConnectorApproval, type ConnectorStatus } from "./connector.js";
import { runRelay } from "./relay.js";
import { runMcpServer, type ApprovalMode } from "./mcp.js";
import { createAgentThumbs, HOME } from "./setup.js";

const USAGE = `agentthumbs: give your AI agent a real phone

Usage:
  agentthumbs mcp [--approval auto|elicit|dialog|off]   Start the MCP server (stdio)
  agentthumbs serve --relay <wss url> [--name n] [--approval relay|dialog|off]
                                                        Share this computer's phones with a relay
  agentthumbs relay [--port 8787]                       Run a relay: connectors on /connect, MCP on /mcp
  agentthumbs devices                                   List connected phones
  agentthumbs observe [--out file]                      Screenshot + numbered elements
  agentthumbs tap <id | x,y>                            Tap an element or point
  agentthumbs long-press <id | x,y> [--duration ms]
  agentthumbs swipe <id | x,y> <id | x,y> [--duration ms]
  agentthumbs scroll <up|down|left|right> [--amount 0.5]
  agentthumbs type <text>
  agentthumbs key <home|back|enter|delete|app_switch|volume_up|volume_down|lock>
  agentthumbs open <app id>
  agentthumbs apps
  agentthumbs push <file>
  agentthumbs ios teams                                 List Apple signing teams in the keychain
  agentthumbs ios devices                               List iPhones and whether they are ready
  agentthumbs ios setup [--team <id|name>] [--udid u]   Build & start WebDriverAgent on every connected iPhone

Options:
  --device <id>   Pick a phone when several are connected
  --team <t>      Apple signing team id or name for iOS setup (or AGENTTHUMBS_IOS_TEAM)
  --udid <u>      Set up only this iPhone (or AGENTTHUMBS_WDA_UDID)
  --yes           Skip approval prompts (publish-like taps go through)
  --token <t>     Relay token for serve/relay (or AGENTTHUMBS_RELAY_TOKEN)

Coordinates are pixels in the last observation's screenshot (${HOME}/last.jpg).`;

/** Element ids from an observation older than this are not trusted across CLI calls. */
const STATE_TTL_MS = 10 * 60_000;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      device: { type: "string" },
      out: { type: "string" },
      duration: { type: "string" },
      amount: { type: "string" },
      approval: { type: "string" },
      relay: { type: "string" },
      token: { type: "string" },
      name: { type: "string" },
      team: { type: "string" },
      udid: { type: "string" },
      port: { type: "string" },
      yes: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...args] = positionals;

  if (!command || values.help) {
    console.log(USAGE);
    return;
  }

  if (command === "mcp") {
    const approval = (values.approval ?? "auto") as ApprovalMode;
    if (!["auto", "elicit", "dialog", "off"].includes(approval)) fail(`Unknown approval mode "${approval}".`);
    await runMcpServer({ approval });
    return;
  }

  if (command === "serve") {
    const relayUrl = values.relay ?? process.env.AGENTTHUMBS_RELAY_URL;
    const token = values.token ?? process.env.AGENTTHUMBS_RELAY_TOKEN;
    if (!relayUrl || !token) fail("serve needs --relay <wss url> and --token (or AGENTTHUMBS_RELAY_URL / _TOKEN).");
    const approval = (values.approval ?? "relay") as ConnectorApproval;
    if (!["relay", "dialog", "off"].includes(approval)) fail(`Unknown approval mode "${approval}".`);
    const connector = new Connector({ relayUrl, token, approval, ...(values.name ? { name: values.name } : {}) });
    connector.on("status", (status: ConnectorStatus) => {
      if (status.state === "connected") console.error(`Connected to ${relayUrl}`);
      else if (status.state === "disconnected")
        console.error(`Disconnected (${status.reason}). Retrying in ${Math.round(status.retryInMs / 1000)}s.`);
    });
    connector.start();
    await new Promise<never>(() => undefined);
  }

  if (command === "relay") {
    const token = values.token ?? process.env.AGENTTHUMBS_RELAY_TOKEN;
    if (!token) fail("relay needs --token (or AGENTTHUMBS_RELAY_TOKEN).");
    const port = Number(values.port ?? process.env.PORT ?? 8787);
    const relay = await runRelay({ port, token });
    console.error(`Relay listening on ${relay.url}: connectors → /connect, MCP → /mcp`);
    await new Promise<never>(() => undefined);
  }

  if (command === "ios") {
    await runIosCommand(args[0], values.team, values.udid);
    return;
  }

  const pw = createAgentThumbs({
    ...(values.yes
      ? { policy: { requireApproval: false } }
      : { approver: process.stdin.isTTY ? ttyApprover() : macDialogApprover() }),
  });

  if (command === "devices") {
    const devices = await pw.devices();
    if (devices.length === 0) {
      console.log("No phones connected.");
      for (const problem of await pw.diagnose()) console.log(`- ${problem}`);
    }
    for (const d of devices) console.log(`${d.id}\t${d.name}\t${d.platform}\t${d.screen.width}x${d.screen.height}`);
    return;
  }

  const session = await pw.device(values.device);
  loadState(session);
  const duration = values.duration ? Number(values.duration) : undefined;

  switch (command) {
    case "observe":
      return show(session, await session.observe(), values.out);
    case "tap":
      return report(session, await session.tap(target(args[0])), values.out);
    case "long-press":
      return report(session, await session.longPress(target(args[0]), duration), values.out);
    case "swipe":
      return report(session, await session.swipe(target(args[0]), target(args[1]), duration), values.out);
    case "scroll": {
      const direction = args[0] as Direction;
      if (!["up", "down", "left", "right"].includes(direction)) fail("scroll needs up, down, left or right.");
      const amount = values.amount ? Number(values.amount) : undefined;
      return report(session, await session.scroll(direction, amount), values.out);
    }
    case "type":
      if (!args[0]) fail("type needs text.");
      return report(session, await session.type(args.join(" ")), values.out);
    case "key":
      if (!args[0]) fail("key needs a key name.");
      return report(session, await session.key(args[0] as Key), values.out);
    case "open":
      if (!args[0]) fail("open needs an app id.");
      return report(session, await session.openApp(args[0]), values.out);
    case "apps":
      for (const app of await session.listApps()) console.log(app.id);
      return;
    case "push":
      if (!args[0]) fail("push needs a file.");
      console.log(await session.pushMedia(resolve(args[0])));
      return;
    default:
      fail(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

async function runIosCommand(sub: string | undefined, team: string | undefined, udid: string | undefined): Promise<void> {
  if (sub === "teams") {
    const teams = await findSigningTeams();
    if (teams.length === 0) fail("No Apple Development certificate found. Sign in to Xcode (Settings > Accounts).");
    for (const t of teams) {
      console.log(`${t.id}\t${t.name}\texpires ${t.expires?.toISOString().slice(0, 10) ?? "?"}`);
    }
    return;
  }
  if (sub === "devices") {
    const devices = await discoverIosDevices();
    if (devices.length === 0) console.log("No iPhones found. Connect one with a cable and unlock it.");
    for (const d of devices) {
      console.log(`${d.udid}\t${d.name}\t${d.osVersion ?? "?"}\t${d.blocker ? `blocked: ${d.blocker}` : "ready"}`);
    }
    return;
  }
  if (sub === "setup") {
    const chosen = pickTeam(await findSigningTeams(), team);
    console.error(`Using signing team ${chosen.name} (${chosen.id}).`);
    const provider = new WdaProvider({
      autoStart: true,
      team: chosen.id,
      ...(udid ? { udid } : {}),
      onLog: (l) => console.error(`[ios] ${l}`),
    });
    const drivers = await provider.discover();
    if (drivers.length === 0) {
      for (const problem of await provider.diagnose()) console.error(`- ${problem}`);
      fail("WebDriverAgent could not start.");
    }
    for (const d of drivers) console.error(`Ready: ${d.info.name} (${d.info.id}).`);
    console.error("Leave this running; agentthumbs will use these iPhones. Ctrl-C to stop.");
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(signal, () => {
        provider.stop();
        process.exit(0);
      });
    }
    await new Promise<never>(() => undefined);
  }
  fail("Usage: agentthumbs ios <teams|devices|setup> [--team <id|name>] [--udid <udid>]");
}

function target(arg: string | undefined): Target {
  if (!arg) fail("Missing target: an element id or x,y.");
  const point = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(arg);
  if (point) return { x: Number(point[1]), y: Number(point[2]) };
  if (/^\d+$/.test(arg)) return { element: Number(arg) };
  fail(`"${arg}" is not an element id or x,y.`);
}

function report(session: DeviceSession, result: ActionResult, out: string | undefined): void {
  if (result.observation) show(session, result.observation, out);
  else console.log(`${result.action}: done`);
}

function show(session: DeviceSession, observation: Observation, out: string | undefined): void {
  mkdirSync(HOME, { recursive: true });
  const ext = observation.image.mimeType === "image/png" ? "png" : "jpg";
  const last = join(HOME, `last.${ext}`);
  writeFileSync(last, observation.image.data);
  if (out) writeFileSync(resolve(out), observation.image.data);
  saveState(session);
  console.log(describeObservation(observation));
  console.log(`\nScreenshot: ${out ? resolve(out) : last}`);
}

function statePath(session: DeviceSession): string {
  return join(HOME, "state", `${session.info.id.replace(/[^\w.-]/g, "_")}.json`);
}

function saveState(session: DeviceSession): void {
  const state = session.exportState();
  if (!state) return;
  mkdirSync(join(HOME, "state"), { recursive: true });
  writeFileSync(statePath(session), JSON.stringify(state));
}

function loadState(session: DeviceSession): void {
  try {
    const path = statePath(session);
    if (Date.now() - statSync(path).mtimeMs > STATE_TTL_MS) return;
    session.importState(JSON.parse(readFileSync(path, "utf8")) as ObservationState);
  } catch {
    // No saved observation yet.
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

main().then(
  // Exit explicitly: the iPhone Mirroring helper may still be attached.
  () => process.exit(0),
  (error: unknown) => {
    const code = (error as { code?: string }).code;
    console.error(`${code ? `${code}: ` : ""}${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
