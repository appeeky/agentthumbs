import { describe, expect, it } from "vitest";
import { escapeInputText, parseDevices, parseUiAutomator, parseWmSize, quote } from "../../../src/drivers/adb/index.js";

const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" class="android.widget.FrameLayout" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
    <node index="0" text="Inbox &amp; Updates" class="android.widget.TextView" clickable="false" enabled="true" bounds="[40,100][600,180]" />
    <node index="1" text="" resource-id="com.app:id/compose" class="android.widget.LinearLayout" clickable="true" enabled="true" bounds="[40,300][1040,420]">
      <node index="0" text="" class="android.widget.ImageView" clickable="false" bounds="[40,300][140,420]" />
      <node index="1" text="Paylaş" class="android.widget.TextView" clickable="false" bounds="[160,300][600,420]" />
    </node>
    <node index="2" text="" content-desc="" resource-id="com.app:id/send_button" class="android.widget.ImageButton" clickable="true" enabled="false" bounds="[900,2200][1040,2340]" />
    <node index="3" text="" hint="Add a caption" class="android.widget.EditText" clickable="true" bounds="[40,500][1040,600]" />
    <node index="4" text="zero" class="android.widget.TextView" bounds="[10,10][10,10]" />
  </node>
</hierarchy>`;

describe("parseUiAutomator", () => {
  const elements = parseUiAutomator(DUMP);

  it("labels clickable containers with their children's text", () => {
    expect(elements.find((e) => e.label === "Paylaş")).toMatchObject({
      clickable: true,
      rect: { x: 40, y: 300, width: 1000, height: 120 },
    });
  });

  it("falls back to the resource id for icon buttons", () => {
    expect(elements.find((e) => e.label === "send button")).toMatchObject({ role: "button", enabled: false });
  });

  it("uses hints for empty text fields", () => {
    expect(elements.find((e) => e.label === "Add a caption")).toMatchObject({ role: "text field" });
  });

  it("keeps unclaimed text, decodes entities and drops empty bounds", () => {
    expect(elements.find((e) => e.label === "Inbox & Updates")).toMatchObject({ clickable: false });
    expect(elements.some((e) => e.label === "zero")).toBe(false);
    expect(elements).toHaveLength(4);
  });
});

describe("adb output parsing", () => {
  it("reads devices", () => {
    const out =
      "List of devices attached\nemulator-5554          device product:sdk model:sdk_gphone64_arm64 transport_id:1\nR5CT offline\n\n";
    expect(parseDevices(out)).toEqual([
      { serial: "emulator-5554", state: "device", model: "sdk gphone64 arm64" },
      { serial: "R5CT", state: "offline" },
    ]);
  });

  it("prefers the override screen size", () => {
    expect(parseWmSize("Physical size: 1080x2400\nOverride size: 720x1600")).toEqual({ width: 720, height: 1600 });
    expect(parseWmSize("Physical size: 1080x2400")).toEqual({ width: 1080, height: 2400 });
  });

  it("escapes text for input and the remote shell", () => {
    expect(escapeInputText("hello world 100%")).toBe("hello%sworld%s100%");
    expect(quote("it's")).toBe(`'it'\\''s'`);
    expect(quote("tap")).toBe("tap");
  });
});
