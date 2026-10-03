import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type { Approver, ApprovalRequest } from "./core/index.js";

export function approvalMessage(request: ApprovalRequest): string {
  return `${request.device.name}: ${request.reason}\n\nAllow the agent to ${request.action.replace("_", " ")}${
    request.label ? ` "${request.label}"` : ""
  }?`;
}

/** Native macOS dialog. Works with any MCP client, including ones without elicitation. */
export function macDialogApprover(timeoutSeconds = 120): Approver {
  return (request) =>
    new Promise((resolve) => {
      const message = approvalMessage(request).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const script = `display dialog "${message}" with title "agentthumbs" buttons {"Deny", "Allow"} default button "Deny" cancel button "Deny" with icon caution giving up after ${timeoutSeconds}`;
      execFile("osascript", ["-e", script], (error, stdout) => {
        resolve(!error && stdout.includes("button returned:Allow") && !stdout.includes("gave up:true"));
      });
    });
}

/** Asks on the terminal. Only for interactive CLI use. */
export function ttyApprover(): Approver {
  return async (request) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await rl.question(`${approvalMessage(request)} [y/N] `);
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}
