/**
 * Mochi2D without a browser: load a model from any file source, animate and
 * evaluate it. Pure TypeScript with no DOM or Node APIs, so it runs in Node,
 * Deno, workers and browsers. For files on disk, see "mochi2d/node".
 *
 * ```ts
 * import { ModelRuntime, MemoryFileSource } from "mochi2d/headless";
 *
 * const model = await ModelRuntime.load(source);   // the shallowest *.model3.json
 * model.setParameter("ParamAngleX", 20);
 * model.update(1 / 60);                            // animate and evaluate one frame
 * model.instance.drawableVertices;                 // per-drawable vertex positions
 * ```
 *
 * Also the model data of `.moc3` files (`readMoc`, `writeMoc`, `validateMoc`,
 * `mocModelFromData`, docs/moc-data.md), physics and motion-sync files
 * (`parsePhysics`, `writePhysics`, `parseMotionSync`, `writeMotionSync`) and
 * conformance results (`scenarioResult`).
 */
export { ModelRuntime } from "../runtime/model-runtime.js";
export type {
  DeformerInfo,
  EffectName,
  ExpressionFades,
  MapPointsOptions,
  MappedPoints,
  MotionEnd,
  MotionEndReason,
  MotionOptions,
  MotionPlayback,
  ParameterInfo,
  PartInfo,
  PhysicsDriver,
  PhysicsSettingInfo,
  RuntimeFrame,
  RuntimeOptions,
} from "../runtime/model-runtime.js";
export {
  findSettingsFiles,
  loadAnimationAssets,
  loadModelBundle,
  resolveSettingsPath,
} from "../runtime/bundle.js";
export type { AnimationAssets, ModelBundle } from "../runtime/bundle.js";
export {
  sourceFromZip,
  ZipFileSource,
  ZipFormatError,
  UnsupportedArchiveError,
  archiveKind,
} from "../runtime/zip-source.js";
export type { ArchiveKind, ZipNameEncoding } from "../runtime/zip-source.js";
export {
  FileNotFoundError,
  MemoryFileSource,
  OverlayFileSource,
  SubdirFileSource,
  readText,
} from "../core/io/file-source.js";
export type { FileSource } from "../core/io/file-source.js";
export { classifyModelFile } from "../core/io/model-files.js";
export type { ModelFileKind } from "../core/io/model-files.js";
export { loadMoc } from "../core/moc/model.js";
export type { MocModel } from "../core/moc/model.js";
export { MocFormatError } from "../core/moc/read.js";
// Model data: reading, writing and validating .moc3 files (docs/moc-data.md).
export { readMoc, writeMoc, MocWriteError, WRITABLE_VERSIONS } from "../core/moc/io.js";
export type { MocDiagnostic, MocReadResult, WriteMocOptions } from "../core/moc/io.js";
export { validateMoc } from "../core/moc/validate.js";
export { mocModelFromData } from "../core/moc/from-data.js";
export type {
  MocValidation,
  MocValidationLevel,
  ValidateMocOptions,
} from "../core/moc/validate.js";
export type {
  MocArtMeshes,
  MocArtMeshKeyforms,
  MocBands,
  MocBlendShapeConstraints,
  MocBlendShapeConstraintValues,
  MocBlendShapeKeyformBindings,
  MocBlendShapeParameterBindings,
  MocBlendShapeTargets,
  MocCanvasData,
  MocColors,
  MocData,
  MocDataGroup,
  MocDeformers,
  MocDrawOrderGroupObjects,
  MocDrawOrderGroups,
  MocGlueInfo,
  MocGlueKeyforms,
  MocGlues,
  MocOffscreenKeyforms,
  MocOffscreens,
  MocParameterBindings,
  MocParameters,
  MocPartKeyforms,
  MocParts,
  MocRotationDeformers,
  MocRotationKeyforms,
  MocVersion,
  MocWarpDeformers,
  MocWarpKeyforms,
} from "../core/moc/data.js";
export { ModelInstance } from "../core/eval/instance.js";
export type { EvaluationOptions, MapSpace } from "../core/eval/instance.js";
export type { PatchGroup, ValuePatch } from "../core/eval/patch.js";
export { PATCHABLE_FIELDS } from "../core/eval/patch.js";
export { parseModelSettings, SettingsFormatError } from "../core/settings/model-settings.js";
export type { ModelSettings, MotionEntry } from "../core/settings/model-settings.js";
export { snapshotInstance, formatResultJson } from "../core/model/snapshot.js";
export type { ModelSnapshot, DrawableSnapshot } from "../core/model/snapshot.js";
export { frameImage, imagePosition, outputPosition } from "../core/render/framing.js";
export type { Framing } from "../core/render/framing.js";
export { Animator } from "../anim/animator.js";
export type { AnimatorOptions, EffectSwitches, FrameResult } from "../anim/animator.js";
export { parseMotion } from "../anim/motion.js";
export type { Motion } from "../anim/motion.js";
export { parseExpression } from "../anim/expression.js";
export type { Expression } from "../anim/expression.js";
export { parsePhysics, writePhysics } from "../anim/physics.js";
export type {
  Normalization as PhysicsNormalization,
  PhysicsFile,
  PhysicsForces,
  PhysicsInput,
  PhysicsOutput,
  PhysicsParticle,
  PhysicsSetting,
  PhysicsState,
  WritePhysicsOptions,
} from "../anim/physics.js";
export { parsePose } from "../anim/pose.js";
export { decodeWav, WavFormatError } from "../anim/lip-sync.js";
export type { LiveLipSyncMix, LiveLipSyncSource, WavSound } from "../anim/lip-sync.js";
export {
  LIVE_LIP_SYNC_DEFAULTS,
  LIVE_LIP_SYNC_NEUTRAL,
  LIVE_SILENCE_AFTER,
  LiveLipSync,
  dbfsToAmplitude,
} from "../anim/live-lip-sync.js";
export type { LiveLipSyncSettings } from "../anim/live-lip-sync.js";
// Motion sync (docs/api.md, "Motion sync"): the file, the driver and Mochi2D's own analysis.
export {
  MOTION_SYNC_ANALYSIS_TYPE,
  MOTION_SYNC_ELEMENTS,
  findMotionSyncSetting,
  parseMotionSync,
  writeMotionSync,
} from "../anim/motion-sync/file.js";
export type {
  MotionSyncElement,
  MotionSyncElementId,
  MotionSyncFile,
  MotionSyncParameter,
  MotionSyncReadOptions,
  MotionSyncSetting,
  MotionSyncSettingData,
  WriteMotionSyncOptions,
} from "../anim/motion-sync/file.js";
export { MotionSyncDriver, SettingEngine } from "../anim/motion-sync/driver.js";
export type {
  MotionSyncClock,
  MotionSyncDriverOptions,
  MotionSyncInput,
  MotionSyncSound,
  MotionSyncTick,
} from "../anim/motion-sync/driver.js";
export { ParameterFilter, TickClock } from "../anim/motion-sync/parameter-filter.js";
export {
  ANALYSIS_RATE,
  ANALYSIS_WINDOW,
  VoiceCalibration,
  VowelAnalyzer,
  neutralVoiceProfile,
  soundStatistics,
  voiceProfileFromJson,
  windowFeatures,
} from "../anim/motion-sync/analysis.js";
export type {
  Analysis,
  AnalyzerOptions,
  SoundStatistics,
  VoiceProfile,
  WindowFeatures,
} from "../anim/motion-sync/analysis.js";
export { MotionSyncAudioError, decodeMotionSyncWav } from "../anim/motion-sync/wav.js";
export {
  VOWEL_FORMANTS,
  synthesizeVoice,
  synthesizeVowel,
} from "../anim/motion-sync/voice-synth.js";
export type { VoiceOptions } from "../anim/motion-sync/voice-synth.js";
export { vertexBounds, parseDisplayInfo, parseUserData } from "../anim/model-data.js";
export type { Bounds, DisplayInfo, UserData } from "../anim/model-data.js";
export { AnimationFormatError } from "../anim/json.js";
export {
  RandomExhaustedError,
  runAnimationScenario,
  runAnimationScenarioReport,
  sequenceRandom,
} from "../anim/scenario.js";
export type {
  AnimationReport,
  AnimationScenario,
  FrameRecord,
  HitRecord,
  MotionStartRecord,
  ScenarioCommand,
  ScenarioFiles,
  ScenarioHit,
} from "../anim/scenario.js";
// Conformance results as a library call (docs/api.md, "Conformance results").
export { scenarioResult, resultModelFromSource } from "../conformance/results.js";
export type { ResultModel, ScenarioResultOptions } from "../conformance/results.js";
export type { AnyScenarioResult, ScenarioResult as StaticResult } from "../conformance/run.js";
export type { AnimResult as AnimationResult, SequenceResult } from "../conformance/formats.js";
export { MOCHI2D_VERSION } from "./version.js";
