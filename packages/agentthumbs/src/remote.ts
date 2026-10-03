/**
 * The remote side of agentthumbs without drivers or native modules: protocol
 * types, MCP tools over any PhoneService, and the relay. Import this from
 * servers that relay phones but never touch one ("@appeeky/agentthumbs/remote").
 */
export * from "./protocol.js";
export { errorCode, fromWireError, InvocationError, toWireError } from "./errors.js";
export { canElicit, elicitApproval } from "./elicit.js";
export {
  INSTRUCTIONS,
  registerPhoneTools,
  toToolResult,
  VERSION,
  type PhoneService,
  type RegisterPhoneToolsOptions,
  type ToolHost,
} from "./tools.js";
export {
  DEFAULT_TENANT,
  RelayHub,
  runRelay,
  tokensMatch,
  type ConnectorInfo,
  type InvokeOptions,
  type RelayHubOptions,
  type RelayServerOptions,
} from "./relay.js";
