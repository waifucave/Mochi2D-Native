/**
 * Mochi2D for the browser: show a model on a canvas, animate it, and let
 * people interact with it.
 *
 * ```ts
 * import { MochiView } from "mochi2d";
 *
 * const view = new MochiView(document.querySelector("canvas")!);
 * const model = await view.load("models/my-model/my-model.model3.json");
 * view.on("hit", (e) => void model.startMotion("TapBody"));
 * ```
 *
 * The headless runtime (no DOM, also for Node) is in "mochi2d/headless";
 * Node file helpers are in "mochi2d/node". See docs/api.md.
 */
export { MochiView, parseCssColor } from "./view.js";
export type {
  AddItemOptions,
  ItemLayout,
  LoadOptions,
  TapEvent,
  ViewEvents,
  ViewOptions,
  ViewTransform,
} from "./view.js";
export { MochiItem } from "./item.js";
export type {
  ItemDepth,
  ItemLayoutEntry,
  ItemMeshPlace,
  ItemPinInfo,
  ItemPlacement,
  ItemSettings,
  ItemSplit,
} from "./item.js";
export { MochiModel } from "./model.js";
export type { SpeakOptions, TextureImage, TextureInfo, TextureRegion } from "./model.js";
export { openModelInput } from "./sources.js";
export type { FileData, ModelInput, OpenedInput } from "./sources.js";
export type { AudioData } from "./speech.js";
export { LiveLipSyncControl } from "./live-lip-sync.js";
export type { LiveLipSyncOptions } from "./live-lip-sync.js";
export { LiveAudioError, liveAudioProblem } from "../platform/live-audio.js";
export type { LiveAudioErrorCode, LiveInputState, LiveTapMethod } from "../platform/live-audio.js";
export {
  LIVE_LIP_SYNC_DEFAULTS,
  LIVE_LIP_SYNC_NEUTRAL,
  LiveLipSync,
  dbfsToAmplitude,
} from "../anim/live-lip-sync.js";
export type { LiveLipSyncSettings } from "../anim/live-lip-sync.js";
export type { LiveLipSyncMix, LiveLipSyncSource } from "../anim/lip-sync.js";
// Motion sync (docs/api.md, "Motion sync"): live input, voice calibration, the file.
export { LiveMotionSyncControl } from "./live-motion-sync.js";
export type { LiveAudioChoice, LiveMotionSyncOptions, RecordedAudio } from "./live-motion-sync.js";
export {
  VoiceCalibration,
  neutralVoiceProfile,
  voiceProfileFromJson,
} from "../anim/motion-sync/analysis.js";
export type { VoiceProfile } from "../anim/motion-sync/analysis.js";
export { MotionSyncAudioError, decodeMotionSyncWav } from "../anim/motion-sync/wav.js";
export {
  MOTION_SYNC_ELEMENTS,
  parseMotionSync,
  writeMotionSync,
} from "../anim/motion-sync/file.js";
export type {
  MotionSyncElement,
  MotionSyncElementId,
  MotionSyncFile,
  MotionSyncParameter,
  MotionSyncSetting,
  MotionSyncSettingData,
  WriteMotionSyncOptions,
} from "../anim/motion-sync/file.js";
export type {
  MotionSyncClock,
  MotionSyncInput,
  MotionSyncSound,
  MotionSyncTick,
} from "../anim/motion-sync/driver.js";
export {
  CONSTRAINED_TEXTURE_BUDGET,
  DEFAULT_TEXTURE_BUDGET,
  deviceProfile,
  resolveTextureBudget,
} from "./texture-budget.js";
export type { DeviceProfile, ResolvedBudget, TextureBudgetSetting } from "./texture-budget.js";
export { GestureTracker, bindGestures } from "./gestures.js";
export type { DragMode, GestureHandlers, GestureOptions, PressInfo } from "./gestures.js";
export { ModelRuntime } from "../runtime/model-runtime.js";
// Model data of .moc3 files (docs/moc-data.md), for MochiModel.replace and editors.
export { mocModelFromData } from "../core/moc/from-data.js";
export { readMoc, writeMoc, MocWriteError, WRITABLE_VERSIONS } from "../core/moc/io.js";
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
export type { MocDiagnostic, MocReadResult, WriteMocOptions } from "../core/moc/io.js";
export { MocFormatError } from "../core/moc/read.js";
export type { MocModel } from "../core/moc/model.js";
export type { MocData, MocDataGroup, MocVersion } from "../core/moc/data.js";
export type { EvaluationOptions, MapSpace } from "../core/eval/instance.js";
export type { PatchGroup, ValuePatch } from "../core/eval/patch.js";
export { PATCHABLE_FIELDS } from "../core/eval/patch.js";
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
export { FileNotFoundError, MemoryFileSource } from "../core/io/file-source.js";
export {
  ZipFileSource,
  ZipFormatError,
  UnsupportedArchiveError,
  archiveKind,
} from "../runtime/zip-source.js";
export type { ArchiveKind, ZipNameEncoding } from "../runtime/zip-source.js";
export type { FileSource } from "../core/io/file-source.js";
export {
  BrowserFileSource,
  HttpFileSource,
  sourceFromDataTransfer,
  sourceFromFileList,
  sourceFromZip,
} from "../platform/browser-sources.js";
export { MOCHI2D_VERSION } from "./version.js";
