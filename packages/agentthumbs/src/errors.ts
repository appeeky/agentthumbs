import type { WireError } from "./protocol.js";

/** An error that keeps its policy code (APPROVAL_DENIED, RATE_LIMITED, …) across the wire. */
export class InvocationError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "InvocationError";
  }
}

/** Policy errors from the core runtime and InvocationErrors both carry a string `code`. */
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export function toWireError(error: unknown): WireError {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  return code ? { code, message } : { message };
}

export function fromWireError(error: WireError): InvocationError {
  return new InvocationError(error.message, error.code);
}
