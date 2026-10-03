import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApprovalRequest, Approver } from "./core/index.js";
import { approvalMessage } from "./approval.js";

export function canElicit(server: McpServer): boolean {
  return Boolean(server.server.getClientCapabilities()?.elicitation);
}

/** Asks the human a yes/no question through MCP elicitation on this server's client. */
export async function elicitApproval(server: McpServer, message: string): Promise<boolean> {
  const result = await server.server.elicitInput({
    message,
    requestedSchema: {
      type: "object",
      properties: { approve: { type: "boolean", title: "Allow this action" } },
      required: ["approve"],
    },
  });
  return result.action === "accept" && result.content?.approve === true;
}

/** An Approver that asks through MCP elicitation on this server's client. */
export function elicitationApprover(server: McpServer): Approver {
  return (request: ApprovalRequest) => elicitApproval(server, approvalMessage(request));
}
