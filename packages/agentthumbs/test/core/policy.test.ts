import { describe, expect, it } from "vitest";
import { DEFAULT_APPROVAL_WORDS, matchApprovalWord, PolicyError, RateLimiter } from "../../src/core/index.js";

describe("matchApprovalWord", () => {
  it.each([
    ["Post", "post"],
    ["Share to Story", "share"],
    ["Paylaş", "paylaş"],
    ["SATIN AL", "satın al"],
    ["Send message", "send"],
  ])("gates %s", (label, word) => {
    expect(matchApprovalWord(label, DEFAULT_APPROVAL_WORDS)).toBe(word);
  });

  it.each(["Posts", "Sender", "Search", "Silver", "Payment history tab"])("allows %s", (label) => {
    expect(matchApprovalWord(label, DEFAULT_APPROVAL_WORDS)).toBeUndefined();
  });

  it("ignores missing labels", () => {
    expect(matchApprovalWord(undefined, DEFAULT_APPROVAL_WORDS)).toBeUndefined();
  });
});

describe("RateLimiter", () => {
  it("refuses once the per-minute budget is spent and recovers after", () => {
    const limiter = new RateLimiter({ maxActionsPerMinute: 2, maxActionsPerHour: 100 });
    limiter.record(0);
    limiter.record(1_000);
    expect(() => limiter.check(2_000)).toThrow(PolicyError);
    expect(() => limiter.check(61_001)).not.toThrow();
  });

  it("enforces the hourly budget", () => {
    const limiter = new RateLimiter({ maxActionsPerMinute: 100, maxActionsPerHour: 3 });
    for (const t of [0, 120_000, 240_000]) limiter.record(t);
    expect(() => limiter.check(300_000)).toThrow(/per hour/);
    expect(() => limiter.check(3_600_001)).not.toThrow();
  });
});
