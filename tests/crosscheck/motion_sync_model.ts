/**
 * Motion sync on a model, Mochi2D's side: the crafted settings of Mochi2D's
 * model tests (ds-motionsync: ds-two and the group "Talk", whose entries
 * link sounds to settings by name and by ID, and one without a link; a
 * broken link; no motion-sync file) over DeepSeek-chan, or without one over
 * a synthetic package with DeepSeek-chan's mouth parameters, a lip physics
 * output and motions at the same paths. Each case starts a "Talk" entry as
 * Mochi2D's runtime does and records, every frame, the mouth parameters
 * (who writes them), the latest motion-sync tick, the bound setting and the
 * motions playing.
 *
 * usage: node motion_sync_model.mjs <outDir> [--model <DeepSeek-chan's folder>]
 * Writes <outDir>/package (the model's files, copied, with the crafted ones;
 * never committed), <outDir>/cases.txt (name, then `mochi2d-native
 * motion-sync-play` arguments, tab-separated) and <outDir>/reference/<name>.json.
 * tests/crosscheck/motion_sync_model.sh runs both sides and compares them.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// The reference's `mochi2d/headless` and `mochi2d/node` exports (src/lib/).
import {
  ModelRuntime,
  VOWEL_FORMANTS,
  VoiceCalibration,
  synthesizeVowel,
  voiceProfileFromJson,
} from "../../reference/mochi2d-0.21.0/src/lib/headless.js";
import { sourceFromFolder } from "../../reference/mochi2d-0.21.0/src/lib/node.js";
import { Synth } from "../../reference/mochi2d-0.21.0/test/support/synth.js";
import {
  FEMALE,
  MALE,
  TALK_SOUNDS,
  VOWELS,
  dsMotionSyncSettings,
  dsTwo,
  silence,
  vowelClip,
  wavFile,
  whiteNoise,
} from "../../reference/mochi2d-0.21.0/test/support/motion-sync.js";

const args = process.argv.slice(2);
const out = args[0];
if (!out) {
  console.error("usage: node motion_sync_model.mjs <outDir> [--model <folder>]");
  process.exit(2);
}
const modelArg = args.indexOf("--model");
const modelDir = modelArg >= 0 ? args[modelArg + 1] : undefined;
const pkg = join(out, "package");
const reference = join(out, "reference");
mkdirSync(pkg, { recursive: true });
mkdirSync(reference, { recursive: true });

// --------------------------------------------------------------- package

let own: Record<string, unknown>;
if (modelDir) {
  cpSync(modelDir, pkg, { recursive: true });
  const name = readdirSync(pkg).find((f) => f.endsWith(".model3.json"));
  if (!name) throw new Error(`${modelDir}: no *.model3.json file`);
  own = JSON.parse(readFileSync(join(pkg, name), "utf8").replace(/^﻿/, ""));
} else {
  // A synthetic stand-in: DeepSeek-chan's mouth parameters, a lip physics
  // output fed by the mouth's opening, and motions at the crafted paths.
  const s = new Synth(4);
  s.part({ id: "P" });
  s.param("ParamAngleX", -30, 30, 0);
  s.param("ParamMouthOpenY", 0, 1, 0);
  s.param("ParamMouthForm", -1, 1, 0);
  s.param("MouthFunnel", 0, 1, 0);
  s.param("Mouthpucker", 0, 1, 0);
  s.param("MouthPuckerWiden", -1, 1, 0);
  s.param("LipPhysics1", -10, 10, 0);
  s.mesh({ id: "M", keyforms: [{ positions: [0, 0, 1, 0, 0, 1] }] });
  writeFileSync(join(pkg, "synth.moc3"), s.build());
  const curve = (id: string, points: [number, number][]) => {
    const seg: number[] = [points[0]![0], points[0]![1]];
    for (const [t, v] of points.slice(1)) seg.push(0, t, v);
    return { Target: "Parameter", Id: id, Segments: seg };
  };
  const motion = (duration: number, curves: ReturnType<typeof curve>[]) => ({
    Version: 3,
    Meta: {
      Duration: duration,
      Fps: 30,
      Loop: false,
      AreBeziersRestricted: true,
      CurveCount: curves.length,
      TotalSegmentCount: curves.reduce((n, c) => n + (c.Segments.length - 2) / 3, 0),
      TotalPointCount: curves.reduce((n, c) => n + 1 + (c.Segments.length - 2) / 3, 0),
      UserDataCount: 0,
      TotalUserDataSize: 0,
      FadeInTime: 0.5,
      FadeOutTime: 0.5,
    },
    Curves: curves,
  });
  mkdirSync(join(pkg, "Animation"), { recursive: true });
  writeFileSync(
    join(pkg, "Animation/IDLE.motion3.json"),
    JSON.stringify(
      motion(4, [
        curve("ParamAngleX", [[0, 0], [2, 12], [4, 0]]),
        curve("ParamMouthForm", [[0, 0.2], [4, -0.2]]),
      ]),
    ),
  );
  writeFileSync(
    join(pkg, "Animation/脱捕.motion3.json"),
    JSON.stringify(
      motion(6, [
        curve("ParamMouthOpenY", [[0, 0], [1, 0.6], [2, 0.1], [4, 0.8], [6, 0]]),
        curve("ParamMouthForm", [[0, -0.5], [3, 0.5], [6, 0]]),
        curve("MouthFunnel", [[0, 0], [3, 0.4], [6, 0]]),
        curve("ParamAngleX", [[0, 0], [6, -20]]),
      ]),
    ),
  );
  writeFileSync(
    join(pkg, "Animation/举手切默认手.motion3.json"),
    JSON.stringify(motion(2, [curve("ParamAngleX", [[0, 0], [1, 25], [2, 0]])])),
  );
  writeFileSync(
    join(pkg, "synth.physics3.json"),
    JSON.stringify({
      Version: 3,
      Meta: {
        PhysicsSettingCount: 1,
        TotalInputCount: 1,
        TotalOutputCount: 1,
        VertexCount: 2,
        Fps: 30,
        EffectiveForces: { Gravity: { X: 0, Y: -1 }, Wind: { X: 0, Y: 0 } },
        PhysicsDictionary: [{ Id: "PhysicsSetting1", Name: "Lip" }],
      },
      PhysicsSettings: [
        {
          Id: "PhysicsSetting1",
          Input: [
            { Source: { Target: "Parameter", Id: "ParamMouthOpenY" }, Weight: 100, Type: "X", Reflect: false },
          ],
          Output: [
            {
              Destination: { Target: "Parameter", Id: "LipPhysics1" },
              VertexIndex: 1,
              Scale: 10,
              Weight: 100,
              Type: "Angle",
              Reflect: false,
            },
          ],
          Vertices: [
            { Position: { X: 0, Y: 0 }, Mobility: 1, Delay: 1, Acceleration: 1, Radius: 0 },
            { Position: { X: 0, Y: 3 }, Mobility: 0.9, Delay: 0.6, Acceleration: 1.5, Radius: 3 },
          ],
          Normalization: {
            Position: { Minimum: -1, Default: 0, Maximum: 1 },
            Angle: { Minimum: -10, Default: 0, Maximum: 10 },
          },
        },
      ],
    }),
  );
  own = {
    Version: 3,
    FileReferences: { Moc: "synth.moc3", Textures: [], Physics: "synth.physics3.json" },
    Groups: [{ Target: "Parameter", Name: "LipSync", Ids: ["ParamMouthOpenY"] }],
  };
}

// The crafted files of Mochi2D's model tests, for each variant of the model's
// own settings: DeepSeek-chan's as they are (its LipSync group has no IDs);
// the synthetic package's with a LipSync group, with an empty one and with
// none (the last two reach Mochi2D's runtime option lipSyncFallback).
const variants: Record<string, Record<string, unknown>> = { "": own };
if (!modelDir) {
  const groups = (ids: string[] | null) => {
    const o = JSON.parse(JSON.stringify(own));
    if (ids) o.Groups = [{ Target: "Parameter", Name: "LipSync", Ids: ids }];
    else delete o.Groups;
    return o;
  };
  variants["empty-lip-"] = groups([]);
  variants["no-lip-"] = groups(null);
}
for (const [prefix, base] of Object.entries(variants)) {
  const settings = dsMotionSyncSettings(base) as { FileReferences: Record<string, any> };
  const broken = JSON.parse(JSON.stringify(settings));
  broken.FileReferences.Motions.Talk = [
    { File: "Animation/IDLE.motion3.json", Sound: TALK_SOUNDS.male, MotionSync: "Nope" },
  ];
  const noFile = JSON.parse(JSON.stringify(settings));
  delete noFile.FileReferences.MotionSync;
  writeFileSync(join(pkg, `${prefix}ds-motionsync.model3.json`), JSON.stringify(settings));
  writeFileSync(join(pkg, `${prefix}ds-broken-link.model3.json`), JSON.stringify(broken));
  writeFileSync(join(pkg, `${prefix}ds-no-file.model3.json`), JSON.stringify(noFile));
}
writeFileSync(join(pkg, "ds-two.motionsync3.json"), JSON.stringify(dsTwo()));
mkdirSync(join(pkg, "sounds"), { recursive: true });
writeFileSync(join(pkg, TALK_SOUNDS.male), wavFile([vowelClip(MALE, 16000).samples], 16000));
writeFileSync(join(pkg, TALK_SOUNDS.female), wavFile([vowelClip(FEMALE, 48000).samples], 48000));
writeFileSync(join(pkg, TALK_SOUNDS.noise), wavFile([whiteNoise(2, 44100, -20)], 44100));
writeFileSync(join(pkg, TALK_SOUNDS.silence), wavFile([silence(2, 44100)], 44100));
// A voice profile (a calibrated male voice), for the case with one.
const cal = new VoiceCalibration("male");
for (const v of VOWELS)
  cal.add(v, [synthesizeVowel(VOWEL_FORMANTS[v], 1, 48000, { f0: MALE.f0 * 1.04 })], 48000);
const profilePath = join(out, "profile-male.json");
writeFileSync(profilePath, JSON.stringify(cal.profile()));

// ------------------------------------------------------------------ cases

const MOUTH = ["ParamMouthOpenY", "ParamMouthForm", "MouthFunnel", "Mouthpucker", "MouthPuckerWiden", "LipPhysics1"];

interface Case {
  settings?: string;
  index: number;
  seconds: number;
  motionSyncOff?: boolean;
  beforePhysics?: boolean;
  profile?: string;
  /** Another entry started before the frame at `at` seconds, with this priority. */
  then?: { index: number; at: number; priority: number };
}

async function play(c: Case): Promise<string> {
  const source = await sourceFromFolder(pkg);
  const rt = await ModelRuntime.load(source, c.settings ?? "ds-motionsync.model3.json", {
    ...(c.beforePhysics ? { animation: { motionSync: { beforePhysics: true } } } : {}),
  });
  for (const e of ["eyeBlink", "breath", "look", "idle"] as const) rt.setEffect(e, false);
  if (c.motionSyncOff) rt.setEffect("motionSync", false);
  if (c.profile) rt.setVoiceProfile(voiceProfileFromJson(JSON.parse(readFileSync(c.profile, "utf8"))));
  const r = rt as any;
  const result: Record<string, unknown> = {};
  try {
    result.accepted = (await rt.startMotion("Talk", c.index)) !== false;
  } catch (e) {
    result.accepted = false;
    result.startError = e instanceof Error ? e.message : String(e);
  }
  const frames: unknown[] = [];
  const dt = 1 / 60;
  let thenDone = false;
  for (let n = 1; n <= Math.ceil(c.seconds * 60); n++) {
    if (c.then && !thenDone && (n - 1) * dt >= c.then.at) {
      await rt.startMotion("Talk", c.then.index, { priority: c.then.priority });
      thenDone = true;
    }
    rt.update(dt);
    const tick = rt.motionSync;
    let t: unknown = null;
    if (tick) {
      const list = r.bundle.motionSync.settings as { id: string; name: string; parameters: { id: string }[] }[];
      const s = list.find((x) => x.id === tick.setting.id && x.name === tick.setting.name)!;
      t = {
        setting: list.indexOf(s),
        level: tick.level,
        silent: tick.silent,
        weights: ["Silence", "A", "I", "U", "E", "O"].map((e) => (tick.weights as any)[e]),
        values: s.parameters.map((p) => tick.values[p.id]!),
        time: tick.time,
      };
    }
    frames.push({
      frame: n,
      mouth: MOUTH.map((id) => rt.getParameter(id)),
      tick: t,
      bound: r.animator.motionSync?.setting?.index ?? -1,
      motions: r.animator.motions.motions.length,
    });
  }
  result.warnings = rt.warnings;
  result.frames = frames;
  return JSON.stringify(result) + "\n";
}

function cliArgs(c: Case): string[] {
  const a = ["motion-sync-play", join(pkg, c.settings ?? "ds-motionsync.model3.json")];
  a.push("--group", "Talk", "--index", String(c.index), "--seconds", String(c.seconds));
  if (c.motionSyncOff) a.push("--motion-sync-off");
  if (c.beforePhysics) a.push("--before-physics");
  if (c.profile) a.push("--profile", c.profile);
  if (c.then) a.push("--then", `Talk:${c.then.index}@${c.then.at}:${c.then.priority}`);
  return a;
}

const CASES: Record<string, Case> = {
  // T15: motion sync writes the mouth over the motion's curves, and gives them back once settled.
  "talk1-female-rich": { index: 1, seconds: 7.9 },
  "talk1-motion-sync-off": { index: 1, seconds: 3, motionSyncOff: true },
  "talk1-before-physics": { index: 1, seconds: 3, beforePhysics: true },
  // T19: entries with the same motion file each use their own sound and setting (by name, by ID).
  "talk0-male-basic": { index: 0, seconds: 7 },
  "talk2-noise-by-id": { index: 2, seconds: 3 },
  // T20: an entry without a link plays its sound without motion sync.
  "talk3-no-link": { index: 3, seconds: 2 },
  "broken-link": { settings: "ds-broken-link.model3.json", index: 0, seconds: 1 },
  "no-file": { settings: "ds-no-file.model3.json", index: 1, seconds: 2 },
  // A motion replaced early fades its sound out over its fade-out time, then the mouth settles.
  replaced: { index: 0, seconds: 4, then: { index: 3, at: 1, priority: 3 } },
  "replaced-by-linked": { index: 1, seconds: 5, then: { index: 0, at: 2, priority: 3 } },
  "profile-male": { index: 0, seconds: 4, profile: profilePath },
};

const lines: string[] = [];
for (const prefix of Object.keys(variants))
  for (const [name, base] of Object.entries(CASES)) {
    const c = { ...base, settings: prefix + (base.settings ?? "ds-motionsync.model3.json") };
    writeFileSync(join(reference, `${prefix}${name}.json`), await play(c));
    lines.push([prefix + name, ...cliArgs(c)].join("\t"));
  }
writeFileSync(join(out, "cases.txt"), lines.join("\n") + "\n");
console.log(`${lines.length} cases on ${modelDir ? "the model" : "a synthetic package"}`);
