/**
 * Running one scenario (static, sequence or animation) into its result
 * object, as `npm run conformance` writes it (4b–4e, 4i–4k).
 * Shared by the conformance CLI and the library's `scenarioResult`.
 */
import { ModelInstance } from "../core/eval/instance.js";
import { applyRequest, snapshotInstance, type ModelSnapshot } from "../core/model/snapshot.js";
import { knownFormat, parseScenario, type Scenario } from "./scenario.js";
import {
  ANIM_RESULT_FORMAT,
  SEQUENCE_RESULT_FORMAT,
  parseAnimScenario,
  parseSequence,
  runAnimFile,
  runSequence,
  type AnimResult,
  type SequenceResult,
} from "./formats.js";
import { errorInfo, type ScenarioModels } from "./models.js";

export const RESULT_FORMAT = "mochi2d-result/0";

/** The result of a static scenario (the result contract, 4d). */
export interface ScenarioResult extends ModelSnapshot {
  format: typeof RESULT_FORMAT;
  scenario: string;
  producer: string;
  error: null | { kind: string; message: string };
  /** Non-fatal notes, e.g. "unknown parameter X" (contract amendment). */
  warnings: string[];
}

/** The result of any scenario. */
export type AnyScenarioResult = ScenarioResult | SequenceResult | AnimResult;

export type ScenarioKind = "static" | "sequence" | "animation";

export function emptyResult(id: string, producer: string): ScenarioResult {
  return {
    format: RESULT_FORMAT,
    scenario: id,
    producer,
    error: null,
    canvas: {},
    parameters: [],
    parts: [],
    drawables: [],
    warnings: [],
  };
}

/** The kind of a scenario from its `format`, or null for an unknown format. */
export function scenarioKind(json: unknown): ScenarioKind | null {
  const format = knownFormat((json as { format?: unknown } | null)?.format);
  return format === "mochi2d-scenario/0"
    ? "static"
    : format === "mochi2d-sequence/0"
      ? "sequence"
      : format === "mochi2d-anim-scenario/0"
        ? "animation"
        : null;
}

/** The result format of each kind. */
export const RESULT_FORMAT_OF: Record<ScenarioKind, string> = {
  static: RESULT_FORMAT,
  sequence: SEQUENCE_RESULT_FORMAT,
  animation: ANIM_RESULT_FORMAT,
};

/** Evaluates one static scenario (4c, 4d). Never throws; errors are recorded in the result. */
export function runStatic(sc: Scenario, models: ScenarioModels, producer: string): ScenarioResult {
  const result = emptyResult(sc.id, producer);
  try {
    if (!sc.model) throw new Error(`Scenario has no "model" (built-in scenes are render-only)`);
    const { model } = models.load(sc.model);
    const inst = new ModelInstance(model); // the creation evaluation
    const warnings = [...model.loadWarnings, ...applyRequest(inst, sc)];
    inst.evaluate();
    const snapshot = snapshotInstance(inst);
    // Field order: envelope, canvas, parameters, parts, drawables, offscreens (v6), warnings.
    return {
      format: RESULT_FORMAT,
      scenario: sc.id,
      producer,
      error: null,
      canvas: snapshot.canvas,
      parameters: snapshot.parameters,
      parts: snapshot.parts,
      drawables: snapshot.drawables,
      ...(snapshot.offscreens ? { offscreens: snapshot.offscreens } : {}),
      warnings,
    };
  } catch (e) {
    result.error = errorInfo(e);
  }
  return result;
}

/** The result of a scenario that cannot run: its error, and empty data in the right format. */
export function invalidResult(
  id: string,
  format: string,
  producer: string,
  message: string,
): AnyScenarioResult {
  const error = { kind: "InvalidScenario", message };
  if (format === SEQUENCE_RESULT_FORMAT)
    return {
      format: SEQUENCE_RESULT_FORMAT,
      producer,
      error,
      warnings: [],
      sequence: id,
      canvas: {},
      steps: [],
    };
  if (format === ANIM_RESULT_FORMAT)
    return {
      format: ANIM_RESULT_FORMAT,
      producer,
      error,
      warnings: [],
      scenario: id,
      ids: { parameters: [], parts: [], free: [] },
      frames: [],
      starts: [],
      randomUsed: 0,
    };
  return { ...emptyResult(id, producer), error };
}

/**
 * Parses and runs one scenario of a known kind. Never throws: a malformed
 * scenario gives an `InvalidScenario` result, other failures their own kind.
 */
export function runScenarioJson(
  kind: ScenarioKind,
  json: unknown,
  id: string,
  models: ScenarioModels,
  producer: string,
): AnyScenarioResult {
  try {
    if (kind === "static") return runStatic(parseScenario(json), models, producer);
    if (kind === "sequence") return runSequence(parseSequence(json), models, producer);
    return runAnimFile(parseAnimScenario(json), models, producer);
  } catch (e) {
    const info = errorInfo(e);
    const r = invalidResult(id, RESULT_FORMAT_OF[kind], producer, info.message);
    if (info.kind !== "InvalidScenario") r.error = info;
    return r;
  }
}
