import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const iosSetup = vi.hoisted(() => ({
  devices: [] as Array<{ udid: string; name: string; blocker: string | undefined }>,
}));
const wda = vi.hoisted(() => ({
  /** Ports where a WebDriverAgent answers. */
  live: new Set<number>(),
  started: [] as Array<{ udid: string; port: number }>,
}));

vi.mock("../../../src/drivers/wda/ios-setup.js", () => ({
  discoverIosDevices: async () =>
    iosSetup.devices.map((d) => ({ ...d, osVersion: "18.0", developerModeEnabled: !d.blocker, connected: true })),
  findSigningTeams: async () => [{ id: "TEAM123456", name: "Team", identity: "x", expires: undefined }],
  pickTeam: (teams: Array<{ id: string }>) => teams[0],
  NoSigningTeamError: class extends Error {},
}));

vi.mock("../../../src/drivers/wda/wda-runner.js", () => ({
  WdaRunner: class {
    constructor(private readonly options: { udid: string; port: number }) {}
    get baseUrl() {
      return `http://127.0.0.1:${this.options.port}`;
    }
    async start() {
      wda.started.push({ udid: this.options.udid, port: this.options.port });
      wda.live.add(this.options.port);
    }
    stop() {
      wda.live.delete(this.options.port);
    }
  },
}));

const { WdaProvider } = await import("../../../src/drivers/wda/driver.js");

function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!wda.live.has(Number(url.port))) return Promise.reject(new Error("ECONNREFUSED"));
  const value =
    url.pathname === "/wda/screen" ? { screenSize: { width: 402, height: 874 }, scale: 3 } : { ready: true };
  return Promise.resolve(new Response(JSON.stringify({ value }), { headers: { "content-type": "application/json" } }));
}

beforeEach(() => {
  iosSetup.devices = [];
  wda.live.clear();
  wda.started = [];
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WdaProvider auto-start", () => {
  it("starts every ready iPhone on its own port and names each one", async () => {
    iosSetup.devices = [
      { udid: "A", name: "Alpha", blocker: undefined },
      { udid: "B", name: "Bravo", blocker: undefined },
      { udid: "C", name: "Charlie", blocker: "Developer Mode is off." },
    ];
    const provider = new WdaProvider({ autoStart: true });

    const drivers = await provider.discover();

    expect(wda.started).toEqual([
      { udid: "A", port: 8100 },
      { udid: "B", port: 8101 },
    ]);
    expect(drivers.map((d) => [d.info.id, d.info.name])).toEqual([
      ["wda:127.0.0.1:8100", "Alpha"],
      ["wda:127.0.0.1:8101", "Bravo"],
    ]);
  });

  it("leaves the iPhones alone when a WebDriverAgent already answers at the configured URL", async () => {
    iosSetup.devices = [{ udid: "A", name: "Alpha", blocker: undefined }];
    wda.live.add(8100);
    const provider = new WdaProvider({ autoStart: true });

    const drivers = await provider.discover();

    expect(wda.started).toEqual([]);
    expect(drivers.map((d) => d.info.id)).toEqual(["wda:127.0.0.1:8100"]);
  });

  it("starts only the iPhone named by udid", async () => {
    iosSetup.devices = [
      { udid: "A", name: "Alpha", blocker: undefined },
      { udid: "B", name: "Bravo", blocker: undefined },
    ];
    const provider = new WdaProvider({ autoStart: true, udid: "B" });

    await provider.discover();

    expect(wda.started).toEqual([{ udid: "B", port: 8100 }]);
  });

  it("restarts an iPhone whose WebDriverAgent stopped answering", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      iosSetup.devices = [{ udid: "A", name: "Alpha", blocker: undefined }];
      const provider = new WdaProvider({ autoStart: true });
      await provider.discover();

      wda.live.delete(8100);
      vi.setSystemTime(Date.now() + 31_000);
      const drivers = await provider.discover();

      expect(wda.started).toEqual([
        { udid: "A", port: 8100 },
        { udid: "A", port: 8100 },
      ]);
      expect(drivers).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not auto-start when it is off", async () => {
    iosSetup.devices = [{ udid: "A", name: "Alpha", blocker: undefined }];
    const provider = new WdaProvider();

    expect(await provider.discover()).toEqual([]);
    expect(wda.started).toEqual([]);
  });
});
