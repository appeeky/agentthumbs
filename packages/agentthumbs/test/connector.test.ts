import { describe, expect, it, vi } from "vitest";
import { AgentThumbs, PolicyError, type ApprovalRequest } from "../src/core/index.js";
import { Connector } from "../src/connector.js";

const request: ApprovalRequest = {
  device: { id: "adb:x", name: "x", platform: "android", driver: "adb", screen: { width: 1, height: 1 } },
  action: "tap",
  label: "Post",
  reason: 'Tapping "Post" may publish, send or pay for something.',
};

describe("Connector with a shared AgentThumbs", () => {
  it("sends local actions to the fallback approver", async () => {
    const thumbs = new AgentThumbs({ providers: [] });
    const connector = new Connector({ relayUrl: "ws://127.0.0.1:1", token: "t", thumbs });
    const fallback = vi.fn(async () => true);

    await expect(connector.approver(fallback)(request)).resolves.toBe(true);
    expect(fallback).toHaveBeenCalledWith(request);
  });

  it("refuses local actions when there is no fallback", async () => {
    const connector = new Connector({ relayUrl: "ws://127.0.0.1:1", token: "t", thumbs: new AgentThumbs({ providers: [] }) });

    await expect(connector.approver()(request)).rejects.toBeInstanceOf(PolicyError);
  });
});
