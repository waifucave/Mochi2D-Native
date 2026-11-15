/**
 * Counts WebGL calls by name, for benchmarks: every method of the context is
 * temporarily replaced on the instance by a counting wrapper. The wrappers add
 * overhead, so time frames in a separate pass from the one that counts.
 */

/** GL calls that change state the next draw depends on (bindings, capabilities, blending, …). */
export const STATE_CALLS = new Set([
  "activeTexture",
  "bindBuffer",
  "bindFramebuffer",
  "bindRenderbuffer",
  "bindTexture",
  "bindVertexArray",
  "blendColor",
  "blendEquation",
  "blendEquationSeparate",
  "blendFunc",
  "blendFuncSeparate",
  "clearColor",
  "colorMask",
  "cullFace",
  "disable",
  "enable",
  "frontFace",
  "scissor",
  "useProgram",
  "viewport",
]);

export interface GlCallCounter {
  readonly counts: Map<string, number>;
  /** Removes the wrappers. */
  stop(): void;
}

export function countGlCalls(gl: WebGL2RenderingContext): GlCallCounter {
  const counts = new Map<string, number>();
  const target = gl as unknown as Record<string, unknown>;
  const names: string[] = [];
  for (let proto = Object.getPrototypeOf(gl); proto && proto !== Object.prototype;) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (name === "constructor" || !d || typeof d.value !== "function") continue;
      if (Object.prototype.hasOwnProperty.call(target, name) || names.includes(name)) continue;
      names.push(name);
    }
    proto = Object.getPrototypeOf(proto);
  }
  for (const name of names) {
    const fn = target[name] as (...a: unknown[]) => unknown;
    target[name] = function (this: unknown, ...args: unknown[]) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      return fn.apply(gl, args);
    };
  }
  return {
    counts,
    stop() {
      for (const name of names) delete target[name];
    },
  };
}

/** Totals of a call profile: draws, state changes, uniform sends, uploads, clears and the rest. */
export function summarizeGlCalls(counts: ReadonlyMap<string, number>): Record<string, number> {
  const out = { draws: 0, state: 0, uniforms: 0, uploads: 0, clears: 0, blits: 0, other: 0 };
  for (const [name, n] of counts) {
    if (name === "drawElements" || name === "drawArrays") out.draws += n;
    else if (STATE_CALLS.has(name)) out.state += n;
    else if (name.startsWith("uniform")) out.uniforms += n;
    else if (name === "bufferSubData" || name === "bufferData") out.uploads += n;
    else if (name === "clear") out.clears += n;
    else if (name === "blitFramebuffer") out.blits += n;
    else out.other += n;
  }
  return out;
}
