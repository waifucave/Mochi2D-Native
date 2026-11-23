/**
 * What a {@link Stage} draws and the viewer's controls edit. The live model
 * implements it; so does the viewer's placeholder (mock) model.
 */
export interface ParameterInfo {
  id: string;
  /** Display name (falls back to the id). */
  label: string;
  min: number;
  max: number;
  default: number;
  /** Optional group name for display. */
  group?: string;
}

export interface PartInfo {
  id: string;
  label: string;
  defaultOpacity: number;
}

export interface StageModel {
  readonly name: string;
  readonly parameters: readonly ParameterInfo[];
  readonly parts: readonly PartInfo[];
  getParameter(id: string): number;
  setParameter(id: string, value: number): void;
  getPartOpacity(id: string): number;
  setPartOpacity(id: string, value: number): void;
  /** Advances animation by `dt` seconds of (scaled) model time; `time` is the total. */
  update(dt: number, time: number): void;
  /** Draws into the currently bound framebuffer, which is `width × height` pixels. */
  draw(width: number, height: number): void;
  /**
   * Whether the next frame would differ from the last one drawn at this size.
   * Models without it are redrawn every frame.
   */
  needsRedraw?(width: number, height: number): boolean;
  dispose(): void;
}
