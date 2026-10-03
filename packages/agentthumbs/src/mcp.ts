import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PolicyError, type Approver, type PolicyConfig } from "./core/index.js";
import { macDialogApprover } from "./approval.js";
import { canElicit, elicitationApprover } from "./elicit.js";
import { LocalPhoneService } from "./service.js";
import { createAgentThumbs } from "./setup.js";
import { INSTRUCTIONS, registerPhoneTools, VERSION } from "./tools.js";

export type ApprovalMode = "auto" | "elicit" | "dialog" | "off";

export interface McpOptions {
  /**
   * auto: MCP elicitation when the client supports it, otherwise a macOS dialog.
   * off: never ask (publish-like taps go straight through).
   */
  approval?: ApprovalMode;
  policy?: Partial<PolicyConfig>;
}

/** MCP over stdio, driving phones attached to this machine. */
export async function runMcpServer(options: McpOptions = {}): Promise<void> {
  const mode = options.approval ?? "auto";
  const server = new McpServer({ name: "agentthumbs", version: VERSION }, { instructions: INSTRUCTIONS });
  const elicit = elicitationApprover(server);
  const dialog = macDialogApprover();

  const approver: Approver | undefined =
    mode === "off"
      ? undefined
      : async (request) => {
          if ((mode === "auto" || mode === "elicit") && canElicit(server)) return elicit(request);
          if ((mode === "auto" || mode === "dialog") && process.platform === "darwin") return dialog(request);
          throw new PolicyError(
            "APPROVAL_UNAVAILABLE",
            `${request.reason} This client cannot show an approval prompt. Ask the user to do this step on the phone themselves.`,
          );
        };

  const pw = createAgentThumbs({
    ...(approver ? { approver } : {}),
    policy: { ...options.policy, ...(mode === "off" ? { requireApproval: false } : {}) },
  });
  registerPhoneTools(server, new LocalPhoneService(pw));
  await server.connect(new StdioServerTransport());
}
