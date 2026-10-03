import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { describeObservation, AgentThumbs, PolicyError, type AgentThumbsOptions } from "../../src/core/index.js";
import { element, FakeDriver, provider } from "./fake-driver.js";

const fastSettle = { initialDelayMs: 0, timeoutMs: 0, changeTimeoutMs: 0 };

function setup(options: Partial<AgentThumbsOptions> = {}) {
  const driver = new FakeDriver([element("Search", 100, 200), element("Post", 800, 2200)]);
  const pw = new AgentThumbs({ providers: [provider(driver)], settle: fastSettle, ...options });
  return { driver, pw };
}

describe("DeviceSession", () => {
  it("scales screenshots and reports element centers in image space", async () => {
    const { pw } = setup();
    const session = await pw.device();
    const observation = await session.observe();
    expect(observation.image.height).toBe(1280);
    expect(observation.image.width).toBe(576);
    expect(observation.elements[0]).toMatchObject({ id: 1, label: "Search", x: 107, y: 133 });
    expect(describeObservation(observation)).toContain('[2] "Post" (clickable)');
  });

  it("maps image coordinates back to native pixels", async () => {
    const { driver, pw } = setup();
    const session = await pw.device();
    await session.observe();
    await session.tap({ x: 288, y: 640 }, { observe: false });
    expect(driver.calls.at(-1)).toEqual({ method: "tap", args: [{ x: 540, y: 1200 }] });
  });

  it("taps elements by id at their native center", async () => {
    const { driver, pw } = setup();
    const session = await pw.device();
    await session.observe();
    const result = await session.tap({ element: 1 });
    expect(driver.calls.at(-1)).toEqual({ method: "tap", args: [{ x: 200, y: 250 }] });
    expect(result.observation?.elements).toHaveLength(2);
  });

  it("refuses element ids from a stale observation", async () => {
    const { pw } = setup();
    const session = await pw.device();
    await session.observe();
    await session.key("home", { observe: false });
    await expect(session.tap({ element: 1 })).rejects.toThrow(/Observe again/);
  });

  it("refuses publish-like taps without an approver", async () => {
    const { driver, pw } = setup();
    const session = await pw.device();
    await session.observe();
    await expect(session.tap({ element: 2 })).rejects.toBeInstanceOf(PolicyError);
    expect(driver.calls).toHaveLength(0);
  });

  it("gates coordinate taps that land on a publish-like element", async () => {
    const { driver, pw } = setup();
    const session = await pw.device();
    await session.observe();
    // (900, 2250) native sits inside "Post"; image scale is 2400/1280.
    await expect(session.tap({ x: 480, y: 1200 })).rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    expect(driver.calls).toHaveLength(0);
  });

  it("asks the approver and respects its answer", async () => {
    const answers = [false, true];
    const asked: Array<string | undefined> = [];
    const { driver, pw } = setup({
      approver: async (request) => {
        asked.push(request.label);
        return answers.shift()!;
      },
    });
    const session = await pw.device();
    await session.observe();
    await expect(session.tap({ element: 2 })).rejects.toMatchObject({ code: "APPROVAL_DENIED" });
    await session.tap({ element: 2 }, { observe: false });
    expect(asked).toEqual(["Post", "Post"]);
    expect(driver.calls).toEqual([{ method: "tap", args: [{ x: 900, y: 2250 }] }]);
  });

  it("can turn approvals off", async () => {
    const { driver, pw } = setup({ policy: { requireApproval: false } });
    const session = await pw.device();
    await session.observe();
    await session.tap({ element: 2 }, { observe: false });
    expect(driver.calls).toHaveLength(1);
  });

  it("scrolls with the finger moving against the content direction", async () => {
    const { driver, pw } = setup();
    const session = await pw.device();
    await session.scroll("down", 0.5, { observe: false });
    const [from, to] = driver.calls.at(-1)!.args as Array<{ x: number; y: number }>;
    expect(from!.y).toBeGreaterThan(to!.y);
  });

  it("rejects keys the driver does not support", async () => {
    const { pw } = setup();
    const session = await pw.device();
    await expect(session.key("volume_up")).rejects.toThrow(/does not support/);
  });

  it("serializes actions on one device", async () => {
    const { driver, pw } = setup();
    const session = await pw.device();
    await Promise.all([
      session.type("a", { observe: false }),
      session.type("b", { observe: false }),
      session.type("c", { observe: false }),
    ]);
    expect(driver.calls.map((c) => c.args[0])).toEqual(["a", "b", "c"]);
  });
});

/** A phone whose screen turns black 600 ms after a tap, like a screen transition that starts late. */
class SlowTransitionDriver extends FakeDriver {
  private changeAt = Number.POSITIVE_INFINITY;
  override async tap(point: { x: number; y: number }) {
    await super.tap(point);
    this.changeAt = Date.now() + 600;
  }
  override async screenshot(): Promise<Buffer> {
    const background = Date.now() >= this.changeAt ? "#000000" : "#ffffff";
    return sharp({ create: { width: 1080, height: 2400, channels: 3, background } }).png().toBuffer();
  }
}

describe("settling after an action", () => {
  it("waits for a late screen change instead of returning the old screen", async () => {
    const driver = new SlowTransitionDriver([element("Next", 100, 200)]);
    const pw = new AgentThumbs({ providers: [provider(driver)] });
    const session = await pw.device();
    await session.observe();

    const { observation } = await session.tap({ element: 1 });

    const { channels } = await sharp(observation!.image.data).stats();
    expect(channels[0]!.mean).toBeLessThan(50);
  });

  it("does not wait for a change when the action is not observed", async () => {
    const driver = new SlowTransitionDriver([element("Next", 100, 200)]);
    const pw = new AgentThumbs({ providers: [provider(driver)] });
    const session = await pw.device();
    await session.observe();

    const started = Date.now();
    await session.tap({ element: 1 }, { observe: false });
    expect(Date.now() - started).toBeLessThan(300);
  });
});
