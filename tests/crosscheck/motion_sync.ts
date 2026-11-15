/**
 * Motion-sync cross-check, Mochi2D's side: synthetic sounds (the reference's
 * own test support: vowels of a male and a female voice, glides, white and
 * pink noise, silence, a tone, bursts, mixes, stereo, quiet, loud and
 * clipped clips, at 8 to 192 kHz and in several WAV encodings), the crafted
 * motion-sync files (ds-basic, ds-rich, ds-two and variants), voice
 * profiles from calibration recordings, and the traces of Mochi2D's
 * motion-sync driver over them: every analysis (raw weights, voicing,
 * openness, level, features), the weights and values reported, and the
 * values written after each frame.
 *
 * usage: node motion_sync.mjs <outDir>
 * Writes <outDir>/inputs (WAV files, motion-sync files, profiles),
 * <outDir>/cases.txt (one case per line: name, then the trace tool's
 * arguments, tab-separated) and <outDir>/reference/<name>.json (Mochi2D's
 * output, as `mochi2d-native motion-sync-trace` or `voice-profile` prints it).
 * tests/crosscheck/motion_sync.sh runs mochi2d-native on the same cases and
 * compares byte for byte. Nothing it writes is committed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// The reference's `mochi2d/headless` exports (src/lib/headless.ts); AnimationValues,
// which the driver takes, is not among them and comes from its module.
import {
  MOTION_SYNC_ELEMENTS,
  MotionSyncDriver,
  VOWEL_FORMANTS,
  VoiceCalibration,
  VowelAnalyzer,
  decodeMotionSyncWav,
  findMotionSyncSetting,
  neutralVoiceProfile,
  parseMotionSync,
  synthesizeVowel,
  voiceProfileFromJson,
  type Analysis,
  type MotionSyncInput,
  type MotionSyncTick,
} from "../../reference/mochi2d-0.21.0/src/lib/headless.js";
import { AnimationValues } from "../../reference/mochi2d-0.21.0/src/anim/values.js";
import {
  BASIC,
  FEMALE,
  MALE,
  RICH,
  VOWELS,
  burstClip,
  clipped,
  concat,
  dsBasic,
  dsRich,
  dsTwo,
  edited,
  glideClip,
  limit,
  motionSyncJson,
  pinkNoise,
  silence,
  toLevel,
  tone,
  vowelClip,
  wavFile,
  whiteNoise,
  type WavEncoding,
} from "../../reference/mochi2d-0.21.0/test/support/motion-sync.js";

const out = process.argv[2];
if (!out) {
  console.error("usage: node motion_sync.mjs <outDir>");
  process.exit(2);
}
const inputs = join(out, "inputs");
const reference = join(out, "reference");
mkdirSync(inputs, { recursive: true });
mkdirSync(reference, { recursive: true });

// ------------------------------------------------------------------ inputs

const sounds: Record<string, string> = {};
const sound = (name: string, channels: Float32Array[], rate: number, enc: WavEncoding = "float32") => {
  const path = join(inputs, `${name}.wav`);
  writeFileSync(path, wavFile(channels, rate, enc));
  sounds[name] = path;
};
const male16 = vowelClip(MALE, 16000);
sound("male-16k", [male16.samples], 16000);
sound("female-48k", [vowelClip(FEMALE, 48000).samples], 48000);
sound("male-44k-pcm16", [vowelClip(MALE, 44100).samples], 44100, "pcm16");
sound("female-22k-pcm24", [vowelClip(FEMALE, 22050).samples], 22050, "pcm24");
sound("male-8k", [vowelClip(MALE, 8000).samples], 8000);
sound("male-192k-ai", [vowelClip(MALE, 192000, { vowels: ["A", "I"], hold: 0.5 }).samples], 192000);
sound("glide-44k", [glideClip(MALE, 6, 44100)], 44100);
sound("glide-female-48k-pcm32", [glideClip(FEMALE, 4, 48000)], 48000, "pcm32");
sound("white-20", [whiteNoise(2, 44100, -20)], 44100);
sound("pink-30", [pinkNoise(2, 16000, -30, 5)], 16000);
sound("silence", [silence(2, 44100)], 44100);
sound("quiet-40", [vowelClip(MALE, 16000, { level: -40 }).samples], 16000);
sound("quiet-55", [vowelClip(MALE, 16000, { level: -55 }).samples], 16000);
const loud = limit(toLevel(male16.samples, -6), -1, 16000);
sound("loud", [loud], 16000);
sound("clipped", [clipped(loud, 6)], 16000);
const noisy = male16.samples.map((v, i) => v);
const noise = whiteNoise(noisy.length / 16000, 16000, -38, 9);
sound("male-in-noise", [Float32Array.from(noisy, (v, i) => v + noise[i]!)], 16000);
sound("tone-440", [tone(440, 1.5, 16000, -20)], 16000);
sound("bursts", [burstClip(16000, 8)], 16000);
sound("dc", [Float32Array.from(male16.samples, (v) => v + 0.1)], 16000);
const left = vowelClip(MALE, 48000, { vowels: ["A"], hold: 1.2 }).samples;
const right = vowelClip(MALE, 48000, { vowels: ["O"], hold: 1.2 }).samples;
sound("stereo-a-o", [left, right], 48000);
sound("stereo-8bit", [left, Float32Array.from(left, (v) => -v)], 48000, "pcm8");
sound("float64-16k", [vowelClip(FEMALE, 16000, { vowels: ["E", "U"] }).samples], 16000, "float64");
sound("short", [vowelClip(MALE, 16000, { vowels: ["A"], hold: 0.02, gap: 0.01 }).samples], 16000);

const files: Record<string, string> = {};
const motionSync = (name: string, json: unknown) => {
  const path = join(inputs, `${name}.motionsync3.json`);
  writeFileSync(path, JSON.stringify(json));
  files[name] = path;
};
motionSync("ds-basic", dsBasic());
motionSync("ds-rich", dsRich());
motionSync("ds-two", dsTwo());
motionSync(
  "brisk",
  edited(dsBasic(), (j) => {
    j.Settings[0].PostProcessing.Smoothing = 1;
    for (const p of j.Settings[0].CubismParameters) p.Smooth = 0;
  }),
);
motionSync(
  "odd",
  edited(dsRich(), (j) => {
    const s = j.Settings[0];
    s.AudioParameters[1].Enabled = false;
    s.AudioParameters[2].Scale = 3;
    s.AudioParameters[5].Id = "Ah";
    s.CubismParameters[0].Damper = 0.08;
    s.CubismParameters[1].Smooth = 90;
    s.PostProcessing.BlendRatio = 1;
    s.PostProcessing.Smoothing = 100;
    s.PostProcessing.SampleRate = 24;
  }),
);
motionSync(
  "fast",
  edited(motionSyncJson({ ...BASIC, sampleRate: 120, blendRatio: 0, smoothing: 20 }), () => {}),
);
motionSync(
  "slow-rich",
  edited(motionSyncJson({ ...RICH, sampleRate: 7.5, blendRatio: 0.8 }), (j) => {
    j.Settings[0].Mappings.reverse();
  }),
);

// Calibration recordings and the profiles made from them (by Mochi2D; the
// native side makes its own with `voice-profile` and both are compared).
const recordings: Record<string, string> = {};
for (const [name, voice, rate] of [
  ["male", MALE, 48000],
  ["female", FEMALE, 44100],
] as const)
  for (const v of VOWELS) {
    const path = join(inputs, `cal-${name}-${v}.wav`);
    writeFileSync(
      path,
      wavFile(
        [
          synthesizeVowel(VOWEL_FORMANTS[v], 1.2, rate, {
            f0: voice.f0 * 1.04,
            formantScale: voice.formantScale,
          }),
        ],
        rate,
        "float32",
      ),
    );
    recordings[`${name}-${v}`] = path;
  }
{
  const path = join(inputs, "cal-room.wav");
  writeFileSync(path, wavFile([pinkNoise(1, 44100, -50, 3)], 44100, "float32"));
  recordings.room = path;
}

// ------------------------------------------------------------------- trace

/** The latest analysis of any analyzer (the driver keeps its own private). */
let lastAnalysis: Analysis | null = null;
const analyze = VowelAnalyzer.prototype.analyze;
VowelAnalyzer.prototype.analyze = function (this: VowelAnalyzer, ...args: Parameters<typeof analyze>) {
  const a = analyze.apply(this, args);
  lastAnalysis = a;
  return a;
};

interface TraceOptions {
  setting?: string;
  fps?: number;
  seconds?: number;
  profile?: string;
  gate?: number;
  hangover?: number;
  settleTime?: number;
  /** The file's per-parameter Smooth; unset: the driver's default (off since 0.20.0). */
  fileSmoothing?: boolean;
  live?: boolean;
  stopAt?: number;
  fade?: number;
}

function trace(wav: string, filePath: string, o: TraceOptions): string {
  const s = decodeMotionSyncWav(readFileSync(wav));
  const file = parseMotionSync(readFileSync(filePath), "ms");
  const setting =
    o.setting !== undefined
      ? findMotionSyncSetting(file, o.setting)
      : (file.settings.find((x) => x.usable) ?? null);
  if (!setting) throw new Error("no setting");
  // A model with the setting's parameters: their ranges as the file gives them, defaults 0.
  const ids: string[] = [];
  const min: number[] = [];
  const max: number[] = [];
  for (const p of setting.parameters) {
    if (ids.includes(p.id)) continue;
    ids.push(p.id);
    min.push(Math.min(p.min, p.max));
    max.push(Math.max(p.min, p.max));
  }
  const model = {
    parameters: { ids, min, max, defaults: ids.map(() => 0), repeat: ids.map(() => 0) },
    parts: { ids: [], initialOpacity: [] },
  };
  const values = new AnimationValues(model as never);
  const driver = new MotionSyncDriver(file, values, {
    ...(o.gate !== undefined ? { gate: o.gate } : {}),
    ...(o.hangover !== undefined ? { hangover: o.hangover } : {}),
    settleTime: o.settleTime ?? 0.5,
    ...(o.fileSmoothing !== undefined ? { fileSmoothing: o.fileSmoothing } : {}),
    profile: o.profile ? voiceProfileFromJson(JSON.parse(readFileSync(o.profile, "utf8"))) : null,
  });
  let frame = 0;
  const ticks: unknown[] = [];
  driver.onTick((t: MotionSyncTick) => {
    const a = lastAnalysis!;
    ticks.push({
      frame,
      time: t.time,
      level: t.level,
      silent: t.silent,
      raw: [...a.raw],
      voicing: a.voicing,
      open: a.open,
      periodicity: a.features.periodicity,
      bands: [...a.features.bands],
      spectrum: [...a.features.spectrum],
      weights: MOTION_SYNC_ELEMENTS.map((e) => t.weights[e]),
      values: setting.parameters.map((p) => t.values[p.id]!),
    });
  });
  const fps = o.fps ?? 60;
  let block: number[] = [];
  const input: MotionSyncInput = {
    sampleRate: s.sampleRate,
    read() {
      const b = block;
      block = [];
      return b;
    },
  };
  const bound = o.live ? driver.setInput(setting, input) : driver.playSound(setting, s);
  if (!bound) throw new Error("the setting cannot run");
  const length = (s.channels[0]?.length ?? 0) / s.sampleRate;
  const seconds = o.seconds ?? length + 1;
  const dt = 1 / fps;
  const frames = Math.ceil(seconds * fps);
  const written: number[][] = [];
  let stopped = false;
  for (let n = 1; n <= frames; n++) {
    if (o.stopAt !== undefined && !stopped && (n - 1) * dt >= o.stopAt) {
      driver.stop(o.fade ?? 0);
      stopped = true;
    }
    if (o.live) {
      const from = Math.round(((n - 1) * s.sampleRate) / fps);
      const to = Math.round((n * s.sampleRate) / fps);
      const ch = s.channels[0] ?? new Float32Array(0);
      block = [];
      for (let i = from; i < to && i < ch.length; i++) block.push(ch[i]!);
    }
    frame = n;
    driver.frame(dt);
    written.push(setting.parameters.map((p) => values.get(p.id)));
  }
  return (
    JSON.stringify({
      setting: { index: setting.index, id: setting.id, name: setting.name },
      warnings: [...file.warnings, ...driver.warnings],
      consumed: driver.consumed,
      ticks,
      frames: written,
    }) + "\n"
  );
}

/** The trace tool's arguments for these options. */
function args(wav: string, file: string, o: TraceOptions): string[] {
  const a = ["motion-sync-trace", wav, file];
  if (o.setting !== undefined) a.push("--setting", o.setting);
  if (o.fps !== undefined) a.push("--fps", String(o.fps));
  if (o.seconds !== undefined) a.push("--seconds", String(o.seconds));
  if (o.profile !== undefined) a.push("--profile", o.profile);
  if (o.gate !== undefined) a.push("--gate", String(o.gate));
  if (o.hangover !== undefined) a.push("--hangover", String(o.hangover));
  if (o.settleTime !== undefined) a.push("--settle-time", String(o.settleTime));
  if (o.fileSmoothing) a.push("--file-smoothing");
  if (o.live) a.push("--live");
  if (o.stopAt !== undefined) a.push("--stop-at", String(o.stopAt));
  if (o.fade !== undefined) a.push("--fade", String(o.fade));
  return a;
}

const cases: string[] = [];
const run = (name: string, wav: string, file: string, o: TraceOptions = {}) => {
  writeFileSync(join(reference, `${name}.json`), trace(wav, file, o));
  cases.push([name, ...args(wav, file, o)].join("\t"));
};

// Profiles: Mochi2D's calibration, and the native tool's arguments for the same.
const profile = (name: string, parts: [string, string][], label: string) => {
  const cal = new VoiceCalibration(label);
  for (const [element, path] of parts) {
    const s = decodeMotionSyncWav(readFileSync(path));
    cal.add(element as never, s.channels, s.sampleRate);
  }
  const text = JSON.stringify(cal.profile()) + "\n";
  writeFileSync(join(reference, `profile-${name}.json`), text);
  const path = join(inputs, `profile-${name}.json`);
  writeFileSync(path, text);
  cases.push(
    [`profile-${name}`, "voice-profile", ...parts.map(([e, p]) => `${e}=${p}`), "--name", label].join("\t"),
  );
  return path;
};
const maleProfile = profile(
  "male",
  VOWELS.map((v) => [v, recordings[`male-${v}`]!]),
  "male test voice",
);
const femaleProfile = profile(
  "female-room",
  [...VOWELS.map((v) => [v, recordings[`female-${v}`]!] as [string, string]), ["Silence", recordings.room!]],
  "female test voice",
);
profile("partial", [["O", recordings["male-O"]!], ["A", recordings["male-A"]!]], "two vowels");

// The sounds through ds-basic (the neutral voice), then settings and options.
for (const name of Object.keys(sounds)) run(`basic-${name}`, sounds[name]!, files["ds-basic"]!);
for (const name of ["male-16k", "female-48k", "glide-44k", "white-20", "stereo-a-o", "bursts"])
  run(`rich-${name}`, sounds[name]!, files["ds-rich"]!);
run("two-rich", sounds["female-48k"]!, files["ds-two"]!, { setting: "Mouth rich" });
run("two-by-id", sounds["male-16k"]!, files["ds-two"]!, { setting: "MS_Basic" });
for (const name of ["male-16k", "glide-44k", "bursts"]) run(`brisk-${name}`, sounds[name]!, files.brisk!);
for (const name of ["male-16k", "female-48k", "glide-female-48k-pcm32"]) {
  run(`odd-${name}`, sounds[name]!, files.odd!);
  run(`fast-${name}`, sounds[name]!, files.fast!);
  run(`slow-rich-${name}`, sounds[name]!, files["slow-rich"]!);
}
run("fps144", sounds["male-16k"]!, files["ds-basic"]!, { fps: 144 });
run("fps30", sounds["female-48k"]!, files["ds-rich"]!, { fps: 30 });
run("fps24-rich", sounds["glide-44k"]!, files["ds-rich"]!, { fps: 24.5 });
run("file-smoothing", sounds["male-16k"]!, files["ds-rich"]!, { fileSmoothing: true });
run("file-smoothing-female-48k", sounds["female-48k"]!, files["ds-rich"]!, { fileSmoothing: true });
run("gate-45", sounds["quiet-40"]!, files["ds-basic"]!, { gate: -45 });
run("gate-30", sounds["male-in-noise"]!, files["ds-basic"]!, { gate: -30 });
run("hangover", sounds.bursts!, files["ds-basic"]!, { hangover: 0.15 });
run("settle-2", sounds.short!, files["ds-rich"]!, { settleTime: 2, seconds: 3 });
run("fade", sounds["glide-44k"]!, files["ds-basic"]!, { stopAt: 1.5, fade: 0.5 });
run("stop", sounds["female-48k"]!, files["ds-rich"]!, { stopAt: 2.25 });
run("live-48k", sounds["female-48k"]!, files["ds-basic"]!, { live: true, stopAt: 6.5, seconds: 8 });
run("live-16k", sounds["male-16k"]!, files["ds-rich"]!, { live: true, stopAt: 6, seconds: 7 });
run("live-44k-fps144", sounds["glide-44k"]!, files["ds-basic"]!, { live: true, fps: 144, seconds: 6.5 });
run("live-noise", sounds["white-20"]!, files["ds-basic"]!, { live: true, seconds: 3, stopAt: 2.2 });
run("live-8k", sounds["male-8k"]!, files["ds-basic"]!, { live: true, seconds: 7 });
run("with-profile-male", sounds["male-44k-pcm16"]!, files["ds-basic"]!, { profile: maleProfile });
run("with-profile-female", sounds["female-48k"]!, files["ds-rich"]!, { profile: femaleProfile });
run("with-profile-female-noise", sounds["pink-30"]!, files["ds-basic"]!, { profile: femaleProfile });
run("with-profile-live", sounds["female-22k-pcm24"]!, files["ds-basic"]!, { profile: femaleProfile, live: true });

writeFileSync(join(out, "cases.txt"), cases.join("\n") + "\n");
console.log(`${cases.length} cases`);

// The neutral voice profile, which the library holds as data (tests/motion_sync/README.md).
writeFileSync(join(reference, "neutral.json"), JSON.stringify(neutralVoiceProfile()));
