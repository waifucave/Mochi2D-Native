/**
 * Fuzzing the loaders: mutated inputs grown from small seed files (synthetic
 * models and hand-written JSON, WAV and zip files, never DeepSeek-chan's),
 * each run through a loader. A failure is anything but the loader's
 * documented errors: another exception, an input that takes longer than a
 * time limit, or memory out of proportion to the input.
 *
 * `test/fuzz.test.ts` runs a short pass in the suite; `npm run fuzz` runs a
 * long one (tools/fuzz.ts), in child processes with a watchdog for hangs.
 */
import { zipSync, strToU8 } from "fflate";
import { loadMoc } from "../../src/core/moc/model.js";
import { MocFormatError } from "../../src/core/moc/read.js";
import { MocWriteError, WRITABLE_VERSIONS, readMoc, writeMoc } from "../../src/core/moc/io.js";
import { validateMoc } from "../../src/core/moc/validate.js";
import { ModelInstance } from "../../src/core/eval/instance.js";
import { parseModelSettings, SettingsFormatError } from "../../src/core/settings/model-settings.js";
import { AnimationFormatError } from "../../src/anim/json.js";
import { parseMotion } from "../../src/anim/motion.js";
import { parseExpression } from "../../src/anim/expression.js";
import { parsePhysics } from "../../src/anim/physics.js";
import { parsePose } from "../../src/anim/pose.js";
import { parseDisplayInfo, parseUserData } from "../../src/anim/model-data.js";
import { parseMotionSync } from "../../src/anim/motion-sync/file.js";
import { decodeWav, WavFormatError } from "../../src/anim/lip-sync.js";
import { decodeMotionSyncWav, MotionSyncAudioError } from "../../src/anim/motion-sync/wav.js";
import { ZipFormatError } from "../../src/runtime/zip-archive.js";
import { sourceFromZip, UnsupportedArchiveError } from "../../src/runtime/zip-source.js";
import { FileNotFoundError, MemoryFileSource } from "../../src/core/io/file-source.js";
import { ModelRuntime } from "../../src/runtime/model-runtime.js";
import { Synth } from "../../test/support/synth.js";

// ----------------------------------------------------------------- random

/** A seeded generator of numbers in [0, 1) (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

// --------------------------------------------------------------- mutators

const INTS = [
  0,
  1,
  -1,
  2,
  3,
  0x7f,
  0x80,
  0xff,
  0x100,
  0x7fff,
  0xffff,
  0x7fffffff,
  -0x80000000,
  1 << 20,
  1 << 28,
];
const FLOATS = [0, -0, 1, -1, 0.5, NaN, Infinity, -Infinity, 1e38, -1e38, 1e-45, 3.4e38, 1e9, 1001];

/** A copy of `bytes` with 1–4 random mutations: bit flips, interesting values at aligned offsets, cuts, splices. */
export function mutateBytes(bytes: Uint8Array, r: () => number): Uint8Array {
  let b: Uint8Array = bytes.slice();
  const n = 1 + Math.floor(r() * 4);
  for (let m = 0; m < n; m++) {
    if (b.length === 0) b = new Uint8Array([Math.floor(r() * 256)]);
    const kind = Math.floor(r() * 9);
    const at = Math.floor(r() * b.length);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const at4 = Math.min(b.length - 4, at & ~3);
    switch (kind) {
      case 0: // flip a bit
        b[at] = b[at]! ^ (1 << Math.floor(r() * 8));
        break;
      case 1: // a random byte
        b[at] = Math.floor(r() * 256);
        break;
      case 2: // an interesting 32-bit integer at an aligned offset (counts, offsets)
        if (at4 >= 0) dv.setInt32(at4, pick(r, INTS) | 0, r() < 0.8);
        break;
      case 3: // an interesting float at an aligned offset
        if (at4 >= 0) dv.setFloat32(at4, pick(r, FLOATS), true);
        break;
      case 4: // cut the end
        b = b.slice(0, at);
        break;
      case 5: // cut a piece out
        b = concatBytes(b.slice(0, at), b.slice(Math.min(b.length, at + 1 + Math.floor(r() * 64))));
        break;
      case 6: // repeat a piece
        b = concatBytes(b.slice(0, at), b.slice(at, at + 1 + Math.floor(r() * 64)), b.slice(at));
        break;
      case 7: // zero a run
        b.fill(0, at, at + 1 + Math.floor(r() * 32));
        break;
      default: // an interesting 16-bit or 8-bit value
        if (r() < 0.5 && at + 2 <= b.length)
          dv.setUint16(at, pick(r, [0, 0xffff, 0x8000, 0x7fff, 1]), true);
        else b[at] = pick(r, [0, 0xff, 0x7f, 0x80, 1]);
    }
  }
  return b;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const JSON_VALUES: unknown[] = [
  null,
  true,
  false,
  0,
  -1,
  1,
  0.5,
  -0.0001,
  1e9,
  -1e9,
  1e308,
  -1e308,
  2147483648,
  "",
  "x",
  "Parameter",
  "PartOpacity",
  "Model",
  "Add",
  "Multiply",
  "Overwrite",
  "ArtMesh",
  [],
  {},
  [0],
  [[]],
  [{}],
  { Id: "P" },
  [1, 2, 3],
  new Array(40).fill(0),
];

/** A copy of a JSON value with 1–4 structural mutations at random paths. */
export function mutateJson(value: unknown, r: () => number): unknown {
  let v = JSON.parse(JSON.stringify(value)) as unknown;
  const n = 1 + Math.floor(r() * 4);
  for (let m = 0; m < n; m++) v = mutateAt(v, r, 0);
  return v;
}

function mutateAt(v: unknown, r: () => number, depth: number): unknown {
  const container = Array.isArray(v) || (v !== null && typeof v === "object");
  // Go deeper most of the time when there is somewhere to go.
  if (container && depth < 12 && r() < 0.75) {
    if (Array.isArray(v)) {
      if (v.length === 0) return r() < 0.5 ? [structuredClone(pick(r, JSON_VALUES))] : v;
      const i = Math.floor(r() * v.length);
      const op = r();
      if (op < 0.1) v.splice(i, 1);
      else if (op < 0.2) v.splice(i, 0, structuredClone(v[i]));
      else if (op < 0.25) v.push(...Array.from({ length: 20 }, () => structuredClone(v[i])));
      else v[i] = mutateAt(v[i], r, depth + 1);
      return v;
    }
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 0) return r() < 0.5 ? { Id: structuredClone(pick(r, JSON_VALUES)) } : o;
    const k = pick(r, keys);
    const op = r();
    if (op < 0.1) delete o[k];
    else o[k] = mutateAt(o[k], r, depth + 1);
    return o;
  }
  // Replace this value.
  if (typeof v === "number" && r() < 0.5)
    return pick(r, [v + 1, v - 1, -v, v * 1000, v / 1000, Math.floor(v), v + 0.5]);
  if (typeof v === "string" && r() < 0.3) return v + pick(r, ["", "/", "../", "x", "\u0000", "é"]);
  return structuredClone(pick(r, JSON_VALUES));
}

// ------------------------------------------------------------------ seeds

const enc = (s: string) => new TextEncoder().encode(s);
const json = (o: unknown) => enc(JSON.stringify(o));

const TRI = [0, 0, 1, 0, 0, 1];

/** Synthetic `.moc3` files of every version, with deformers, glue, blend shapes and offscreens. */
export function mocSeeds(): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const version of [1, 3, 4, 5]) {
    const s = new Synth(version);
    s.part({ id: "Root" });
    const p = s.param("P", -1, 1, 0);
    const band = s.band([s.binding(p, [-1, 0, 1])]);
    s.mesh({
      id: "M",
      band,
      keyforms: [
        { positions: TRI, opacity: 0 },
        { positions: [0, 0, 2, 0, 0, 1], opacity: 1 },
        { positions: [0, 0, 1, 0, 0, 2], opacity: 0.5 },
      ],
    });
    out.push(s.build());
  }
  {
    // Deformers, glue, a repeating parameter, blend shapes with a constraint.
    const s = new Synth(5);
    const root = s.part({ id: "Root" });
    const child = s.part({ id: "Child", parent: root });
    const a = s.param("A", -30, 30, 0);
    const spin = s.param("S", -180, 180, 0, { repeat: true });
    const bs = s.param("B", 0, 1, 0, { type: 1 });
    const c = s.param("C", 0, 1, 0);
    const bandA = s.band([s.binding(a, [-30, 30])]);
    const bandS = s.band([s.binding(spin, [-180, 0, 180])]);
    const w = s.warp({
      id: "W",
      band: bandA,
      rows: 2,
      cols: 2,
      bilinear: true,
      keyforms: [
        { points: [-1, -1, 0, -1, 1, -1, -1, 0, 0, 0, 1, 0, -1, 1, 0, 1, 1, 1] },
        { points: [-1, -1, 0.2, -1, 1, -1, -1, 0, 0.2, 0, 1, 0, -1, 1, 0.2, 1, 1, 1] },
      ],
    });
    const rot = s.rotation({
      id: "R",
      parent: w,
      band: bandS,
      keyforms: [
        { angle: -180, x: 0.5, y: 0.5, scale: 1, opacity: 0.8 },
        { angle: 0, x: 0.5, y: 0.5, scale: 1.2 },
        { angle: 180, x: 0.5, y: 0.5, scale: 1, mirrorX: true },
      ],
    });
    const m1 = s.mesh({ id: "M1", part: child, deformer: rot, keyforms: [{ positions: TRI }] });
    const m2 = s.mesh({
      id: "M2",
      deformer: w,
      keyforms: [{ positions: [0.1, 0.1, 0.9, 0.1, 0.1, 0.9] }],
    });
    s.glue({
      id: "G",
      band: bandA,
      a: m1,
      b: m2,
      pairs: [[1, 0.4, 0, 0.6]],
      intensities: [0.2, 0.9],
    });
    const zero = {
      positions: [0, 0, 0, 0, 0, 0],
      opacity: 0,
      drawOrder: 0,
      multiply: [0, 0, 0] as [number, number, number],
      screen: [0, 0, 0] as [number, number, number],
    };
    s.blendShape("mesh", m2, {
      param: bs,
      keys: [0, 1],
      base: 0,
      keyforms: [zero, { ...zero, opacity: 0.5, positions: [0.1, 0, 0, 0.1, 0, 0] }],
      constraints: [{ param: c, keys: [0, 1], weights: [1, 0.3] }],
    });
    out.push(s.build());
  }
  {
    // Version 6: offscreens and nested parts.
    const s = new Synth(6);
    const root = s.part({ id: "Root" });
    const inner = s.part({ id: "Inner", parent: root });
    const a = s.mesh({ id: "A", part: root, keyforms: [{ positions: TRI }] });
    const b = s.mesh({ id: "B", part: inner, keyforms: [{ positions: TRI, opacity: 0.7 }] });
    s.offscreen({ part: inner, keyforms: [{ opacity: 0.5 }] });
    s.groups = [
      {
        objects: [
          { kind: 0, index: a },
          { kind: 1, index: inner, nested: 1 },
        ],
        min: 0,
        max: 1000,
      },
      { objects: [{ kind: 0, index: b }], min: 0, max: 1000 },
    ];
    out.push(s.build());
  }
  return out;
}

const SETTINGS = {
  Version: 3,
  FileReferences: {
    Moc: "m.moc3",
    Textures: ["t.png"],
    Physics: "m.physics3.json",
    Pose: "m.pose3.json",
    DisplayInfo: "m.cdi3.json",
    UserData: "m.userdata3.json",
    MotionSync: "m.motionsync3.json",
    Expressions: [{ Name: "e", File: "e.exp3.json" }],
    Motions: {
      Idle: [{ File: "idle.motion3.json", FadeInTime: 0.5, FadeOutTime: 0.5 }],
      Tap: [{ File: "tap.motion3.json", Sound: "s.wav", MotionSync: "Talk" }],
    },
  },
  Groups: [
    { Target: "Parameter", Name: "EyeBlink", Ids: ["P"] },
    { Target: "Parameter", Name: "LipSync", Ids: ["A"] },
  ],
  HitAreas: [{ Id: "M", Name: "Body" }],
  Layout: { CenterX: 0, CenterY: 0, Width: 2 },
};

const PHYSICS = {
  Version: 3,
  Meta: {
    PhysicsSettingCount: 1,
    TotalInputCount: 1,
    TotalOutputCount: 1,
    VertexCount: 2,
    Fps: 30,
    EffectiveForces: { Gravity: { X: 0, Y: -1 }, Wind: { X: 0, Y: 0 } },
    PhysicsDictionary: [{ Id: "S1", Name: "Hair" }],
  },
  PhysicsSettings: [
    {
      Id: "S1",
      Input: [{ Source: { Target: "Parameter", Id: "A" }, Weight: 100, Type: "X", Reflect: false }],
      Output: [
        {
          Destination: { Target: "Parameter", Id: "P" },
          VertexIndex: 1,
          Scale: 1,
          Weight: 100,
          Type: "Angle",
          Reflect: false,
        },
      ],
      Vertices: [
        { Position: { X: 0, Y: 0 }, Mobility: 1, Delay: 1, Acceleration: 1, Radius: 0 },
        { Position: { X: 0, Y: 10 }, Mobility: 0.9, Delay: 0.9, Acceleration: 1, Radius: 10 },
      ],
      Normalization: {
        Position: { Minimum: -10, Default: 0, Maximum: 10 },
        Angle: { Minimum: -10, Default: 0, Maximum: 10 },
      },
    },
  ],
};

const POSE = {
  Type: "Live2D Pose",
  FadeInTime: 0.5,
  Groups: [
    [
      { Id: "Root", Link: ["Child"] },
      { Id: "Child", Link: [] },
    ],
  ],
};

const EXPRESSION = {
  Type: "Live2D Expression",
  FadeInTime: 0.5,
  FadeOutTime: 0.5,
  Parameters: [
    { Id: "P", Value: 0.5, Blend: "Add" },
    { Id: "A", Value: 2, Blend: "Multiply" },
    { Id: "C", Value: 1, Blend: "Overwrite" },
  ],
};

const MOTION = {
  Version: 3,
  Meta: {
    Duration: 2,
    Fps: 30,
    Loop: true,
    AreBeziersRestricted: true,
    CurveCount: 3,
    TotalSegmentCount: 6,
    TotalPointCount: 11,
    UserDataCount: 1,
    TotalUserDataSize: 5,
    FadeInTime: 0.3,
    FadeOutTime: 0.3,
  },
  Curves: [
    {
      Target: "Parameter",
      Id: "P",
      Segments: [0, 0, 0, 0.5, 1, 1, 0.6, 0.2, 0.9, 0.8, 1.5, 0, 2, 2, 0.5],
    },
    { Target: "PartOpacity", Id: "Root", FadeInTime: 0.2, Segments: [0, 1, 3, 1, 0, 0, 2, 1] },
    { Target: "Model", Id: "Opacity", Segments: [0, 1, 0, 2, 1] },
  ],
  UserData: [{ Time: 1, Value: "event" }],
};

const DISPLAY_INFO = {
  Version: 3,
  Parameters: [
    { Id: "P", GroupId: "G", Name: "Param P" },
    { Id: "A", GroupId: "", Name: "Angle" },
  ],
  ParameterGroups: [{ Id: "G", GroupId: "", Name: "Group" }],
  Parts: [{ Id: "Root", Name: "Root part" }],
  CombinedParameters: [["P", "A"]],
};

const USER_DATA = {
  Version: 3,
  Meta: { UserDataCount: 1, TotalUserDataSize: 5 },
  UserData: [{ Target: "ArtMesh", Id: "M", Value: "hello" }],
};

const MOTION_SYNC = {
  Version: 1,
  Meta: { SettingCount: 1, DictionaryCount: 1 },
  Dictionary: [{ Id: "Talk", Name: "Talk" }],
  Settings: [
    {
      Id: "Talk",
      AnalysisType: "CRI",
      UseCase: "Mouth",
      CubismParameters: [{ Name: "A", Id: "P", Min: 0, Max: 1, DamperRate: 0.1, Smooth: 50 }],
      AudioParameters: [
        { Name: "Silence", Id: "Silence", Min: 0, Max: 1, Scale: 1, Enabled: true },
        { Name: "A", Id: "A", Min: 0, Max: 1, Scale: 1, Enabled: true },
      ],
      Mappings: [
        { Type: "Shape", Id: "A", Targets: [{ Id: "P", Value: 1 }] },
        { Type: "Shape", Id: "Silence", Targets: [{ Id: "P", Value: 0 }] },
      ],
      PostProcessing: { BlendRatio: 0, Smoothing: 80, SampleRate: 30 },
    },
  ],
};

/** A WAV file: PCM of 8, 16, 24 or 32 bits, or 32-bit float. */
export function wavFile(o: {
  rate: number;
  channels: number;
  bits: 8 | 16 | 24 | 32;
  float?: boolean;
  frames: number;
  extra?: boolean;
}): Uint8Array {
  const bytes = o.bits / 8;
  const data = o.frames * o.channels * bytes;
  const extra = o.extra ? 12 : 0; // a LIST chunk before data
  const b = new Uint8Array(44 + extra + data);
  const dv = new DataView(b.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => (b[at + i] = c.charCodeAt(0)));
  text(0, "RIFF");
  dv.setUint32(4, 36 + extra + data, true);
  text(8, "WAVE");
  text(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, o.float ? 3 : 1, true);
  dv.setUint16(22, o.channels, true);
  dv.setUint32(24, o.rate, true);
  dv.setUint32(28, o.rate * o.channels * bytes, true);
  dv.setUint16(32, o.channels * bytes, true);
  dv.setUint16(34, o.bits, true);
  let at = 36;
  if (o.extra) {
    text(at, "LIST");
    dv.setUint32(at + 4, 4, true);
    text(at + 8, "INFO");
    at += 12;
  }
  text(at, "data");
  dv.setUint32(at + 4, data, true);
  at += 8;
  for (let i = 0; i < o.frames * o.channels; i++) {
    const v = Math.sin(i / 7) * 0.8;
    const p = at + i * bytes;
    if (o.float) dv.setFloat32(p, v, true);
    else if (o.bits === 8) b[p] = Math.round(128 + v * 127);
    else if (o.bits === 16) dv.setInt16(p, Math.round(v * 32767), true);
    else if (o.bits === 24) {
      const x = Math.round(v * 8388607);
      b[p] = x & 0xff;
      b[p + 1] = (x >> 8) & 0xff;
      b[p + 2] = (x >> 16) & 0xff;
    } else dv.setInt32(p, Math.round(v * 2147483647), true);
  }
  return b;
}

function wavSeeds(): Uint8Array[] {
  return [
    wavFile({ rate: 16000, channels: 1, bits: 16, frames: 400 }),
    wavFile({ rate: 44100, channels: 2, bits: 16, frames: 200, extra: true }),
    wavFile({ rate: 8000, channels: 1, bits: 8, frames: 300 }),
    wavFile({ rate: 48000, channels: 2, bits: 24, frames: 150 }),
    wavFile({ rate: 22050, channels: 1, bits: 32, frames: 150 }),
    wavFile({ rate: 48000, channels: 1, bits: 32, float: true, frames: 150 }),
  ];
}

function zipSeeds(): Uint8Array[] {
  const files = {
    "model/m.model3.json": strToU8(JSON.stringify(SETTINGS)),
    "model/e.exp3.json": strToU8(JSON.stringify(EXPRESSION)),
    "model/sub/data.bin": new Uint8Array(300).map((_, i) => (i * 37) & 0xff),
    "model/é名前.txt": strToU8("名前"),
  };
  return [
    zipSync(files, { level: 0 }),
    zipSync(files, { level: 6 }),
    zipSync({ "a.txt": strToU8("a".repeat(500)) }, { level: 9 }),
  ];
}

// ---------------------------------------------------------------- targets

/** A loader and its seeds. `run` throws only documented errors on any input. */
export interface FuzzTarget {
  name: string;
  /** What `run` may throw. */
  allowed: readonly (abstract new (...args: never[]) => Error)[];
  seeds(): Uint8Array[];
  /** Mutate a seed: bytes, or the JSON tree (then bytes, sometimes). */
  mutate(seed: Uint8Array, r: () => number): Uint8Array;
  run(input: Uint8Array): void | Promise<void>;
}

const byteMutation = (seed: Uint8Array, r: () => number) => mutateBytes(seed, r);

function jsonMutation(seed: Uint8Array, r: () => number): Uint8Array {
  if (r() < 0.25) return mutateBytes(seed, r);
  let tree: unknown;
  try {
    tree = JSON.parse(new TextDecoder().decode(seed));
  } catch {
    // An earlier round broke the text: keep mutating its bytes.
    return mutateBytes(seed, r);
  }
  const out = json(mutateJson(tree, r));
  return r() < 0.1 ? mutateBytes(out, r) : out;
}

function jsonTarget(name: string, value: unknown, run: (bytes: Uint8Array) => unknown): FuzzTarget {
  return {
    name,
    allowed: [AnimationFormatError],
    seeds: () => [json(value)],
    mutate: jsonMutation,
    run: (b) => void run(b),
  };
}

/** Evaluates a loaded model a few times with parameters at their limits and beyond. */
function exercise(bytes: Uint8Array): void {
  const model = loadMoc(bytes, { nonFiniteOpacity: "load", offscreenKeyformRange: "load" });
  const inst = new ModelInstance(model);
  const n = model.parameters.ids.length;
  for (const pose of [0, 1, 2]) {
    for (let i = 0; i < n; i++) {
      const lo = model.parameters.min[i]!;
      const hi = model.parameters.max[i]!;
      inst.setParameter(i, pose === 0 ? lo : pose === 1 ? hi : hi + (hi - lo) * 1.5);
    }
    inst.evaluate();
  }
}

/** A synthetic model folder: settings, the 5th moc seed, physics, pose, expression, motions, data, a sound. */
export function modelFiles(moc: Uint8Array): Record<string, Uint8Array> {
  return {
    "m.model3.json": json(SETTINGS),
    "m.moc3": moc,
    "m.physics3.json": json(PHYSICS),
    "m.pose3.json": json(POSE),
    "m.cdi3.json": json(DISPLAY_INFO),
    "m.userdata3.json": json(USER_DATA),
    "m.motionsync3.json": json(MOTION_SYNC),
    "e.exp3.json": json(EXPRESSION),
    "idle.motion3.json": json(MOTION),
    "tap.motion3.json": json(MOTION),
    "s.wav": wavFile({ rate: 16000, channels: 1, bits: 16, frames: 1600 }),
  };
}

const BUNDLE_FILES = Object.keys(modelFiles(new Uint8Array()));

export const TARGETS: readonly FuzzTarget[] = [
  {
    name: "moc3",
    allowed: [MocFormatError],
    seeds: mocSeeds,
    mutate: byteMutation,
    run: (b) => {
      // The lenient reader and the validator first, then the loader and evaluation.
      const read = readMoc(b);
      if (read.data) {
        validateMoc(read.data, { level: "strict" });
        if (WRITABLE_VERSIONS.includes(read.version)) {
          try {
            writeMoc(read.data, { version: read.version });
          } catch (e) {
            // Data the writer can't express is refused with its documented error.
            if (!(e instanceof MocWriteError)) throw e;
          }
        }
      }
      exercise(b);
    },
  },
  {
    name: "settings",
    allowed: [SettingsFormatError],
    seeds: () => [json(SETTINGS)],
    mutate: jsonMutation,
    run: (b) => void parseModelSettings(b),
  },
  jsonTarget("physics", PHYSICS, (b) => parsePhysics(b)),
  jsonTarget("pose", POSE, (b) => parsePose(b)),
  jsonTarget("expression", EXPRESSION, (b) => parseExpression(b)),
  jsonTarget("motion", MOTION, (b) => parseMotion(b)),
  jsonTarget("display-info", DISPLAY_INFO, (b) => parseDisplayInfo(b)),
  jsonTarget("user-data", USER_DATA, (b) => parseUserData(b)),
  jsonTarget("motion-sync", MOTION_SYNC, (b) => parseMotionSync(b, "motion sync", { lint: true })),
  {
    name: "zip",
    allowed: [ZipFormatError, UnsupportedArchiveError],
    seeds: zipSeeds,
    mutate: byteMutation,
    run: async (b) => {
      const source = sourceFromZip("fuzz.zip", b);
      for (const path of source.list() ?? []) {
        try {
          await source.read(path);
        } catch (e) {
          // A listed entry whose data is broken: the documented errors only.
          if (!(e instanceof ZipFormatError) && !(e instanceof FileNotFoundError)) throw e;
        }
      }
    },
  },
  {
    name: "wav",
    allowed: [WavFormatError, MotionSyncAudioError],
    seeds: wavSeeds,
    mutate: byteMutation,
    run: (b) => {
      try {
        decodeWav(b);
      } catch (e) {
        if (!(e instanceof WavFormatError)) throw e;
      }
      decodeMotionSyncWav(b);
    },
  },
  {
    name: "model",
    // The runtime refuses a broken model file or settings; other files only warn.
    allowed: [MocFormatError, SettingsFormatError, FileNotFoundError],
    seeds: () => {
      // One seed per file of the folder, each encoded as [file index, …bytes].
      const files = modelFiles(mocSeeds()[4]!);
      return BUNDLE_FILES.map((name, i) => concatBytes(new Uint8Array([i]), files[name]!));
    },
    mutate: (seed, r) => {
      const name = BUNDLE_FILES[seed[0]!]!;
      const body = seed.subarray(1);
      const mutated = name.endsWith(".json") ? jsonMutation(body, r) : mutateBytes(body, r);
      return concatBytes(new Uint8Array([seed[0]!]), mutated);
    },
    run: async (b) => {
      const files = modelFiles(mocSeeds()[4]!);
      const name = BUNDLE_FILES[b[0]! % BUNDLE_FILES.length]!;
      files[name] = b.subarray(1);
      const rt = await ModelRuntime.load(MemoryFileSource.fromFiles(files), "m.model3.json");
      await rt.setExpression("e").catch(() => {});
      await rt.startMotion("Tap", 0).catch(() => {});
      for (let i = 0; i < 5; i++) rt.update(1 / 30);
    },
  },
];

// ---------------------------------------------------------------- running

export interface FuzzFailure {
  target: string;
  /** Why: the exception's name and message, "slow", or "memory". */
  reason: string;
  input: Uint8Array;
  ms: number;
}

export interface FuzzOptions {
  iterations: number;
  seed: number;
  /** Per input, in milliseconds. */
  timeLimit: number;
  /** Bytes of live memory an input may leave behind, besides 1,000 times its size. */
  memoryLimit?: number;
  /** Called before each input (the long run records it, to name a hang). */
  before?: (input: Uint8Array, i: number) => void;
  /** Stop at the first failure. */
  stopEarly?: boolean;
}

const live = () => {
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};

/** Runs `iterations` mutated inputs through a target; returns its failures. */
export async function fuzz(target: FuzzTarget, o: FuzzOptions): Promise<FuzzFailure[]> {
  const r = prng(o.seed);
  const seeds = target.seeds();
  const failures: FuzzFailure[] = [];
  const gc = (globalThis as { gc?: () => void }).gc;
  for (let i = 0; i < o.iterations; i++) {
    let input = pick(r, seeds);
    const rounds = 1 + Math.floor(r() * 3);
    for (let k = 0; k < rounds; k++) input = target.mutate(input, r);
    o.before?.(input, i);
    gc?.();
    const m0 = gc ? live() : 0;
    const t0 = performance.now();
    let reason: string | null = null;
    let kept: unknown = null;
    try {
      kept = await target.run(input);
    } catch (e) {
      if (!target.allowed.some((E) => e instanceof E))
        reason = e instanceof Error ? `${e.name}: ${e.message}` : `thrown ${String(e)}`;
    }
    const ms = performance.now() - t0;
    if (!reason && ms > o.timeLimit) reason = `slow: ${ms.toFixed(0)} ms`;
    if (!reason && gc) {
      const grown = live() - m0;
      if (grown > (o.memoryLimit ?? 64 * 2 ** 20) + 1000 * input.length)
        reason = `memory: ${(grown / 2 ** 20).toFixed(0)} MiB left by a ${input.length}-byte input`;
    }
    void kept;
    if (reason) {
      failures.push({ target: target.name, reason, input, ms });
      if (o.stopEarly) break;
    }
  }
  return failures;
}
