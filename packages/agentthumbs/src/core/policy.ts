import type { DeviceInfo } from "./types.js";

/**
 * Words that commit something visible to the outside world. Tapping an element
 * whose label contains one of these asks a human first. English plus the
 * languages the maintainers test with; extend it through `approvalWords`.
 */
export const DEFAULT_APPROVAL_WORDS: readonly string[] = [
  // English
  "post",
  "share",
  "send",
  "publish",
  "submit",
  "tweet",
  "buy",
  "pay",
  "purchase",
  "checkout",
  "place order",
  "subscribe",
  "delete",
  // Turkish
  "paylaş",
  "gönder",
  "yayınla",
  "satın al",
  "öde",
  "abone ol",
  "sil",
];

export interface PolicyConfig {
  /** Ask a human before tapping anything that matches `approvalWords`. */
  requireApproval: boolean;
  approvalWords: readonly string[];
  /** Also ask before coordinate taps that do not land on any known element. */
  approveUnlabeledTaps: boolean;
  maxActionsPerMinute: number;
  maxActionsPerHour: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  requireApproval: true,
  approvalWords: DEFAULT_APPROVAL_WORDS,
  approveUnlabeledTaps: false,
  maxActionsPerMinute: 30,
  maxActionsPerHour: 600,
};

export interface ApprovalRequest {
  device: DeviceInfo;
  action: string;
  /** The label of the element about to be tapped, if known. */
  label: string | undefined;
  reason: string;
  /** Annotated screenshot the approver can show the human. */
  screenshot?: Buffer;
}

/** Resolves true when a human approved the action. */
export type Approver = (request: ApprovalRequest) => Promise<boolean>;

export type PolicyErrorCode = "APPROVAL_DENIED" | "APPROVAL_UNAVAILABLE" | "RATE_LIMITED";

export class PolicyError extends Error {
  constructor(
    readonly code: PolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

/** Returns the matched word when tapping this label needs approval. */
export function matchApprovalWord(
  label: string | undefined,
  words: readonly string[],
): string | undefined {
  if (!label) return undefined;
  const normalized = fold(label);
  for (const word of words) {
    const escaped = fold(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u");
    if (pattern.test(normalized)) return word;
  }
  return undefined;
}

/**
 * Case- and accent-insensitive form, so "SATIN AL", "Satın al" and "satin al"
 * all compare equal. Turkish dotless and dotted i fold to plain "i".
 */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ı/g, "i")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sliding-window limiter so an agent loop cannot hammer an account. */
export class RateLimiter {
  private readonly timestamps: number[] = [];

  constructor(private readonly config: Pick<PolicyConfig, "maxActionsPerMinute" | "maxActionsPerHour">) {}

  check(now = Date.now()): void {
    this.prune(now);
    const lastMinute = this.timestamps.filter((t) => now - t < 60_000).length;
    if (lastMinute >= this.config.maxActionsPerMinute) {
      throw new PolicyError(
        "RATE_LIMITED",
        `Rate limit: ${this.config.maxActionsPerMinute} actions per minute. Slow down and try again shortly.`,
      );
    }
    if (this.timestamps.length >= this.config.maxActionsPerHour) {
      throw new PolicyError(
        "RATE_LIMITED",
        `Rate limit: ${this.config.maxActionsPerHour} actions per hour. Try again later.`,
      );
    }
  }

  record(now = Date.now()): void {
    this.timestamps.push(now);
  }

  private prune(now: number): void {
    while (this.timestamps.length > 0 && now - this.timestamps[0]! >= 3_600_000) {
      this.timestamps.shift();
    }
  }
}
