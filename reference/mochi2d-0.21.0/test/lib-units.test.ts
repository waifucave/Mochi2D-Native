/**
 * Pure parts of the browser library: gesture recognition, device profiles
 * and texture budgets, CSS colors, the event emitter.
 */
import { describe, expect, it } from "vitest";
import { GestureTracker, type GestureHandlers, type PressInfo } from "../src/lib/gestures.js";
import {
  CONSTRAINED_TEXTURE_BUDGET,
  DEFAULT_TEXTURE_BUDGET,
  defaultMaxPixelRatio,
  deviceProfile,
  parseTextureBudget,
  resolveTextureBudget,
} from "../src/lib/texture-budget.js";
import { parseCssColor } from "../src/lib/view.js";
import { Emitter } from "../src/lib/events.js";
import { planTextureSizes } from "../src/render/texture/budget.js";

const touch: PressInfo = { button: 0, shift: false, pointerType: "touch" };

function recorder(mode: "look" | "pan" | "none" = "look") {
  const log: string[] = [];
  const h: GestureHandlers = {
    press: (x, y) => (log.push(`press ${x},${y}`), mode),
    drag: (x, y, dx, dy, m) => log.push(`drag ${m} ${x},${y} by ${dx},${dy}`),
    release: (m) => log.push(`release ${m}`),
    tap: (x, y) => log.push(`tap ${x},${y}`),
    doubleTap: (x, y) => log.push(`double ${x},${y}`),
    pinch: (f, cx, cy, dx, dy) => log.push(`pinch ${f.toFixed(3)} at ${cx},${cy} by ${dx},${dy}`),
    wheel: (f, x, y) => log.push(`wheel ${f.toFixed(4)} at ${x},${y}`),
    hover: (x, y) => log.push(`hover ${x},${y}`),
    leave: () => log.push("leave"),
  };
  return { log, h };
}

describe("GestureTracker", () => {
  it("tells taps from drags, and double taps from two taps", () => {
    const { log, h } = recorder();
    const g = new GestureTracker(h);
    g.down(1, 100, 100, 0, touch);
    g.move(1, 103, 101); // within the slop: still a tap
    g.up(1, 120);
    g.down(1, 104, 102, 300, touch);
    g.up(1, 380); // second tap close by within 350 ms
    g.down(1, 104, 102, 1000, touch);
    g.move(1, 150, 102); // beyond the slop: a drag
    g.up(1, 1100);
    expect(log).toEqual([
      "press 100,100",
      "drag look 103,101 by 3,1",
      "release look",
      "tap 103,101",
      "press 104,102",
      "release look",
      "double 104,102",
      "press 104,102",
      "drag look 150,102 by 46,0",
      "release look",
    ]);
  });

  it("does not tap after a long press or a cancel", () => {
    const { log, h } = recorder("none");
    const g = new GestureTracker(h);
    g.down(1, 10, 10, 0, touch);
    g.up(1, 900);
    g.down(2, 10, 10, 2000, touch);
    g.cancel(2);
    expect(log).toEqual(["press 10,10", "press 10,10"]);
  });

  it("turns two fingers into a pinch and ends the drag", () => {
    const { log, h } = recorder("pan");
    const g = new GestureTracker(h);
    g.down(1, 100, 100, 0, touch);
    g.down(2, 200, 100, 10, touch);
    g.move(2, 300, 100); // distance 100 → 200, center 150 → 200
    g.move(1, 120, 100); // distance 200 → 180, center 200 → 210
    g.up(1, 200);
    g.move(2, 400, 100); // one finger left: nothing
    g.up(2, 300);
    expect(log).toEqual([
      "press 100,100",
      "release pan",
      "pinch 2.000 at 200,100 by 50,0",
      "pinch 0.900 at 210,100 by 10,0",
    ]);
  });

  it("zooms on the wheel, hovers without buttons, scales its thresholds", () => {
    const { log, h } = recorder();
    const g = new GestureTracker(h);
    g.wheel(100, 5, 6, false);
    g.wheel(-10, 5, 6, true);
    g.hover(7, 8);
    g.leave();
    g.setScale(2);
    g.down(1, 0, 0, 0, touch);
    g.move(1, 10, 0); // 10 < 6 × 2: still a tap
    g.up(1, 50);
    expect(log).toEqual([
      `wheel ${Math.exp(-0.15).toFixed(4)} at 5,6`,
      `wheel ${Math.exp(0.1).toFixed(4)} at 5,6`,
      "hover 7,8",
      "leave",
      "press 0,0",
      "drag look 10,0 by 10,0",
      "release look",
      "tap 10,0",
    ]);
  });
});

describe("device profiles and texture budgets", () => {
  const iphone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const ipadDesktop =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const android =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
  const desktop =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

  it("classifies devices", () => {
    expect(deviceProfile({ userAgent: iphone, maxTouchPoints: 5 })).toEqual({
      mobile: true,
      constrained: true,
      reason: "iPhone",
    });
    expect(
      deviceProfile({ userAgent: ipadDesktop, platform: "MacIntel", maxTouchPoints: 5 }).reason,
    ).toBe("iPad");
    expect(
      deviceProfile({ userAgent: ipadDesktop, platform: "MacIntel", maxTouchPoints: 0 }),
    ).toEqual({ mobile: false, constrained: false, reason: "desktop" });
    expect(deviceProfile({ userAgent: android, mobile: true }).reason).toBe("mobile device");
    expect(deviceProfile({ userAgent: desktop, deviceMemory: 4 })).toEqual({
      mobile: false,
      constrained: true,
      reason: "4 GiB device memory",
    });
    expect(deviceProfile({ userAgent: desktop, deviceMemory: 8 }).constrained).toBe(false);
    expect(deviceProfile({}).constrained).toBe(false);
  });

  it("resolves budget settings", () => {
    const phone = deviceProfile({ userAgent: iphone });
    const pc = deviceProfile({ userAgent: desktop });
    expect(resolveTextureBudget("auto", phone)).toEqual({
      bytes: CONSTRAINED_TEXTURE_BUDGET,
      label: "256 MiB (auto: iPhone)",
    });
    expect(resolveTextureBudget("auto", pc).bytes).toBe(DEFAULT_TEXTURE_BUDGET);
    expect(resolveTextureBudget("full", phone)).toEqual({ bytes: undefined, label: "full size" });
    expect(resolveTextureBudget(512, phone).bytes).toBe(512 * 1024 * 1024);
    expect(() => resolveTextureBudget(-1, phone)).toThrow(RangeError);
    expect(parseTextureBudget("256")).toBe(256);
    expect(parseTextureBudget("full")).toBe("full");
    expect(parseTextureBudget(null)).toBe("auto");
    expect(parseTextureBudget("nonsense")).toBe("auto");
    expect(defaultMaxPixelRatio(phone)).toBe(2);
    expect(defaultMaxPixelRatio(pc)).toBe(Infinity);
  });

  it("fits DeepSeek-chan's textures into the phone budget", () => {
    // The five textures of DeepSeek/大肥鱼.4096 (about 789 MiB with mip chains).
    const sizes = [
      { width: 4096, height: 8192 },
      { width: 4096, height: 8192 },
      { width: 2048, height: 2048 },
      { width: 8192, height: 8192 },
      { width: 4096, height: 4096 },
    ];
    const bytes = (p: { width: number; height: number }) => {
      let n = 0;
      for (let w = p.width, h = p.height; ; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
        n += w * h * 4;
        if (w === 1 && h === 1) break;
      }
      return n;
    };
    const full = sizes.reduce((n, s) => n + bytes(s), 0);
    expect(full / 2 ** 20).toBeCloseTo(789.3, 0);
    const planned = planTextureSizes(sizes, {
      maxSize: 16384,
      budgetBytes: CONSTRAINED_TEXTURE_BUDGET,
      mipmaps: true,
    });
    const total = planned.reduce((n, s) => n + bytes(s), 0);
    expect(total).toBeLessThanOrEqual(CONSTRAINED_TEXTURE_BUDGET);
    expect(total).toBeGreaterThan(0.9 * CONSTRAINED_TEXTURE_BUDGET);
    // One factor for all: the 8192² texture keeps its aspect ratio.
    expect(planned[3]!.width).toBe(planned[3]!.height);
    expect(planned[3]!.width).toBeLessThan(8192);
  });
});

describe("parseCssColor and Emitter", () => {
  it("parses colors", () => {
    expect(parseCssColor("transparent")).toBeNull();
    expect(parseCssColor("#fff")).toEqual([1, 1, 1]);
    expect(parseCssColor("#336699")).toEqual([0x33 / 255, 0x66 / 255, 0x99 / 255]);
    expect(parseCssColor("rgb(255, 0, 51)")).toEqual([1, 0, 51 / 255]);
    expect(parseCssColor("rgba(1, 2, 3, 0)")).toBeNull();
    expect(parseCssColor("rgb(10 20 30 / 0.5)")).toEqual([10 / 255, 20 / 255, 30 / 255]);
  });

  it("emits, removes and survives throwing listeners", async () => {
    const e = new Emitter<{ a: number; b: string }>();
    const got: string[] = [];
    const off = e.on("a", (n) => got.push(`a${n}`));
    e.once("b", (s) => got.push(`b${s}`));
    e.on("a", () => {
      throw new Error("listener error");
    });
    const errors: unknown[] = [];
    const handler = (err: unknown) => errors.push(err);
    process.on("uncaughtException", handler);
    e.emit("a", 1);
    e.emit("b", "x");
    e.emit("b", "y");
    off();
    e.emit("a", 2);
    await new Promise((r) => setTimeout(r, 0));
    process.off("uncaughtException", handler);
    expect(got).toEqual(["a1", "bx"]);
    expect(e.has("a")).toBe(true);
    expect(errors).toHaveLength(2);
  });
});
