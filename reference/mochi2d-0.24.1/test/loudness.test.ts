import { describe, expect, it } from "vitest";
import {
  EnvelopeFollower,
  mixDown,
  peakAbs,
  rms,
  rmsEnvelope,
  toDecibels,
} from "../src/core/audio/loudness.js";
import { PlaybackClock } from "../src/lib/clock.js";
import { FrameStats } from "../src/lib/frame-stats.js";

function sine(freq: number, amp: number, seconds: number, rate: number): Float32Array {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

describe("loudness", () => {
  it("measures RMS and peak", () => {
    const s = sine(441, 0.5, 1, 44100);
    expect(rms(s)).toBeCloseTo(0.5 / Math.SQRT2, 4);
    expect(peakAbs(s)).toBeCloseTo(0.5, 3);
    expect(rms([])).toBe(0);
    expect(toDecibels(1)).toBe(0);
    expect(toDecibels(0)).toBe(-100);
    expect(toDecibels(0.5)).toBeCloseTo(-6.02, 2);
  });

  it("computes a per-frame envelope over trailing windows", () => {
    const rate = 48000;
    // 0.5 s of silence, then 0.5 s of a 0.8-amplitude sine.
    const s = new Float32Array(rate);
    s.set(sine(480, 0.8, 0.5, rate), rate / 2);
    const env = rmsEnvelope(s, rate, 60);
    expect(env.length).toBe(61);
    expect(env[0]).toBe(0);
    expect(env[20]).toBe(0); // t = 0.333 s, silence
    expect(env[45]).toBeCloseTo(0.8 / Math.SQRT2, 2); // t = 0.75 s
    expect(env[30]).toBe(0); // window ending exactly at the onset
    expect(env[31]).toBeGreaterThan(0.5);
  });

  it("follows with separate attack and release, independent of frame rate", () => {
    const a = new EnvelopeFollower(0.05, 0.5);
    const b = new EnvelopeFollower(0.05, 0.5);
    for (let i = 0; i < 60; i++) a.process(1, 1 / 60);
    for (let i = 0; i < 120; i++) b.process(1, 1 / 120);
    expect(a.value).toBeCloseTo(b.value, 6);
    expect(a.value).toBeCloseTo(1 - Math.exp(-1 / 0.05), 6);
    const rise = a.value;
    a.process(0, 0.05);
    expect(a.value).toBeCloseTo(rise * Math.exp(-0.05 / 0.5), 6);
  });

  it("mixes channels down", () => {
    const m = mixDown([new Float32Array([1, 0, 1]), new Float32Array([0, 0, -1])]);
    expect(Array.from(m)).toEqual([0.5, 0, 0]);
  });
});

describe("PlaybackClock", () => {
  it("plays at speed, pauses, steps and clamps long gaps", () => {
    const c = new PlaybackClock();
    expect(c.tick(0.016)).toBeCloseTo(0.016);
    c.speed = 2;
    expect(c.tick(0.01)).toBeCloseTo(0.02);
    expect(c.tick(5)).toBeCloseTo(0.2); // clamped to maxRealStep 0.1 × speed 2
    c.toggle();
    expect(c.tick(0.016)).toBe(0);
    c.step();
    c.step();
    expect(c.tick(0.016)).toBeCloseTo(2 / 60);
    expect(c.playing).toBe(false);
    expect(c.time).toBeCloseTo(0.016 + 0.02 + 0.2 + 2 / 60);
  });
});

describe("FrameStats", () => {
  it("averages over a rolling window", () => {
    const s = new FrameStats(4);
    for (const ms of [10, 20, 20, 20, 20]) s.record(ms, 1);
    const snap = s.snapshot();
    expect(snap.frames).toBe(4);
    expect(snap.frameMs).toBe(20);
    expect(snap.fps).toBe(50);
    expect(snap.worstFrameMs).toBe(20);
    expect(snap.cpuMs).toBe(1);
  });
});
