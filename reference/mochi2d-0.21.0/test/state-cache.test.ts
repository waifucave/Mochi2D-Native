import { describe, expect, it } from "vitest";
import { CachedUniform, GlStateCache } from "../src/render/gl/state-cache.js";

/** A stand-in for a WebGL2 context that records every call. */
function fakeGl() {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      calls.push(`${name}(${args.map((a) => (Object.is(a, -0) ? "-0" : String(a))).join(",")})`);
  const gl = {
    FRAMEBUFFER: 1,
    DRAW_FRAMEBUFFER: 2,
    READ_FRAMEBUFFER: 3,
    TEXTURE0: 100,
    TEXTURE_2D: 200,
    BLEND: 300,
  } as Record<string, unknown>;
  for (const n of [
    "useProgram",
    "bindFramebuffer",
    "bindVertexArray",
    "viewport",
    "scissor",
    "clearColor",
    "enable",
    "disable",
    "blendEquation",
    "blendFuncSeparate",
    "colorMask",
    "activeTexture",
    "bindTexture",
    "uniform1i",
    "uniform1f",
    "uniform3f",
    "uniform4f",
  ])
    gl[n] = record(n);
  return { gl: gl as unknown as WebGL2RenderingContext, calls };
}

describe("GL state cache", () => {
  it("skips calls that set values already in effect, and counts both", () => {
    const { gl, calls } = fakeGl();
    const st = new GlStateCache(gl);
    const p = {} as WebGLProgram;
    st.useProgram(p);
    st.useProgram(p);
    st.viewport(0, 0, 10, 10);
    st.viewport(0, 0, 10, 10);
    st.viewport(0, 0, 10, 11);
    st.set(300, true);
    st.set(300, true);
    st.set(300, false);
    expect(calls).toEqual([
      "useProgram([object Object])",
      "viewport(0,0,10,10)",
      "viewport(0,0,10,11)",
      "enable(300)",
      "disable(300)",
    ]);
    expect([st.issued, st.skipped]).toEqual([5, 3]);
  });

  it("switches texture units only when needed", () => {
    const { gl, calls } = fakeGl();
    const st = new GlStateCache(gl);
    const a = {} as WebGLTexture;
    const b = {} as WebGLTexture;
    st.bindTexture(0, a);
    st.bindTexture(0, a);
    st.bindTexture(1, a);
    st.bindTexture(1, b);
    st.bindTexture(0, a);
    expect(calls).toEqual([
      "activeTexture(100)",
      "bindTexture(200,[object Object])",
      "activeTexture(101)",
      "bindTexture(200,[object Object])",
      "bindTexture(200,[object Object])",
    ]);
  });

  it("tells +0 from −0 and forgets everything on reset", () => {
    const { gl, calls } = fakeGl();
    const st = new GlStateCache(gl);
    st.clearColor(0, 0, 0, 0);
    st.clearColor(-0, 0, 0, 0);
    st.clearColor(-0, 0, 0, 0);
    st.reset();
    st.clearColor(-0, 0, 0, 0);
    expect(calls).toEqual(["clearColor(0,0,0,0)", "clearColor(-0,0,0,0)", "clearColor(-0,0,0,0)"]);
  });

  it("tracks draw and read framebuffers separately", () => {
    const { gl, calls } = fakeGl();
    const st = new GlStateCache(gl);
    const f = {} as WebGLFramebuffer;
    st.bindFramebuffer(f);
    st.bindDrawFramebuffer(f);
    st.bindReadFramebuffer(null);
    st.bindFramebuffer(f);
    expect(calls).toEqual([
      "bindFramebuffer(1,[object Object])",
      "bindFramebuffer(3,null)",
      "bindFramebuffer(1,[object Object])",
    ]);
    expect(st.framebufferBinds).toBe(3);
  });
});

describe("cached uniforms", () => {
  it("sends a value only when it differs from the last one sent", () => {
    const { gl, calls } = fakeGl();
    const counter = { sent: 0, skipped: 0 };
    const loc = {} as WebGLUniformLocation;
    const u = new CachedUniform(gl, loc, counter);
    u.set3f(1, 0.5, 0);
    u.set3f(1, 0.5, 0);
    u.set3f(1, 0.5, -0);
    u.set1f(NaN);
    u.set1f(NaN);
    expect(calls).toEqual([
      "uniform3f([object Object],1,0.5,0)",
      "uniform3f([object Object],1,0.5,-0)",
      "uniform1f([object Object],NaN)",
    ]);
    expect(counter).toEqual({ sent: 3, skipped: 2 });
  });

  it("does nothing for a uniform the program does not use", () => {
    const { gl, calls } = fakeGl();
    const u = new CachedUniform(gl, null, { sent: 0, skipped: 0 });
    u.set4f(1, 2, 3, 4);
    expect(calls).toEqual([]);
  });
});
