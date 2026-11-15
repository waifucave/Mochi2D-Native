/**
 * Motion sync around the analysis: the per-parameter filter and the tick
 * schedule against their exact vectors (2.10, T14, T16), Mochi2D's engine
 * steps (gate, Enabled, Scale, normalization, blend, shape, slew limits),
 * and the driver on DeepSeek-chan's parameters: which parameters are
 * written and when (T1–T3), the end of a sound, several settings (T18),
 * sample rates (T21) and sample accounting.
 */
import { describe, expect, it } from "vitest";
import { ParameterFilter, TickClock } from "../src/anim/motion-sync/parameter-filter.js";
import { SettingEngine, MotionSyncDriver } from "../src/anim/motion-sync/driver.js";
import { parseMotionSync, type MotionSyncSetting } from "../src/anim/motion-sync/file.js";
import type { Analysis } from "../src/anim/motion-sync/analysis.js";
import { AnimationValues } from "../src/anim/values.js";
import { deepseekModel } from "./support/anim.js";
import { HAVE_DEEPSEEK } from "./support/deepseek.js";
import {
  BASIC,
  ELEMENTS,
  MALE,
  dsBasic,
  dsTwo,
  edited,
  glideClip,
  silence,
  vowelClip,
} from "./support/motion-sync.js";

const setting = (json: unknown, i = 0): MotionSyncSetting =>
  parseMotionSync(JSON.stringify(json), "ms").settings[i]!;
const basicWith = (edit: (j: any) => void) => setting(edited(dsBasic(), edit));

describe("the per-parameter filter (exact, double precision)", () => {
  it("matches the filter vector: Smooth 25, Damper 0.05", () => {
    const f = new ParameterFilter(Float64Array.of(25), Float64Array.of(0.05));
    f.reset([0]);
    const S: number[] = [];
    const D: number[] = [];
    for (const y of [1, 1, 1, 0.98, 0.98]) {
      f.step([y]);
      S.push(f.smoothed[0]!);
      D.push(f.output[0]!);
    }
    expect(S).toEqual([0.75, 0.9375, 0.984375, 0.98109375, 0.9802734375]);
    expect(D).toEqual([0.75, 0.9375, 0.9375, 0.9375, 0.9375]);
  });

  it("T16: Smooth 0 passes values through, 100 freezes them; Damper 0 always follows", () => {
    const f = new ParameterFilter(Float64Array.of(0, 100, 25), Float64Array.of(0, 0, 0));
    f.reset([0.2, 0.2, 0.2]);
    for (const y of [1, 0.5, 0.25]) {
      f.step([y, y, y]);
      expect(f.output[0]).toBe(y);
      expect(f.output[1]).toBe(0.2);
      expect(f.output[2]).toBe(f.smoothed[2]);
    }
  });

  it("T16: a Damper of 1 holds the output until the smoothed value moved by 1", () => {
    const f = new ParameterFilter(Float64Array.of(0), Float64Array.of(1));
    f.reset([0]);
    f.step([0.99]);
    expect(f.output[0]).toBe(0);
    f.step([1]);
    expect(f.output[0]).toBe(1);
    f.step([0.01]);
    expect(f.output[0]).toBe(1);
  });

  it("skips values that are not numbers; smoothing off keeps the dead band", () => {
    const f = new ParameterFilter(Float64Array.of(25, 25), Float64Array.of(0.1, 0.1), false);
    f.reset([0, 0]);
    f.step([NaN, 0.5]);
    expect([...f.smoothed]).toEqual([0, 0.5]);
    expect([...f.output]).toEqual([0, 0.5]);
    f.step([0.05, 0.55]);
    expect([...f.smoothed]).toEqual([0.05, 0.55]);
    expect([...f.output]).toEqual([0, 0.5]);
  });
});

describe("the analysis tick", () => {
  /** The frames (1-based) that tick, over `frames` frames of step `dt`. */
  const ticks = (rate: number, dt: number, frames: number) => {
    const c = new TickClock(rate);
    const out: number[] = [];
    for (let i = 1; i <= frames; i++) if (c.advance(dt)) out.push(i);
    return out;
  };

  it("matches the schedule vectors: SampleRate 60 at 144 and 30 frames per second", () => {
    const c = new TickClock(60);
    expect([c.advance(1 / 144), c.advance(1 / 144), c.advance(1 / 144)]).toEqual([
      false,
      false,
      true,
    ]);
    expect(c.time).toBeCloseTo(0.0041667, 7);
    const t = ticks(60, 1 / 144, 288);
    expect(t.slice(0, 5)).toEqual([3, 5, 8, 10, 13]);
    expect(t.filter((f) => f <= 144)).toHaveLength(59);
    expect(t).toHaveLength(119);
    expect(ticks(60, 1 / 30, 60)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  it("ticks at most once a frame, the first no earlier than one period", () => {
    expect(ticks(60, 1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(ticks(60, 1 / 120, 4)).toEqual([2, 4]);
    expect(ticks(60, 0, 100)).toEqual([]);
    expect(ticks(60, -1, 100)).toEqual([]);
  });

  it("T14: SampleRate 0, 0.5, 120 and 240 as the reader limits them, at 30, 60 and 144 fps", () => {
    const rates = [0, 0.5, 120, 240].map(
      (r) => basicWith((j) => (j.Settings[0].PostProcessing.SampleRate = r)).sampleRate,
    );
    expect(rates).toEqual([60, 1, 120, 120]);
    for (const fps of [30, 60, 144]) {
      const frames = 10 * fps;
      for (const rate of rates) {
        const n = ticks(rate, 1 / fps, frames).length;
        // About min(SampleRate, frame rate) a second, within one tick.
        expect(Math.abs(n - 10 * Math.min(rate, fps)), `${rate} at ${fps} fps`).toBeLessThanOrEqual(
          1,
        );
      }
    }
  });
});

/** An analysis with these raw weights (Silence, A, I, U, E, O). */
const analysis = (raw: number[], silent = false): Analysis =>
  ({ raw: Float64Array.from(raw), level: -20, silent, voicing: 1, open: 1 }) as unknown as Analysis;

describe("Mochi2D's engine", () => {
  it("blends: 0 takes the most likely shape, 1 the weighted shapes, ties to the earlier", () => {
    const at = (br: number, raw: number[]) => {
      const e = new SettingEngine(basicWith((j) => (j.Settings[0].PostProcessing.BlendRatio = br)));
      e.step(analysis(raw), 1 / 60);
      return [...e.values];
    };
    const raw = [0, 0.5, 0.3, 0, 0.2, 0];
    expect(at(0, raw)).toEqual(BASIC.shapes.A);
    const blend = [0.5 * 1 + 0.3 * 0.35 + 0.2 * 0.6, 0.3 * 1 + 0.2 * 0.6];
    at(1, raw).forEach((v, k) => expect(v).toBeCloseTo(blend[k]!, 12));
    at(0.5, raw).forEach((v, k) =>
      expect(v).toBeCloseTo(0.5 * BASIC.shapes.A[k]! + 0.5 * blend[k]!, 12),
    );
    expect(at(0, [0, 0, 0.5, 0.5, 0, 0])).toEqual(BASIC.shapes.I);
  });

  it("normalizes after the gate, Enabled and Scale; with nothing left, Silence", () => {
    const e = new SettingEngine(
      basicWith((j) => {
        j.Settings[0].AudioParameters[1].Enabled = false;
        j.Settings[0].AudioParameters[2].Scale = 3;
      }),
    );
    e.step(analysis([0.2, 0.4, 0.2, 0.2, 0, 0]), 1 / 60);
    [0.2, 0, 0.6, 0.2, 0, 0].forEach((w, i) => expect(e.weights[i]).toBeCloseTo(w, 12));
    e.reset();
    e.step(analysis([0, 1, 0, 0, 0, 0]), 1 / 60);
    expect([...e.weights]).toEqual([1, 0, 0, 0, 0, 0]);
    expect([...e.values]).toEqual(BASIC.shapes.Silence);
    e.reset();
    e.step(analysis([0.1, 0, 0.9, 0, 0, 0], true), 1 / 60);
    expect([...e.weights]).toEqual([1, 0, 0, 0, 0, 0]);
  });

  it("gives an unknown element no weight", () => {
    const e = new SettingEngine(
      basicWith((j) => {
        j.Settings[0].AudioParameters[5].Id = "Ah";
        j.Settings[0].Mappings[5].Id = "Ah";
      }),
    );
    e.step(analysis([0, 0, 0, 0, 0, 1]), 1 / 60);
    expect(e.weights[5]).toBe(0);
    expect(e.weights[0]).toBe(1);
  });

  it("limits how fast values move: attack away from Silence, release back, 1.5 times slower", () => {
    const span = 1; // ParamMouthOpenY spans 0 … 1 over the shapes
    for (const smoothing of [1, 60, 100]) {
      const e = new SettingEngine(
        basicWith((j) => {
          j.Settings[0].PostProcessing.Smoothing = smoothing;
          j.Settings[0].PostProcessing.BlendRatio = 0;
        }),
      );
      const attack = 0.02 * 25 ** ((smoothing - 1) / 99);
      const dt = 1 / 120;
      e.step(analysis([1, 0, 0, 0, 0, 0]), dt);
      expect(e.values[0]).toBe(0);
      // Opening towards A: a constant rate, whatever the distance.
      e.step(analysis([0, 1, 0, 0, 0, 0]), dt);
      const step = Math.min(1, (span * dt) / attack);
      expect(e.values[0]).toBeCloseTo(step, 12);
      let t = dt;
      while (e.values[0]! < 1) {
        e.step(analysis([0, 1, 0, 0, 0, 0]), dt);
        t += dt;
      }
      expect(t).toBeCloseTo(Math.max(dt, Math.ceil(attack / dt - 1e-9) * dt), 9);
      // Closing: the release rate.
      e.step(analysis([1, 0, 0, 0, 0, 0]), dt);
      expect(1 - e.values[0]!).toBeCloseTo(Math.min(1, (span * dt) / (1.5 * attack)), 12);
    }
  });

  it("is not a linear filter: a step twice as large does not move twice as far", () => {
    const e1 = new SettingEngine(setting(dsBasic()));
    const e2 = new SettingEngine(setting(dsBasic()));
    e1.step(analysis([1, 0, 0, 0, 0, 0]), 1 / 60);
    e2.step(analysis([1, 0, 0, 0, 0, 0]), 1 / 60);
    // The opening of E is 0.6, of A 1 (BlendRatio 0.5 halves both shapes' pull equally).
    e1.step(analysis([0, 0, 0, 0, 1, 0]), 1 / 60);
    e2.step(analysis([0, 1, 0, 0, 0, 0]), 1 / 60);
    expect(e1.values[0]).toBe(e2.values[0]);
  });
});

describe.skipIf(!HAVE_DEEPSEEK)("the driver on DeepSeek-chan's parameters", () => {
  const sound = (samples: Float32Array, rate: number) => ({
    sampleRate: rate,
    channels: [samples],
  });
  const male = vowelClip(MALE, 16000);

  function driver(json: unknown, options = {}) {
    const values = new AnimationValues(deepseekModel());
    const file = parseMotionSync(JSON.stringify(json), "ms");
    return { values, file, d: new MotionSyncDriver(file, values, options) };
  }

  it("T1–T3: drives a parameter whose range differs, never one the model lacks, and dead ones", () => {
    const { values, file, d } = driver(
      edited(dsBasic(), (j) => {
        const p = j.Settings[0].CubismParameters;
        p[1].Min = 0;
        p.push({ ...p[0], Id: "ParamMouthOpenZ", Name: "Z" }, { ...p[0], Id: "ParamA", Name: "A" });
        for (const m of j.Settings[0].Mappings)
          m.Targets.push(
            { Id: "ParamMouthOpenZ", Value: 1 },
            { Id: "ParamA", Value: m.Id === "A" ? 1 : 0 },
          );
      }),
    );
    d.playSound(file.settings[0]!, sound(male.samples, 16000));
    expect(d.warnings).toHaveLength(2);
    expect(d.warnings[0]).toContain(
      "ParamMouthForm the range [0, 1], the model [-1, 1]; driven anyway",
    );
    expect(d.warnings[1]).toContain(
      "drives ParamMouthOpenZ, which the model lacks; it is not written",
    );
    const seg = male.segments[0]!; // A
    for (let t = 0; t < seg.start + 0.5; t += 1 / 60) d.frame(1 / 60);
    const tick = d.tick!;
    expect(tick.values.ParamA).toBeGreaterThan(0.5);
    expect(values.get("ParamA")).toBeCloseTo(tick.values.ParamA!, 6);
    expect(values.get("ParamMouthOpenY")).toBeCloseTo(tick.values.ParamMouthOpenY!, 6);
    expect(values.index("ParamMouthOpenZ")).toBe(-1);
  });

  it("writes nothing before the first tick, then D every frame, ticking or not", () => {
    const { values, file, d } = driver(dsBasic());
    const i = values.index("ParamMouthOpenY");
    d.playSound(file.settings[0]!, sound(male.samples, 16000));
    const dt = 1 / 144;
    values.setAt(i, 0.42);
    d.frame(dt);
    d.frame(dt);
    expect(values.values[i]).toBeCloseTo(0.42, 6); // no tick yet
    let ticksSeen = 0;
    d.onTick(() => ticksSeen++);
    for (let n = 0; n < 400; n++) {
      values.setAt(i, 0.42); // what a motion would set
      d.frame(dt);
      expect(values.values[i]).toBe(Math.fround(d.tick!.values.ParamMouthOpenY!));
    }
    expect(ticksSeen).toBeGreaterThan(150);
    expect(ticksSeen).toBeLessThan(170);
  });

  it("settles to the Silence shape after a sound ends, then stops writing", () => {
    const { values, file, d } = driver(
      edited(dsBasic(), (j) =>
        j.Settings[0].CubismParameters.forEach((p: any) => (p.Damper = 0.02)),
      ),
    );
    const i = values.index("ParamMouthOpenY");
    // 0.6 s of A, ending loud: the mouth is open when the sound ends.
    const a = vowelClip(MALE, 16000, { vowels: ["A"], gap: 0.1, hold: 0.6 });
    d.playSound(file.settings[0]!, sound(a.samples.subarray(0, Math.round(0.6 * 16000)), 16000));
    let t = 0;
    for (; t < 0.6 - 1e-9; t += 1 / 60) d.frame(1 / 60);
    expect(values.values[i]).toBeGreaterThan(0.3);
    expect(d.playing).toBe(false);
    // Silence is fed: within 0.5 s the mouth is within Damper of closed, then nothing is written.
    let settledAfter = -1;
    for (let n = 1; n <= 40; n++) {
      values.setAt(i, 0.9);
      d.frame(1 / 60);
      if (d.setting === null) {
        settledAfter = n / 60;
        break;
      }
    }
    expect(settledAfter).toBeGreaterThan(0);
    expect(settledAfter).toBeLessThanOrEqual(0.5 + 1e-9);
    values.setAt(i, 0.9);
    d.frame(1 / 60);
    expect(values.values[i]).toBeCloseTo(0.9, 6);
  });

  it("an early stop fades the sound out over the given time first", () => {
    const { file, d } = driver(dsBasic());
    d.playSound(
      file.settings[0]!,
      sound(vowelClip(MALE, 16000, { vowels: ["A"], hold: 3 }).samples, 16000),
    );
    for (let n = 0; n < 60; n++) d.frame(1 / 60);
    const open = d.tick!.values.ParamMouthOpenY!;
    expect(open).toBeGreaterThan(0.5);
    d.stop(0.5);
    expect(d.playing).toBe(true);
    const levels: number[] = [];
    for (let n = 0; n < 32 && d.playing; n++) {
      d.frame(1 / 60);
      levels.push(d.tick!.level);
    }
    // The level falls through the fade, and the sound ends with it.
    expect(levels[25]!).toBeLessThan(levels[2]! - 10);
    expect(d.playing).toBe(false);
    expect(levels.length).toBeGreaterThanOrEqual(30);
  });

  it("T18: only the bound setting writes; a new binding starts from the current values", () => {
    const { values, file, d } = driver(dsTwo());
    const [basic, rich] = file.settings as [MotionSyncSetting, MotionSyncSetting];
    const glide = glideClip(MALE, 4, 44100);
    d.playSound(basic, sound(glide, 44100));
    for (let n = 0; n < 60; n++) d.frame(1 / 60);
    expect(d.setting).toBe(basic);
    const funnel = values.index("MouthFunnel");
    values.setAt(funnel, 0.37);
    const before = Object.fromEntries(rich.parameters.map((p) => [p.id, values.get(p.id)]));
    d.playSound(rich, sound(glide, 44100));
    d.frame(1 / 240); // no tick yet at 30 per second: the filter starts from the current values
    expect(values.get("MouthFunnel")).toBeCloseTo(0.37, 6);
    for (let n = 0; n < 60; n++) {
      values.setAt(funnel, 0.37);
      d.frame(1 / 60);
    }
    expect(d.setting).toBe(rich);
    expect(d.drivenIds).toEqual(rich.parameters.map((p) => p.id));
    for (const p of rich.parameters) expect(values.get(p.id)).toBeCloseTo(d.tick!.values[p.id]!, 6);
    expect(before.MouthFunnel).toBeCloseTo(0.37, 6);
  });

  it("consecutive sounds on one setting carry its state over", () => {
    const { values, file, d } = driver(dsBasic());
    const s = file.settings[0]!;
    d.playSound(s, sound(vowelClip(MALE, 16000, { vowels: ["A"], hold: 1 }).samples, 16000));
    for (let n = 0; n < 50; n++) d.frame(1 / 60);
    const open = values.get("ParamMouthOpenY");
    expect(open).toBeGreaterThan(0.5);
    d.playSound(s, sound(silence(1, 16000), 16000));
    d.frame(1 / 60);
    // The first tick of the new sound moves from where the mouth was, at the release rate.
    expect(values.get("ParamMouthOpenY")).toBeGreaterThan(open - 0.2);
  });

  it("accounts for every sample: 2 s at 44.1 kHz consume 88,200", () => {
    const { file, d } = driver(dsBasic());
    d.playSound(file.settings[0]!, sound(silence(2, 44100), 44100));
    for (let n = 0; n < 120; n++) d.frame(1 / 60);
    expect(d.consumed).toBe(88200);
    for (let n = 0; n < 30; n++) d.frame(1 / 60);
    expect(d.consumed).toBe(88200);
  });

  it("follows an audio clock over 60 s without drift", () => {
    const { file, d } = driver(dsBasic());
    const rate = 48000;
    const long = glideClip(MALE, 60, rate);
    let audioTime = 0;
    d.playSound(file.settings[0]!, sound(long, rate), () => audioTime);
    // Frames of 1/60 s while the audio clock runs 0.1 % fast, read with jitter.
    for (let n = 1; n <= 3610; n++) {
      audioTime = Math.min(60, n * (1 / 60) * 1.001 + (n % 3) * 0.002);
      d.frame(1 / 60);
      const played = Math.round(audioTime * rate);
      expect(Math.abs(d.consumed - played)).toBeLessThanOrEqual(Math.round(0.02 * rate));
    }
    expect(d.consumed).toBe(long.length);
  });

  it("T21: reads sounds at 8 kHz and at 192 kHz", () => {
    for (const rate of [8000, 192000]) {
      const { file, d } = driver(dsBasic());
      const clip = vowelClip(MALE, rate, { vowels: ["A", "I"] });
      d.playSound(file.settings[0]!, sound(clip.samples, rate));
      const strongest: string[] = [];
      d.onTick((t) => {
        const best = ELEMENTS.reduce((a, b) => (t.weights[b] > t.weights[a] ? b : a));
        if (clip.segments.some((s) => t.time > s.start + 0.1 && t.time < s.end - 0.1))
          strongest.push(best);
      });
      for (let n = 0; n < 60 * 3; n++) d.frame(1 / 60);
      expect(d.consumed).toBe(clip.samples.length);
      const a = strongest.filter((e) => e === "A").length;
      const i = strongest.filter((e) => e === "I").length;
      expect(a + i, `${rate} Hz`).toBeGreaterThan(0.9 * strongest.length);
      expect(Math.min(a, i)).toBeGreaterThan(0.4 * strongest.length);
    }
  });
});
