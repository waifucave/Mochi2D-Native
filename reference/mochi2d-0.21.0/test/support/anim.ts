/**
 * Builders for the crafted animation inputs of 3x: motion,
 * expression, physics and pose files, settings and WAV sounds, generated at
 * test time on DeepSeek-chan's model file.
 */
import { expect } from "vitest";
import { readFileSync } from "node:fs";
import { loadMoc, type MocModel } from "../../src/core/moc/model.js";
import type { ModelSettings } from "../../src/core/settings/model-settings.js";
import type { EffectSwitches } from "../../src/anim/animator.js";
import { DEEPSEEK_MOC } from "./crafted.js";

let model: MocModel | null = null;
export function deepseekModel(): MocModel {
  model ??= loadMoc(readFileSync(DEEPSEEK_MOC));
  return model;
}

/** Settings listing only the model, plus the given extras. */
export function settings(extra: Partial<ModelSettings> = {}): ModelSettings {
  return {
    moc: "大肥鱼.moc3",
    textures: [],
    expressions: [],
    motions: [],
    groups: [],
    hitAreas: [],
    layout: {},
    raw: {},
    ...extra,
  };
}

/** Settings S0 of 3x.1. */
export function settingsS0(extra: Partial<ModelSettings> = {}): ModelSettings {
  return settings({
    groups: [
      { target: "Parameter", name: "EyeBlink", ids: ["ParamEyeROpen", "ParamEyeLOpen"] },
      { target: "Parameter", name: "LipSync", ids: ["ParamMouthOpenY"] },
    ],
    ...extra,
  });
}

export type Segment =
  | ["linear" | "stepped" | "inverse", number, number]
  | ["bezier", number, number, number, number, number, number];

const CODE = { linear: 0, bezier: 1, stepped: 2, inverse: 3 } as const;

export interface CurveSpec {
  target?: "Model" | "Parameter" | "PartOpacity";
  id: string;
  first: [number, number];
  segments: Segment[];
  fadeIn?: number;
  fadeOut?: number;
}

/** A motion file with correct counts in Meta. */
export function motionJson(spec: {
  duration: number;
  fps: number;
  restricted?: boolean;
  fadeIn?: number;
  fadeOut?: number;
  curves: CurveSpec[];
  events?: { time: number; value: string }[];
}): string {
  let segments = 0;
  let points = 0;
  const curves = spec.curves.map((c) => {
    const data: number[] = [...c.first];
    points++;
    for (const s of c.segments) {
      data.push(CODE[s[0]], ...(s.slice(1) as number[]));
      segments++;
      points += s[0] === "bezier" ? 3 : 1;
    }
    return {
      Target: c.target ?? "Parameter",
      Id: c.id,
      ...(c.fadeIn !== undefined ? { FadeInTime: c.fadeIn } : {}),
      ...(c.fadeOut !== undefined ? { FadeOutTime: c.fadeOut } : {}),
      Segments: data,
    };
  });
  return JSON.stringify({
    Version: 3,
    Meta: {
      Duration: spec.duration,
      Fps: spec.fps,
      Loop: false,
      AreBeziersRestricted: spec.restricted ?? false,
      CurveCount: curves.length,
      TotalSegmentCount: segments,
      TotalPointCount: points,
      UserDataCount: spec.events?.length ?? 0,
      TotalUserDataSize: 0,
      ...(spec.fadeIn !== undefined ? { FadeInTime: spec.fadeIn } : {}),
      ...(spec.fadeOut !== undefined ? { FadeOutTime: spec.fadeOut } : {}),
    },
    Curves: curves,
    ...(spec.events
      ? { UserData: spec.events.map((e) => ({ Time: e.time, Value: e.value })) }
      : {}),
  });
}

/** A constant parameter curve over [0, duration]. */
export const constant = (id: string, value: number, duration: number): CurveSpec => ({
  id,
  first: [0, value],
  segments: [["linear", duration, value]],
});

/** Only the listed effects run (3x.1: "only the effect under test runs"). */
export function only(...names: (keyof EffectSwitches)[]): EffectSwitches {
  const all: EffectSwitches = {
    idle: false,
    eyeBlink: false,
    expressions: false,
    look: false,
    breath: false,
    physics: false,
    lipSync: false,
    pose: false,
    motionSync: false,
  };
  for (const n of names) all[n] = true;
  return all;
}

/** 16-bit PCM WAV file from samples in [−1, 1], stored as round(v·32767). */
export function wav16(samples: number[], rate: number, channels = 1): Uint8Array {
  const data = samples.length * 2;
  const b = new Uint8Array(44 + data);
  const dv = new DataView(b.buffer);
  const text = (o: number, s: string) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  text(0, "RIFF");
  dv.setUint32(4, 36 + data, true);
  text(8, "WAVE");
  text(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * channels * 2, true);
  dv.setUint16(32, channels * 2, true);
  dv.setUint16(34, 16, true);
  text(36, "data");
  dv.setUint32(40, data, true);
  samples.forEach((v, i) => dv.setInt16(44 + 2 * i, Math.round(v * 32767), true));
  return b;
}

/** `got` rounds to `want` at 7 significant digits (the precision of the 3x tables). */
export function expect7(got: number, want: number, what: string): void {
  if (want === 0) {
    expect(Math.abs(got), what).toBeLessThanOrEqual(1e-12);
    return;
  }
  const e = Math.floor(Math.log10(Math.abs(want)));
  const tol = 0.5 * 10 ** (e - 6) * (1 + 1e-9);
  expect(Math.abs(got - want), `${what}: got ${got}, want ${want}`).toBeLessThanOrEqual(tol);
}
