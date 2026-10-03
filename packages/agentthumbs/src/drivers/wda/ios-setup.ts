import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Runs a command, writing `input` to its stdin, and returns stdout. */
function runWithInput(command: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code ?? "?"}`))));
    child.stdin.end(input);
  });
}

/** A code-signing team found in the login keychain. */
export interface SigningTeam {
  /** The 10-character Apple team id (the certificate's OU). */
  id: string;
  /** The organisation name (the certificate's O), e.g. "Webmob OU". */
  name: string;
  /** The signing identity's SHA-1, for reference. */
  identity: string;
  /** When this team's newest Apple Development certificate expires. */
  expires: Date | undefined;
}

/**
 * Apple Development signing teams in the login keychain, newest certificate
 * first. WebDriverAgent needs one to sign its runner; a free Personal Team works.
 */
export async function findSigningTeams(): Promise<SigningTeam[]> {
  let listing: string;
  try {
    listing = (await run("security", ["find-identity", "-v", "-p", "codesigning"])).stdout;
  } catch {
    return [];
  }

  const teams = new Map<string, SigningTeam>();
  for (const line of listing.split("\n")) {
    // e.g. `  2) <sha1> "Apple Development: Name (KEYID)" (CSSMERR_TP_CERT_REVOKED)`
    const match = /\b([0-9A-F]{40})\s+"(Apple Development: [^"]+)"(.*)$/.exec(line);
    if (!match) continue;
    const [, identity, commonName, trailer] = match;
    if (/CSSMERR|REVOKED/i.test(trailer!)) continue;

    const cert = await certificateFields(commonName!);
    if (!cert?.teamId) continue;
    const existing = teams.get(cert.teamId);
    if (!existing || (cert.expires && existing.expires && cert.expires > existing.expires)) {
      teams.set(cert.teamId, {
        id: cert.teamId,
        name: cert.orgName ?? cert.teamId,
        identity: identity!,
        expires: cert.expires,
      });
    }
  }
  return [...teams.values()].sort((a, b) => (b.expires?.getTime() ?? 0) - (a.expires?.getTime() ?? 0));
}

interface CertificateFields {
  teamId: string | undefined;
  orgName: string | undefined;
  expires: Date | undefined;
}

async function certificateFields(commonName: string): Promise<CertificateFields | undefined> {
  try {
    const pem = (await run("security", ["find-certificate", "-c", commonName, "-p"])).stdout;
    const info = await runWithInput("openssl", ["x509", "-noout", "-subject", "-enddate", "-nameopt", "RFC2253"], pem);
    // subject=...,OU=ZF9P9LGM63,O=Webmob OU,C=US  /  notAfter=Dec 27 19:51:59 2026 GMT
    const teamId = /(?:^|,)OU=([^,]+)/.exec(info)?.[1]?.trim();
    const orgName = /(?:^|,)O=([^,]+)/.exec(info)?.[1]?.trim();
    const end = /notAfter=(.+)/.exec(info)?.[1]?.trim();
    const expires = end ? new Date(end) : undefined;
    return { teamId, orgName, expires: expires && !Number.isNaN(expires.getTime()) ? expires : undefined };
  } catch {
    return undefined;
  }
}

export class NoSigningTeamError extends Error {
  constructor() {
    super(
      "No Apple Development certificate found. Sign in to Xcode (Settings > Accounts), then Manage Certificates > + > Apple Development.",
    );
    this.name = "NoSigningTeamError";
  }
}

/**
 * Chooses the signing team. A preference (id or name, from the argument or
 * AGENTTHUMBS_IOS_TEAM) wins; otherwise the newest certificate does. Throws
 * when the keychain has no usable team.
 */
export function pickTeam(teams: SigningTeam[], preferred = process.env.AGENTTHUMBS_IOS_TEAM): SigningTeam {
  if (teams.length === 0) throw new NoSigningTeamError();
  if (preferred) {
    const wanted = preferred.trim().toLowerCase();
    const match = teams.find((t) => t.id.toLowerCase() === wanted || t.name.toLowerCase() === wanted);
    if (match) return match;
    throw new Error(
      `No signing team matches "${preferred}". Available: ${teams.map((t) => `${t.name} (${t.id})`).join(", ")}.`,
    );
  }
  return teams[0]!;
}

/** A USB-connected iPhone and whether it is ready to automate. */
export interface IosDevice {
  udid: string;
  name: string;
  osVersion: string | undefined;
  developerModeEnabled: boolean;
  connected: boolean;
  /** Set when the device cannot be driven yet; a sentence for the user. */
  blocker: string | undefined;
}

interface DeviceCtlDevice {
  hardwareProperties?: { udid?: string; platform?: string; deviceType?: string };
  deviceProperties?: { name?: string; osVersionNumber?: string; developerModeStatus?: string };
  connectionProperties?: { transportType?: string; tunnelState?: string; pairingState?: string };
}

/** Lists iPhones known to `devicectl`, each annotated with its blocker if any. */
export async function discoverIosDevices(): Promise<IosDevice[]> {
  let json: { result?: { devices?: DeviceCtlDevice[] } };
  try {
    const { stdout } = await run(
      "xcrun",
      ["devicectl", "list", "devices", "--quiet", "--json-output", "/dev/stdout"],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    json = JSON.parse(stripDevicectlChrome(stdout));
  } catch {
    return [];
  }

  const devices: IosDevice[] = [];
  for (const raw of json.result?.devices ?? []) {
    const hw = raw.hardwareProperties ?? {};
    const dp = raw.deviceProperties ?? {};
    const cp = raw.connectionProperties ?? {};
    if (hw.platform !== "iOS" || hw.deviceType !== "iPhone" || !hw.udid) continue;

    const connected = cp.transportType === "wired" || cp.transportType === "localNetwork";
    const developerModeEnabled = dp.developerModeStatus === "enabled";
    devices.push({
      udid: hw.udid,
      name: dp.name ?? hw.udid,
      osVersion: dp.osVersionNumber,
      developerModeEnabled,
      connected,
      blocker: deviceBlocker(cp.transportType, cp.pairingState, developerModeEnabled),
    });
  }
  return devices;
}

function deviceBlocker(
  transport: string | undefined,
  pairing: string | undefined,
  developerMode: boolean,
): string | undefined {
  if (transport !== "wired" && transport !== "localNetwork") {
    return "Not connected. Plug the iPhone in with a cable and unlock it.";
  }
  if (pairing !== "paired") return "Not paired. Unlock the iPhone and tap Trust when it asks.";
  if (!developerMode) return "Developer Mode is off. Turn it on: Settings > Privacy & Security > Developer Mode.";
  return undefined;
}

/** devicectl sometimes prefixes the JSON file with a human line; keep from the first brace. */
function stripDevicectlChrome(output: string): string {
  const start = output.indexOf("{");
  return start >= 0 ? output.slice(start) : output;
}
