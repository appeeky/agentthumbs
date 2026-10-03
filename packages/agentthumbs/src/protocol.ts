/**
 * agentthumbs remote protocol, version 1.
 *
 * A connector runs next to the phones and opens an outbound WebSocket to a
 * relay. The relay sends invocations; the connector runs them on its local
 * phones and answers. Approvals the connector needs travel back to the relay,
 * which asks a human however it likes (MCP elicitation, a dashboard, a push).
 *
 * Every message is one JSON object with a `type`. Unknown types are ignored,
 * so either side can add messages without breaking the other.
 *
 * This file has no imports on purpose: other codebases can copy it verbatim.
 */

export const PROTOCOL_VERSION = 1;

export interface WireDevice {
  id: string;
  name: string;
  platform: "android" | "ios";
  driver: string;
  screen: { width: number; height: number };
}

export interface WireElement {
  id: number;
  label: string;
  role?: string;
  clickable?: boolean;
  x: number;
  y: number;
}

export interface WireObservation {
  device: WireDevice;
  image: { data: string; mimeType: string; width: number; height: number };
  elements: WireElement[];
  /** Model-ready text: the element list and how to target it. */
  description: string;
  takenAt: string;
}

export type WireTarget = { element: number } | { x: number; y: number };

export type Invocation =
  | { method: "devices" }
  | { method: "observe"; device?: string }
  | { method: "tap"; device?: string; target: WireTarget; observe?: boolean }
  | { method: "long_press"; device?: string; target: WireTarget; durationMs?: number; observe?: boolean }
  | { method: "swipe"; device?: string; from: WireTarget; to: WireTarget; durationMs?: number; observe?: boolean }
  | {
      method: "scroll";
      device?: string;
      direction: "up" | "down" | "left" | "right";
      amount?: number;
      observe?: boolean;
    }
  | { method: "type"; device?: string; text: string; observe?: boolean }
  | { method: "key"; device?: string; key: string; observe?: boolean }
  | { method: "open_app"; device?: string; appId: string; observe?: boolean }
  | { method: "list_apps"; device?: string }
  /** `path` on the connector's machine, or `url` for the connector to download. */
  | { method: "push_media"; device?: string; path?: string; url?: string };

export type InvocationResult =
  | { kind: "devices"; devices: WireDevice[]; problems: string[] }
  | { kind: "observation"; observation: WireObservation }
  | { kind: "done"; action: string }
  | { kind: "apps"; apps: Array<{ id: string; name: string }> }
  | { kind: "media"; remotePath: string };

export interface WireError {
  /** APPROVAL_DENIED, APPROVAL_UNAVAILABLE, RATE_LIMITED, or absent for other failures. */
  code?: string;
  message: string;
}

export interface WireApprovalRequest {
  device: WireDevice;
  action: string;
  label?: string;
  reason: string;
  /** Base64 JPEG/PNG of the screen the agent was looking at. */
  screenshot?: string;
  screenshotMimeType?: string;
}

/** Connector → relay. */
export type ConnectorMessage =
  | {
      type: "hello";
      protocol: number;
      connector: { name: string; version: string; platform: string };
      devices: WireDevice[];
      problems: string[];
    }
  | { type: "devices"; devices: WireDevice[]; problems: string[] }
  | { type: "result"; id: string; ok: true; result: InvocationResult }
  | { type: "result"; id: string; ok: false; error: WireError }
  | { type: "approval_request"; id: string; invocationId: string; request: WireApprovalRequest }
  | { type: "pong" };

/** Relay → connector. */
export type RelayMessage =
  | { type: "welcome"; connectorId: string }
  | { type: "invoke"; id: string; invocation: Invocation }
  /** `unavailable` means nobody could be asked, as opposed to a human saying no. */
  | { type: "approval_response"; id: string; approved: boolean; unavailable?: string }
  | { type: "ping" };
