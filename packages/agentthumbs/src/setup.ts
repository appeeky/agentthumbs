import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentThumbs, type Approver, type PolicyConfig } from "./core/index.js";
import { AdbProvider } from "./drivers/adb/index.js";
import { MirroringProvider, VisionOcrSource } from "./drivers/mirroring/index.js";
import { WdaProvider, type WdaProviderOptions } from "./drivers/wda/index.js";

/** Local state: action logs and the CLI's last observation per device. */
export const HOME = process.env.AGENTTHUMBS_HOME ?? join(homedir(), ".agentthumbs");

export interface SetupOptions {
  approver?: Approver;
  policy?: Partial<PolicyConfig>;
  /** Options for the WebDriverAgent provider, for example `{ autoStart: true, onLog }` in an app. */
  wda?: WdaProviderOptions;
}

/** An AgentThumbs wired with every driver available on this machine and a JSONL action log. */
export function createAgentThumbs({ approver, policy, wda }: SetupOptions = {}): AgentThumbs {
  const logDir = join(HOME, "logs");
  const ocr = new VisionOcrSource();
  return new AgentThumbs({
    providers: [new AdbProvider(), new WdaProvider(wda), new MirroringProvider()],
    ...(ocr.available ? { elementSource: ocr } : {}),
    ...(approver ? { approver } : {}),
    ...(policy ? { policy } : {}),
    onAction: (entry) => {
      try {
        mkdirSync(logDir, { recursive: true });
        appendFileSync(join(logDir, `${entry.at.slice(0, 10)}.jsonl`), `${JSON.stringify(entry)}\n`);
      } catch {
        // Logging must never break an action.
      }
    },
  });
}
