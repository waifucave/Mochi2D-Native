/**
 * Lip sync from live audio (not reference behavior), with
 * synthetic sample streams: the 3s.2 measure on pushed samples, the noise
 * gate, the gain and the attack and release smoothing; then the frame
 * procedure and the runtime on DeepSeek-chan, where lip sync drives the
 * `ParamMouthOpenY` fallback.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { LipSync, decodeWav } from "../src/anim/lip-sync.js";
import {
  LIVE_LIP_SYNC_DEFAULTS,
  LIVE_LIP_SYNC_NEUTRAL,
  LIVE_SILENCE_AFTER,
  LiveLipSync,
  dbfsToAmplitude,
} from "../src/anim/live-lip-sync.js";
import { AnimationValues } from "../src/anim/values.js";
import type { ModelRuntime } from "../src/runtime/model-runtime.js";
import { loadModelFromDisk } from "../src/lib/node.js";
import { LiveAudioError, liveAudioError, liveAudioProblem } from "../src/platform/live-audio.js";
import { LiveInputs } from "../src/lib/live-lip-sync.js";
import { deepseekModel, wav16 } from "./support/anim.js";
import { Synth } from "./support/synth.js";
import { loadMoc } from "../src/core/moc/model.js";
import { DEEPSEEK, HAVE_DEEPSEEK } from "./support/deepseek.js";

const deepseek = join(DEEPSEEK, "大肥鱼.model3.json");

/** A deterministic pseudo-random sequence in [−1, 1). */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  };
}

/** n samples of constant magnitude a (alternating sign): the RMS of any window is exactly a. */
const square = (a: number, n: number) =>
  Float32Array.from({ length: n }, (_, i) => (i & 1 ? -a : a));

describe("the live measure and mapping", () => {
  it.skipIf(!HAVE_DEEPSEEK)(
    "equals 3s.2 with neutral settings when a frame gets exactly its window",
    () => {
      // A stereo WAV: a sine on the left, noise on the right.
      const rate = 44100;
      const rnd = noise(7);
      const frames = 2 * rate;
      const interleaved: number[] = [];
      for (let i = 0; i < frames; i++)
        interleaved.push(0.5 * Math.sin((2 * Math.PI * 220 * i) / rate), 0.2 * rnd());
      const sound = decodeWav(wav16(interleaved, rate, 2));
      const values = new AnimationValues(deepseekModel());
      const ref = new LipSync(["ParamMouthOpenY"]);
      ref.start(sound);
      const live = new LiveLipSync(rate, LIVE_LIP_SYNC_NEUTRAL);
      // The steps vary; each covers at least one sample.
      const steps = [1 / 60, 1 / 30, 1 / 144, 0.0213, 1 / 60, 1 / 120, 0.05, 1 / 60];
      let t = 0;
      let position = 0;
      let checked = 0;
      for (let f = 0; f < 60; f++) {
        const dt = steps[f % steps.length]!;
        ref.frame(dt, values);
        t += dt;
        const g = Math.min(Math.floor(t * rate), frames);
        live.push(sound.samples.map((ch) => ch.subarray(position, g)));
        position = g;
        expect(live.next(dt)).toBe(ref.value);
        expect(live.level).toBe(ref.value);
        checked++;
      }
      expect(checked).toBe(60);
      // A frame with no new sample: 3s.2 gives NaN (no write); the live value holds.
      ref.frame(0, values);
      expect(ref.value).toBeNaN();
      const held = live.value;
      expect(live.next(0)).toBe(held);
    },
  );

  it("measures the blocks a tap delivered since the previous frame, all channels pooled", () => {
    const rate = 48000;
    const rnd = noise(11);
    const left = Float32Array.from({ length: 4096 }, () => 0.3 * rnd());
    const right = Float32Array.from({ length: 4096 }, () => 0.1 * rnd());
    const live = new LiveLipSync(rate, LIVE_LIP_SYNC_NEUTRAL);
    const expected = (from: number, to: number) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += left[i]! ** 2 + right[i]! ** 2;
      return Math.sqrt(sum / (2 * (to - from)));
    };
    // Six 128-frame blocks as sums of squares (as the AudioWorklet tap sends them), then a frame.
    let pos = 0;
    for (const blocks of [6, 1, 3]) {
      const from = pos;
      for (let b = 0; b < blocks; b++, pos += 128) {
        let sum = 0;
        for (let i = pos; i < pos + 128; i++) sum += left[i]! ** 2 + right[i]! ** 2;
        live.pushSums(sum, 2 * 128, 128);
      }
      expect(live.pending).toBeCloseTo((blocks * 128) / rate, 12);
      expect(live.next(1 / 60)).toBeCloseTo(expected(from, pos), 12);
      expect(live.pending).toBe(0);
    }
    // Raw blocks give the same as their sums.
    const raw = new LiveLipSync(rate, LIVE_LIP_SYNC_NEUTRAL);
    raw.push([left.subarray(0, 100), right.subarray(0, 100)]);
    raw.push([left.subarray(100, 300), right.subarray(100, 300)]);
    expect(raw.next(1 / 60)).toBeCloseTo(expected(0, 300), 12);
    // Empty or invalid blocks are ignored.
    raw.push([]);
    raw.push([new Float32Array(0)]);
    raw.pushSums(NaN, 2, 1);
    raw.pushSums(1, 0, 0);
    expect(raw.pending).toBe(0);
  });

  it("gates, then multiplies by the gain", () => {
    expect(dbfsToAmplitude(-20)).toBeCloseTo(0.1, 15);
    expect(dbfsToAmplitude(-Infinity)).toBe(0);
    expect(dbfsToAmplitude(NaN)).toBe(0);
    const at = (a: number, settings: Partial<typeof LIVE_LIP_SYNC_DEFAULTS>) => {
      const live = new LiveLipSync(48000, { attack: 0, release: 0, ...settings });
      live.push([square(a, 800)]);
      return live.next(1 / 60);
    };
    const s = { gain: 10, gate: -40 }; // gate at an RMS of 0.01
    expect(at(0.005, s)).toBe(0);
    expect(at(0.01, s)).toBe(0);
    expect(at(0.05, s)).toBeCloseTo(10 * (Math.fround(0.05) - 0.01), 12);
    expect(at(0.3, s)).toBeCloseTo(10 * (Math.fround(0.3) - 0.01), 12);
    expect(at(0.5, { gain: 1, gate: -Infinity })).toBe(0.5);
    // Settings that make no sense give 0 or no smoothing, never NaN.
    expect(at(0.3, { gain: NaN })).toBe(0);
    expect(at(0.3, { gain: -2 })).toBe(0);
    expect(at(0, { gain: Infinity })).toBe(0);
    expect(at(0.3, { gate: Infinity })).toBe(0);
    expect(at(0.5, { gain: 1, gate: -Infinity, attack: -1, release: NaN })).toBe(0.5);
  });

  it("smooths with the attack and release time constants, whatever the frame rate", () => {
    const rate = 48000;
    const settings = { gain: 1, gate: -Infinity, attack: 0.05, release: 0.2 };
    for (const fps of [20, 40, 60, 120, 240]) {
      const n = rate / fps; // samples per frame
      const live = new LiveLipSync(rate, settings);
      // 0.05 s of a 0.5 signal: one attack time constant.
      for (let f = 0; f < Math.round(0.05 * fps); f++) {
        live.push([square(0.5, n)]);
        live.next(1 / fps);
      }
      expect(live.value, `attack at ${fps} fps`).toBeCloseTo(0.5 * (1 - Math.exp(-1)), 12);
      // Then silence for one release time constant.
      const v0 = live.value;
      for (let f = 0; f < Math.round(0.2 * fps); f++) {
        live.push([new Float32Array(n)]);
        live.next(1 / fps);
      }
      expect(live.value, `release at ${fps} fps`).toBeCloseTo(v0 * Math.exp(-1), 12);
      expect(live.level).toBe(0);
    }
  });

  it("holds the value over frames without samples, then counts them as silence", () => {
    const fps = 60;
    for (const release of [0, 0.12]) {
      const live = new LiveLipSync(48000, { gain: 1, gate: -Infinity, attack: 0, release });
      live.push([square(0.5, 800)]);
      expect(live.next(1 / fps)).toBe(0.5);
      let idle = 0;
      let frames = 0;
      while (idle + 1 / fps <= LIVE_SILENCE_AFTER) {
        idle += 1 / fps;
        frames++;
        expect(live.next(1 / fps), `held, frame ${frames}`).toBe(0.5);
      }
      expect(frames).toBe(6);
      const v = live.next(1 / fps);
      expect(live.level).toBe(0);
      if (release === 0) expect(v).toBe(0);
      else expect(v).toBeCloseTo(0.5 * Math.exp(-1 / fps / release), 12);
      // Samples arriving again end the silence.
      live.push([square(0.5, 800)]);
      expect(live.next(1 / fps)).toBe(0.5);
    }
  });

  it("drops a backlog longer than the window limit (0.25 s)", () => {
    const rate = 48000;
    const live = new LiveLipSync(rate, LIVE_LIP_SYNC_NEUTRAL);
    live.push([square(0.5, 0.1 * rate)]);
    live.push([new Float32Array(0.1 * rate)]);
    expect(live.next(1 / 60)).toBeCloseTo(0.5 / Math.SQRT2, 12);
    live.push([square(0.5, 0.2 * rate)]);
    live.push([new Float32Array(0.1 * rate)]);
    expect(live.pending).toBeCloseTo(0.1, 12);
    expect(live.next(1 / 60)).toBe(0);
    // One block longer than the limit is kept whole.
    live.push([square(0.5, 0.5 * rate)]);
    expect(live.pending).toBeCloseTo(0.5, 12);
    live.reset();
    expect([live.pending, live.value, live.level]).toEqual([0, 0, 0]);
  });

  it("has defaults that open the mouth for speech levels and keep it closed in a quiet room", () => {
    const run = (rmsDb: number) => {
      const live = new LiveLipSync(48000);
      for (let f = 0; f < 30; f++) {
        live.push([square(dbfsToAmplitude(rmsDb), 800)]);
        live.next(1 / 60);
      }
      return live.value;
    };
    expect(LIVE_LIP_SYNC_DEFAULTS).toEqual({ gain: 12, gate: -45, attack: 0.03, release: 0.12 });
    expect(run(-70)).toBe(0);
    expect(run(-50)).toBe(0);
    expect(run(-45)).toBe(0);
    expect(run(-35)).toBeGreaterThan(0.14);
    expect(run(-30)).toBeGreaterThan(0.3);
    expect(run(-26)).toBeGreaterThan(0.5);
    expect(run(-18)).toBeGreaterThan(1);
  });
});

describe.skipIf(!HAVE_DEEPSEEK)("live lip sync in the frame procedure", () => {
  it("adds the live value after the sound's, and ignores values that are not positive numbers", () => {
    const values = new AnimationValues(deepseekModel());
    const i = deepseekModel().parameters.ids.indexOf("ParamMouthOpenY");
    const base = values.values[i]!;
    const lip = new LipSync(["ParamMouthOpenY"]);
    const rate = 8000;
    lip.start(decodeWav(wav16(Array.from(square(0.2, rate)), rate)));
    let next = 0.25;
    lip.setLive({ next: () => next });
    values.restore();
    lip.frame(1 / 50, values);
    const sound = lip.soundValue;
    expect(sound).toBeCloseTo(0.2, 4);
    expect(lip.liveValue).toBe(0.25);
    expect(lip.value).toBe(sound + 0.25);
    expect(values.values[i]).toBe(Math.fround(Math.fround(base + sound) + 0.25));
    for (const bad of [NaN, -1, Infinity]) {
      next = bad;
      values.restore();
      lip.frame(1 / 50, values);
      expect(lip.liveValue).toBe(0);
      expect(values.values[i]).toBe(Math.fround(base + lip.soundValue));
    }
    // Without a live input, a frame is exactly 3s.2.
    lip.setLive(null);
    values.restore();
    lip.frame(1 / 50, values);
    expect(lip.value).toBe(lip.soundValue);
    expect(lip.liveSource).toBeNull();
  });
});

describe("mixing the live value", () => {
  /** A model with one lip-sync parameter M in [0, 1], at base value 0.3. */
  function setup() {
    const s = new Synth(4);
    s.part({ id: "P" });
    s.param("M", 0, 1, 0.3);
    s.mesh({ id: "X", keyforms: [{ positions: [0, 0, 1, 0, 0, 1] }] });
    const values = new AnimationValues(loadMoc(s.build()));
    const lip = new LipSync(["M"]);
    let next = 0.2;
    const source = { next: () => next };
    const frame = (live: number) => {
      next = live;
      values.restore();
      lip.frame(1 / 60, values);
      return values.get("M");
    };
    return { values, lip, source, frame };
  }

  it("adds by default, or replaces, or takes the larger value", () => {
    const { lip, source, frame } = setup();
    lip.setLive(source);
    expect(lip.liveMix).toBe("add");
    expect(frame(0.2)).toBe(Math.fround(Math.fround(0.3) + 0.2));
    lip.setLive(source, "replace");
    expect(frame(0.2)).toBe(Math.fround(0.2));
    expect(lip.value).toBe(0.2);
    expect(frame(0)).toBe(0); // replace closes the mouth on silence
    lip.setLive(source, "max");
    expect(frame(0.2)).toBe(Math.fround(0.3));
    expect(frame(0.6)).toBe(Math.fround(0.6));
    expect(lip.value).toBe(0.6);
    // Within the range, as every write.
    expect(frame(4)).toBe(1);
  });

  it("calls a mix function with the live value, the value so far and the ID", () => {
    const { lip, source, frame } = setup();
    const calls: [number, number, string][] = [];
    lip.setLive(source, (live, current, id) => {
      calls.push([live, current, id]);
      return id === "M" ? current * (1 - live) + live : current;
    });
    expect(frame(0.5)).toBe(Math.fround(Math.fround(0.3) * 0.5 + 0.5));
    expect(calls).toEqual([[0.5, Math.fround(0.3), "M"]]);
    expect(lip.value).toBe(0.5);
    // A non-finite result leaves the parameter as it is.
    lip.liveMix = () => NaN;
    expect(frame(0.5)).toBe(Math.fround(0.3));
  });

  it("replaces a playing sound's value too", () => {
    const { lip, source, frame } = setup();
    const rate = 8000;
    lip.start(decodeWav(wav16(Array.from(square(0.4, rate)), rate)));
    lip.setLive(source, "replace");
    expect(frame(0.1)).toBe(Math.fround(0.1));
    expect(lip.soundValue).toBeCloseTo(0.4, 4);
    lip.liveMix = "max";
    expect(frame(0.1)).toBeCloseTo(Math.fround(0.3) + 0.4, 4);
    expect(lip.value).toBeCloseTo(0.4, 4);
  });
});

describe.skipIf(!HAVE_DEEPSEEK)("live lip sync in the runtime (DeepSeek-chan)", () => {
  let rt: ModelRuntime;
  const mouth = () => rt.getParameter("ParamMouthOpenY");
  beforeAll(async () => {
    rt = await loadModelFromDisk(deepseek);
    for (const e of ["physics", "eyeBlink", "breath", "look", "idle"] as const)
      rt.setEffect(e, false);
    rt.update(1 / 60);
  });

  it("drives the ParamMouthOpenY fallback, within the parameter's range", () => {
    expect(rt.lipSyncFallback).toBe("ParamMouthOpenY");
    const range = rt.parameters.find((p) => p.id === "ParamMouthOpenY")!;
    const base = mouth();
    expect(base).toBe(range.default);
    const live = new LiveLipSync(48000, LIVE_LIP_SYNC_NEUTRAL);
    expect(rt.setLiveLipSync(live)).toBe(true);
    expect(rt.liveLipSync).toBe(live);
    live.push([square(0.25, 800)]);
    const r = rt.update(1 / 60)!;
    expect(r.lipSync).toBe(0.25);
    expect(r.changed).toBe(true);
    expect(mouth()).toBe(Math.fround(base + 0.25));
    // Too loud for the range: limited to its maximum.
    live.settings.gain = 100;
    live.push([square(0.3, 800)]);
    rt.update(1 / 60);
    expect(mouth()).toBe(range.max);
    // Silence closes the mouth.
    live.push([new Float32Array(800)]);
    rt.update(1 / 60);
    expect(mouth()).toBe(base);
  });

  it("follows the lip-sync effect switch, and stops with null", () => {
    const live = new LiveLipSync(48000, LIVE_LIP_SYNC_NEUTRAL);
    rt.setLiveLipSync(live);
    const base = rt.parameters.find((p) => p.id === "ParamMouthOpenY")!.default;
    rt.setEffect("lipSync", false);
    live.push([square(0.5, 800)]);
    expect(rt.update(1 / 60)!.lipSync).toBeNull();
    expect(mouth()).toBe(base);
    rt.setEffect("lipSync", true);
    live.push([square(0.5, 800)]);
    rt.update(1 / 60);
    expect(mouth()).toBe(Math.fround(base + 0.5));
    expect(rt.setLiveLipSync(null)).toBe(true);
    expect(rt.liveLipSync).toBeNull();
    rt.update(1 / 60);
    expect(mouth()).toBe(base);
  });

  it("is refused by a model without lip sync", async () => {
    const none = await loadModelFromDisk(deepseek, { lipSyncFallback: false });
    expect(none.setLiveLipSync(new LiveLipSync(48000))).toBe(false);
    expect(none.liveLipSync).toBeNull();
  });
});

describe("live audio errors", () => {
  it("gives getUserMedia failures codes and messages people can act on", () => {
    const cases: [string, string, RegExp][] = [
      ["NotAllowedError", "denied", /denied.*Allow the microphone/],
      ["SecurityError", "blocked", /blocked/],
      ["NotFoundError", "no-device", /No microphone/],
      ["OverconstrainedError", "no-device", /No microphone/],
      ["NotReadableError", "busy", /Another app/],
      ["AbortError", "busy", /Another app/],
      ["TypeError", "failed", /could not start: boom/],
    ];
    for (const [name, code, message] of cases) {
      const e = Object.assign(new Error("boom"), { name });
      const r = liveAudioError(e);
      expect(r, name).toBeInstanceOf(LiveAudioError);
      expect([r.name, r.code, r.cause]).toEqual(["LiveAudioError", code, e]);
      expect(r.message).toMatch(message);
    }
    const own = new LiveAudioError("ended", "gone");
    expect(liveAudioError(own)).toBe(own);
    expect(liveAudioError(null).code).toBe("failed");
    // Outside a browser there is no microphone at all.
    expect(liveAudioProblem()?.code).toBe("unsupported");
  });

  it.skipIf(!HAVE_DEEPSEEK)(
    "refuses a model without lip sync before asking for the microphone",
    async () => {
      const none = await loadModelFromDisk(deepseek, { lipSyncFallback: false });
      const inputs = new LiveInputs(() => {
        throw new Error("no audio context should be created");
      });
      await expect(inputs.start(none, {})).rejects.toMatchObject({
        name: "LiveAudioError",
        code: "no-lip-sync",
      });
      inputs.dispose();
      await expect(inputs.start(none, {})).rejects.toThrow("disposed");
    },
  );
});
