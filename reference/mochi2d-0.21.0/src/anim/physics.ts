/**
 * Pendulum physics: the file format of 3e and the simulation of
 * 3n. Arithmetic is double precision; the input copy and the working copy of
 * the parameter values are float32 (3v.1).
 */
import { AnimationFormatError, arr, bool, isObject, num, obj, parseJson, str } from "./json.js";
import type { AnimationValues } from "./values.js";

type Kind = "X" | "Y" | "Angle";

export interface PhysicsInput {
  source: string;
  weight: number;
  type: Kind;
  reflect: boolean;
}

export interface PhysicsOutput {
  destination: string;
  vertexIndex: number;
  scale: number;
  weight: number;
  type: Kind;
  reflect: boolean;
}

export interface PhysicsParticle {
  x: number;
  y: number;
  mobility: number;
  delay: number;
  acceleration: number;
  radius: number;
}

export interface Normalization {
  minimum: number;
  default: number;
  maximum: number;
}

export interface PhysicsSetting {
  id: string;
  inputs: PhysicsInput[];
  outputs: PhysicsOutput[];
  particles: PhysicsParticle[];
  position: Normalization;
  angle: Normalization;
}

/** `Meta.EffectiveForces` of a physics file: data only, the simulation does not use them (3n.2). */
export interface PhysicsForces {
  gravity: { x: number; y: number };
  wind: { x: number; y: number };
}

export interface PhysicsFile {
  label: string;
  /** Internal rate; 0 means one step per frame (3n.3). */
  fps: number;
  settings: PhysicsSetting[];
  /** Display names of settings (`Meta.PhysicsDictionary`). */
  names: { id: string; name: string }[];
  /**
   * `Meta.EffectiveForces` as the file gives them, or null (absent). Kept
   * for writing the file back; gravity and wind are runtime options (3n.2).
   */
  effectiveForces?: PhysicsForces | null;
}

const kind = (v: unknown): Kind => (v === "X" || v === "Y" ? v : v === "Angle" ? "Angle" : "X");

export function parsePhysics(input: Uint8Array | string | unknown, label = "physics"): PhysicsFile {
  const json =
    typeof input === "string" || input instanceof Uint8Array ? parseJson(input, label) : input;
  if (!isObject(json)) throw new AnimationFormatError(`${label}: not a JSON object`);
  const meta = obj(json.Meta);
  const norm = (v: unknown): Normalization => {
    const o = obj(v);
    return { minimum: num(o.Minimum, 0), default: num(o.Default, 0), maximum: num(o.Maximum, 0) };
  };
  const settings: PhysicsSetting[] = arr(json.PhysicsSettings).map((s) => {
    const ss = obj(s);
    const n = obj(ss.Normalization);
    return {
      id: str(ss.Id),
      inputs: arr(ss.Input).map((i) => {
        const ii = obj(i);
        return {
          source: str(obj(ii.Source).Id),
          weight: num(ii.Weight, 0),
          type: kind(ii.Type),
          reflect: bool(ii.Reflect),
        };
      }),
      outputs: arr(ss.Output).map((o) => {
        const oo = obj(o);
        return {
          destination: str(obj(oo.Destination).Id),
          vertexIndex: num(oo.VertexIndex, 0),
          scale: num(oo.Scale, 0),
          weight: num(oo.Weight, 0),
          type: kind(oo.Type),
          reflect: bool(oo.Reflect),
        };
      }),
      particles: arr(ss.Vertices).map((v) => {
        const vv = obj(v);
        const p = obj(vv.Position);
        return {
          x: num(p.X, 0),
          y: num(p.Y, 0),
          mobility: num(vv.Mobility, 0),
          delay: num(vv.Delay, 0),
          acceleration: num(vv.Acceleration, 0),
          radius: num(vv.Radius, 0),
        };
      }),
      position: norm(n.Position),
      angle: norm(n.Angle),
    };
  });
  // 3e.1: the Meta totals size the reader's storage; files that disagree are rejected.
  const totals: [string, number][] = [
    ["PhysicsSettingCount", settings.length],
    ["TotalInputCount", settings.reduce((a, s) => a + s.inputs.length, 0)],
    ["TotalOutputCount", settings.reduce((a, s) => a + s.outputs.length, 0)],
    ["VertexCount", settings.reduce((a, s) => a + s.particles.length, 0)],
  ];
  for (const [key, actual] of totals) {
    const declared = num(meta[key], NaN);
    if (declared !== actual)
      throw new AnimationFormatError(
        `${label}: Meta.${key} is ${meta[key]}, but the file has ${actual}`,
      );
  }
  const forces = isObject(meta.EffectiveForces) ? meta.EffectiveForces : null;
  const vec = (v: unknown) => {
    const o = obj(v);
    return { x: num(o.X, 0), y: num(o.Y, 0) };
  };
  return {
    label,
    fps: num(meta.Fps, 0),
    settings,
    names: arr(meta.PhysicsDictionary).map((d) => ({ id: str(obj(d).Id), name: str(obj(d).Name) })),
    effectiveForces: forces ? { gravity: vec(forces.Gravity), wind: vec(forces.Wind) } : null,
  };
}

/** Options of {@link writePhysics}. */
export interface WritePhysicsOptions {
  /** Indentation, as JSON.stringify's `space`. Default a tab. */
  indent?: string | number;
}

/**
 * The text of a `.physics3.json` file holding `file` (its `label` is not
 * written): the inverse of {@link parsePhysics}, which reads the text back
 * as `file`. Keys come in the usual order, indented with tabs, so a file
 * written in that layout comes back byte for byte. The Meta totals are
 * counted from the arrays; `EffectiveForces` are written as given, or as
 * gravity (0, −1) and wind (0, 0). Throws a RangeError for a number JSON
 * cannot hold (NaN, ±∞) or an input or output type other than "X", "Y" and
 * "Angle", naming where it is.
 */
export function writePhysics(
  file: Omit<PhysicsFile, "label"> & { label?: string },
  options: WritePhysicsOptions = {},
): string {
  const n = (v: number, where: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v))
      throw new RangeError(`writePhysics: ${where} is ${v}, not a finite number`);
    return v;
  };
  const t = (v: Kind, where: string): Kind => {
    if (v !== "X" && v !== "Y" && v !== "Angle")
      throw new RangeError(`writePhysics: ${where} is ${JSON.stringify(v)}, not X, Y or Angle`);
    return v;
  };
  const xy = (v: { x: number; y: number }, where: string) => ({
    X: n(v.x, `${where}.x`),
    Y: n(v.y, `${where}.y`),
  });
  const range = (v: Normalization, where: string) => ({
    Minimum: n(v.minimum, `${where}.minimum`),
    Default: n(v.default, `${where}.default`),
    Maximum: n(v.maximum, `${where}.maximum`),
  });
  const forces = file.effectiveForces ?? { gravity: { x: 0, y: -1 }, wind: { x: 0, y: 0 } };
  const json = {
    Version: 3,
    Meta: {
      PhysicsSettingCount: file.settings.length,
      TotalInputCount: file.settings.reduce((a, s) => a + s.inputs.length, 0),
      TotalOutputCount: file.settings.reduce((a, s) => a + s.outputs.length, 0),
      VertexCount: file.settings.reduce((a, s) => a + s.particles.length, 0),
      Fps: n(file.fps, "fps"),
      EffectiveForces: {
        Gravity: xy(forces.gravity, "effectiveForces.gravity"),
        Wind: xy(forces.wind, "effectiveForces.wind"),
      },
      PhysicsDictionary: file.names.map((d) => ({ Id: d.id, Name: d.name })),
    },
    PhysicsSettings: file.settings.map((s, i) => {
      const at = `settings[${i}]`;
      return {
        Id: s.id,
        Input: s.inputs.map((x, k) => ({
          Source: { Target: "Parameter", Id: x.source },
          Weight: n(x.weight, `${at}.inputs[${k}].weight`),
          Type: t(x.type, `${at}.inputs[${k}].type`),
          Reflect: x.reflect === true,
        })),
        Output: s.outputs.map((o, k) => ({
          Destination: { Target: "Parameter", Id: o.destination },
          VertexIndex: n(o.vertexIndex, `${at}.outputs[${k}].vertexIndex`),
          Scale: n(o.scale, `${at}.outputs[${k}].scale`),
          Weight: n(o.weight, `${at}.outputs[${k}].weight`),
          Type: t(o.type, `${at}.outputs[${k}].type`),
          Reflect: o.reflect === true,
        })),
        Vertices: s.particles.map((p, k) => ({
          Position: xy(p, `${at}.particles[${k}]`),
          Mobility: n(p.mobility, `${at}.particles[${k}].mobility`),
          Delay: n(p.delay, `${at}.particles[${k}].delay`),
          Acceleration: n(p.acceleration, `${at}.particles[${k}].acceleration`),
          Radius: n(p.radius, `${at}.particles[${k}].radius`),
        })),
        Normalization: {
          Position: range(s.position, `${at}.position`),
          Angle: range(s.angle, `${at}.angle`),
        },
      };
    }),
  };
  return JSON.stringify(json, null, options.indent ?? "\t");
}

/** ang(u → w): the angle from u to w, in [−π, π] (3n.6). */
export function angleBetween(ux: number, uy: number, wx: number, wy: number): number {
  let r = Math.atan2(wy, wx) - Math.atan2(uy, ux);
  if (r > Math.PI) r -= 2 * Math.PI;
  else if (r < -Math.PI) r += 2 * Math.PI;
  return r;
}

interface ParticleState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  gx: number;
  gy: number;
}

interface OutputState {
  cur: number;
  prev: number;
  /** Destination parameter index, or −1. */
  target: number;
}

interface SettingState {
  setting: PhysicsSetting;
  particles: ParticleState[];
  outputs: OutputState[];
  /** Input source parameter indices, or −1. */
  sources: number[];
}

/** Normalization N(v) of 3n.5. */
function normalize(
  v: number,
  pmin: number,
  pmax: number,
  n: Normalization,
  reflect: boolean,
): number {
  const lo = Math.min(pmin, pmax);
  const hi = Math.max(pmin, pmax);
  const x = Math.min(Math.max(v, lo), hi);
  const mid = lo + Math.abs(hi - lo) / 2;
  const nLo = Math.min(n.minimum, n.maximum);
  const nHi = Math.max(n.minimum, n.maximum);
  const nDef = n.default;
  const d = x - mid;
  let r: number;
  if (d > 0) r = hi === mid ? 0 : d * ((nHi - nDef) / (hi - mid)) + nDef;
  else if (d < 0) r = lo === mid ? 0 : d * ((nLo - nDef) / (lo - mid)) + nDef;
  else r = nDef;
  return reflect ? r : -r;
}

/**
 * A physics simulation's state between two frames ({@link PhysicsRig.saveState}):
 * every particle's position, velocity and last gravity direction, every
 * output's last two values, the step accumulator and interpolation factor,
 * and the float32 input copy of the parameter values. Not included: the
 * options (gravity, wind, strengths, rate). The numbers are kept exactly,
 * −0 included (JSON would turn −0 into 0: store `data`'s bytes instead).
 */
export interface PhysicsState {
  readonly format: "mochi2d-physics-state/1";
  /** Settings, each one's particle and output counts, and parameter count, of the saving rig. */
  readonly shape: readonly number[];
  readonly data: Float64Array;
}

const STATE_FORMAT = "mochi2d-physics-state/1";

/**
 * The most internal steps in one frame (not reference behavior): 10,000 is
 * 600,000 steps per second at 60 frames per second, far above any rig's
 * rate, and still only a moment for a corrupt one.
 */
const MAX_STEPS_PER_FRAME = 10000;

export class PhysicsRig {
  /** Gravity G and wind V (3n.2): application options, read at every step. */
  gravity: [number, number] = [0, -1];
  wind: [number, number] = [0, 0];
  /**
   * Strength (not reference behavior): how far the physics moves its
   * parameters, for the whole rig, times each setting's own (file order). The
   * product k applies to every output of the setting (see `written`); 1, the
   * default, is the reference.
   */
  strength = 1;
  readonly settingStrengths: Float64Array;
  /**
   * Wind multipliers per setting (not reference behavior, file order): a
   * setting's pendulums feel the wind V times its multiplier. 1, the
   * default, is the reference, bit for bit; 0 shields the setting from the
   * wind.
   */
  readonly settingWinds: Float64Array;
  /**
   * In a frame with Δ ≤ 0, write the last outputs again (not reference
   * behavior: the reference writes none, 3n.3). Views turn it on, so a paused
   * view keeps its physics pose.
   */
  holdOnZeroSteps = false;
  /**
   * The internal step rate, steps per second (not reference behavior),
   * instead of the file's `Fps`: 0 steps once per frame (3n.3). Null, the
   * default: the file's.
   */
  rate: number | null = null;
  private readonly states: SettingState[];
  /** The interpolation factor of the last outputs written. */
  private lambda = 0;
  private rho = 0;
  private input: Float32Array | null = null;
  private readonly work: Float32Array;
  private stepped = false;

  constructor(
    readonly file: PhysicsFile,
    private readonly values: AnimationValues,
  ) {
    this.work = new Float32Array(values.values.length);
    this.settingStrengths = new Float64Array(file.settings.length).fill(1);
    this.settingWinds = new Float64Array(file.settings.length).fill(1);
    this.states = file.settings.map((s) => {
      let sum = 0;
      return {
        setting: s,
        // 3n.1: the root at its file position; particle i at (0, R₁ + … + Rᵢ).
        particles: s.particles.map((p, i) => {
          if (i > 0) sum += p.radius;
          return { x: i === 0 ? p.x : 0, y: i === 0 ? p.y : sum, vx: 0, vy: 0, gx: 0, gy: 1 };
        }),
        outputs: s.outputs.map((o) => ({ cur: 0, prev: 0, target: values.index(o.destination) })),
        sources: s.inputs.map((i) => values.index(i.source)),
      };
    });
  }

  /**
   * Destination parameter IDs written with weight ≥ 100 %, with the inputs
   * of the setting that writes them (for viewers). Settings write in file
   * order, so when several settings overwrite one parameter, the last one's
   * value shows: its inputs are given.
   */
  overwrittenParameters(): Map<string, PhysicsInput[]> {
    const out = new Map<string, PhysicsInput[]>();
    for (const s of this.file.settings)
      for (const o of s.outputs)
        if (o.weight >= 100 && this.values.index(o.destination) >= 0)
          out.set(o.destination, s.inputs);
    return out;
  }

  /** The step rate in use: {@link rate}, or the file's `Fps` (0: one step per frame). */
  get stepRate(): number {
    return this.rate ?? this.file.fps;
  }

  /** The rig's shape, which a saved state must match. */
  private shape(): number[] {
    const out = [this.states.length];
    for (const s of this.states) out.push(s.particles.length, s.outputs.length);
    out.push(this.work.length);
    return out;
  }

  /** A copy of the simulation's state now (see {@link PhysicsState}). */
  saveState(): PhysicsState {
    const shape = this.shape();
    let n = 4 + this.work.length;
    for (const s of this.states) n += 6 * s.particles.length + 2 * s.outputs.length;
    const d = new Float64Array(n);
    d[0] = this.rho;
    d[1] = this.lambda;
    d[2] = this.stepped ? 1 : 0;
    d[3] = this.input ? 1 : 0;
    let k = 4;
    for (const s of this.states) {
      for (const p of s.particles) {
        d[k++] = p.x;
        d[k++] = p.y;
        d[k++] = p.vx;
        d[k++] = p.vy;
        d[k++] = p.gx;
        d[k++] = p.gy;
      }
      for (const o of s.outputs) {
        d[k++] = o.cur;
        d[k++] = o.prev;
      }
    }
    if (this.input) d.set(this.input, k);
    return { format: STATE_FORMAT, shape, data: d };
  }

  /**
   * Puts the simulation back in a saved state: the next frame continues
   * exactly as it did after the save, given the same parameter values, step
   * lengths and options. RangeError when the state comes from another
   * physics file (its shape differs).
   */
  restoreState(state: PhysicsState): void {
    const shape = this.shape();
    const same =
      state?.format === STATE_FORMAT &&
      state.shape.length === shape.length &&
      state.shape.every((v, i) => v === shape[i]) &&
      state.data instanceof Float64Array;
    let n = 4 + this.work.length;
    for (const s of this.states) n += 6 * s.particles.length + 2 * s.outputs.length;
    if (!same || state.data.length !== n)
      throw new RangeError("this physics state was saved from other physics settings");
    const d = state.data;
    this.rho = d[0]!;
    this.lambda = d[1]!;
    this.stepped = d[2] === 1;
    let k = 4;
    for (const s of this.states) {
      for (const p of s.particles) {
        p.x = d[k++]!;
        p.y = d[k++]!;
        p.vx = d[k++]!;
        p.vy = d[k++]!;
        p.gx = d[k++]!;
        p.gy = d[k++]!;
      }
      for (const o of s.outputs) {
        o.cur = d[k++]!;
        o.prev = d[k++]!;
      }
    }
    this.input = d[3] === 1 ? Float32Array.from(d.subarray(k, k + this.work.length)) : null;
  }

  /** 3n.3: one frame of length Δ. Writes the interpolated outputs into the parameters. */
  frame(dt: number): void {
    if (dt <= 0) {
      if (this.holdOnZeroSteps && this.stepped) this.writeOutputs(this.lambda);
      return;
    }
    this.rho += dt;
    if (this.rho > 5) this.rho = 0;
    const values = this.values;
    if (!this.input) this.input = Float32Array.from(values.values);
    const fps = this.stepRate;
    // An infinite rate (a file's 1e309) steps as without one.
    const h = fps > 0 && fps < Infinity ? 1 / fps : dt;
    let steps = 0;
    while (this.rho >= h) {
      // Not reference behavior: at most MAX_STEPS_PER_FRAME steps, then the
      // rest of the time is dropped but for the remainder (a rate so high,
      // even infinite, that the steps would never end).
      if (steps++ === MAX_STEPS_PER_FRAME) {
        this.rho %= h;
        break;
      }
      this.step(h);
      this.rho -= h;
    }
    if (!this.stepped) return;
    this.lambda = this.rho / h;
    this.writeOutputs(this.lambda);
  }

  /** The outputs at interpolation factor λ between the last two steps, into the parameters. */
  private writeOutputs(lambda: number): void {
    const values = this.values;
    this.states.forEach((s, i) => {
      const strength = this.strengthOf(i);
      s.setting.outputs.forEach((o, k) => {
        const st = s.outputs[k]!;
        if (st.target < 0) return;
        const v = st.prev * (1 - lambda) + st.cur * lambda;
        values.values[st.target] = this.written(
          o,
          st.target,
          v,
          values.values[st.target]!,
          strength,
        );
      });
    });
  }

  /** The strength k of setting i: the rig's times the setting's. */
  private strengthOf(i: number): number {
    return this.strength * this.settingStrengths[i]!;
  }

  /**
   * The write rule of 3n.7: scale, limit to the destination's range, blend by
   * the weight, giving r from the current value c. With a strength k ≠ 1 (not
   * reference behavior) the parameter becomes c + (r − c)·k instead: k = 0
   * leaves it at c exactly, and above 1 the result is limited to the
   * destination's range again. k = 1 is the reference rule, bit for bit.
   */
  private written(
    o: PhysicsOutput,
    target: number,
    value: number,
    current: number,
    strength = 1,
  ): number {
    const sigma = o.type === "Angle" ? o.scale : 0;
    const lo = this.values.min[target]!;
    const hi = this.values.max[target]!;
    const z = Math.min(Math.max(value * sigma, lo), hi);
    const w = o.weight / 100;
    const r = w >= 1 ? z : current * (1 - w) + z * w;
    if (strength === 1) return r;
    if (strength === 0) return current;
    const e = current + (r - current) * strength;
    return strength > 1 ? Math.min(Math.max(e, lo), hi) : e;
  }

  /** 3n.4: one internal step of length h. */
  private step(h: number): void {
    const values = this.values;
    for (const s of this.states) for (const o of s.outputs) o.prev = o.cur;
    // Input interpolation into the working copy (float32).
    const u = h / this.rho;
    const I = this.input!;
    const C = this.work;
    const v = values.values;
    for (let j = 0; j < C.length; j++) {
      C[j] = I[j]! * (1 - u) + v[j]! * u;
      I[j] = C[j]!;
    }
    for (let i = 0; i < this.states.length; i++) {
      const s = this.states[i]!;
      const strength = this.strengthOf(i);
      const set = s.setting;
      // a. Inputs.
      let x = 0;
      let y = 0;
      let a = 0;
      set.inputs.forEach((inp, k) => {
        const w = inp.weight / 100;
        const src = s.sources[k]!;
        const n = inp.type === "Angle" ? set.angle : set.position;
        const value =
          src >= 0
            ? normalize(C[src]!, values.min[src]!, values.max[src]!, n, inp.reflect)
            : inp.reflect
              ? n.default
              : -n.default;
        if (inp.type === "X") x += value * w;
        else if (inp.type === "Y") y += value * w;
        else a += value * w;
      });
      // b. Rotation, with the rotated x in the second line.
      const theta = (-a / 180) * Math.PI; // C17: (a / 180)·π
      const xr = x * Math.cos(theta) - y * Math.sin(theta);
      const yr = xr * Math.sin(theta) + y * Math.cos(theta);
      // c. Pendulum.
      this.pendulum(s, xr, yr, a, h, this.settingWinds[i]!);
      // d. Outputs.
      set.outputs.forEach((o, k) => {
        const st = s.outputs[k]!;
        const value = this.outputValue(s, o);
        if (value === null) return;
        st.cur = value;
        if (st.target >= 0)
          C[st.target] = this.written(o, st.target, value, C[st.target]!, strength);
      });
    }
    this.stepped = true;
  }

  /** 3n.6. */
  private pendulum(
    s: SettingState,
    rx: number,
    ry: number,
    a: number,
    h: number,
    windScale: number,
  ): void {
    const p = s.particles;
    const set = s.setting;
    p[0]!.x = rx;
    p[0]!.y = ry;
    let gx = Math.sin((a / 180) * Math.PI);
    let gy = Math.cos((a / 180) * Math.PI);
    const gl = Math.sqrt(gx * gx + gy * gy);
    gx /= gl;
    gy /= gl;
    // The setting's wind: V times its multiplier (exactly V at 1).
    const Vx = this.wind[0] * windScale;
    const Vy = this.wind[1] * windScale;
    const M = set.position.maximum;
    for (let i = 1; i < p.length; i++) {
      const cfg = set.particles[i]!;
      const q = p[i]!;
      const prev = p[i - 1]!;
      const Fx = gx * cfg.acceleration + Vx;
      const Fy = gy * cfg.acceleration + Vy;
      const lastX = q.x;
      const lastY = q.y;
      const k = cfg.delay * h * 30;
      const rX = q.x - prev.x;
      const rY = q.y - prev.y;
      const psi = angleBetween(q.gx, q.gy, gx, gy) / 5;
      const rpx = Math.cos(psi) * rX - rY * Math.sin(psi);
      const rpy = Math.sin(psi) * rpx + rY * Math.cos(psi);
      q.x = prev.x + rpx;
      q.y = prev.y + rpy;
      q.x = q.x + q.vx * k + Fx * k * k;
      q.y = q.y + q.vy * k + Fy * k * k;
      const dx = q.x - prev.x;
      const dy = q.y - prev.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      // C16: normalize first, then scale by the radius.
      q.x = prev.x + (dx / len) * cfg.radius;
      q.y = prev.y + (dy / len) * cfg.radius;
      if (Math.abs(q.x) < 0.001 * M) q.x = 0;
      if (k !== 0) {
        q.vx = ((q.x - lastX) / k) * cfg.mobility;
        q.vy = ((q.y - lastY) / k) * cfg.mobility;
      }
      q.gx = gx;
      q.gy = gy;
    }
  }

  /** 3n.7: an output's value, or null for an invalid vertex index. */
  private outputValue(s: SettingState, o: PhysicsOutput): number | null {
    const p = s.particles;
    const j = o.vertexIndex;
    if (j < 1 || j >= p.length) return null;
    const dx = p[j]!.x - p[j - 1]!.x;
    const dy = p[j]!.y - p[j - 1]!.y;
    let value: number;
    if (o.type === "X") value = dx;
    else if (o.type === "Y") value = dy;
    else {
      const gx = j >= 2 ? p[j - 1]!.x - p[j - 2]!.x : -this.gravity[0];
      const gy = j >= 2 ? p[j - 1]!.y - p[j - 2]!.y : -this.gravity[1];
      value = angleBetween(gx, gy, dx, dy);
    }
    return o.reflect ? -value : value;
  }

  /** 3n.8: the optional settle procedure, run once after load. */
  settle(): void {
    const values = this.values;
    const v = values.values;
    this.work.set(v);
    this.input = Float32Array.from(v);
    const C = this.work;
    for (let i = 0; i < this.states.length; i++) {
      const s = this.states[i]!;
      const strength = this.strengthOf(i);
      const Vx = this.wind[0] * this.settingWinds[i]!;
      const Vy = this.wind[1] * this.settingWinds[i]!;
      const set = s.setting;
      let x = 0;
      let y = 0;
      let a = 0;
      set.inputs.forEach((inp, k) => {
        const w = inp.weight / 100;
        const src = s.sources[k]!;
        const n = inp.type === "Angle" ? set.angle : set.position;
        const value =
          src >= 0
            ? normalize(v[src]!, values.min[src]!, values.max[src]!, n, inp.reflect)
            : inp.reflect
              ? n.default
              : -n.default;
        if (inp.type === "X") x += value * w;
        else if (inp.type === "Y") y += value * w;
        else a += value * w;
      });
      const theta = (-a / 180) * Math.PI; // C17: (a / 180)·π
      const xr = x * Math.cos(theta) - y * Math.sin(theta);
      const yr = xr * Math.sin(theta) + y * Math.cos(theta);
      const p = s.particles;
      p[0]!.x = xr;
      p[0]!.y = yr;
      let gx = Math.sin((a / 180) * Math.PI);
      let gy = Math.cos((a / 180) * Math.PI);
      const gl = Math.sqrt(gx * gx + gy * gy);
      gx /= gl;
      gy /= gl;
      const M = set.position.maximum;
      for (let i = 1; i < p.length; i++) {
        const cfg = set.particles[i]!;
        const q = p[i]!;
        const prev = p[i - 1]!;
        const Fx = gx * cfg.acceleration + Vx;
        const Fy = gy * cfg.acceleration + Vy;
        const fl = Math.sqrt(Fx * Fx + Fy * Fy);
        q.vx = 0;
        q.vy = 0;
        q.x = prev.x + (Fx / fl) * cfg.radius;
        q.y = prev.y + (Fy / fl) * cfg.radius;
        if (Math.abs(q.x) < 0.001 * M) q.x = 0;
        q.gx = gx;
        q.gy = gy;
      }
      set.outputs.forEach((o, k) => {
        const st = s.outputs[k]!;
        const value = this.outputValue(s, o);
        if (value === null) return;
        st.cur = value;
        st.prev = value;
        if (st.target >= 0) {
          v[st.target] = this.written(o, st.target, value, v[st.target]!, strength);
          C[st.target] = this.written(o, st.target, value, C[st.target]!, strength);
        }
      });
    }
    this.lambda = 0;
    this.stepped = true;
  }
}
