/**
 * Remembers the GL state a renderer sets and skips calls that would not change
 * it, counting issued and skipped calls. The cache only knows what went
 * through it: call {@link GlStateCache.reset} at the start of every frame and
 * after anything that changes state behind its back (creating or resizing
 * render targets, buffer uploads).
 *
 * Skipping a call that sets a value already in effect cannot change what is
 * drawn, so this is exact.
 */
const UNKNOWN = Symbol("unknown");
type Maybe<T> = T | typeof UNKNOWN;

export class GlStateCache {
  /** State-changing GL calls issued and skipped. */
  issued = 0;
  skipped = 0;
  /** Framebuffer binds issued (each can end a render pass on tiled GPUs). */
  framebufferBinds = 0;
  private program: Maybe<WebGLProgram | null> = UNKNOWN;
  private drawFb: Maybe<WebGLFramebuffer | null> = UNKNOWN;
  private readFb: Maybe<WebGLFramebuffer | null> = UNKNOWN;
  private vao: Maybe<WebGLVertexArrayObject | null> = UNKNOWN;
  private readonly vp = [NaN, NaN, NaN, NaN];
  private readonly sc = [NaN, NaN, NaN, NaN];
  private readonly cc = [NaN, NaN, NaN, NaN];
  private readonly caps = new Map<number, boolean>();
  private readonly blendFn = [NaN, NaN, NaN, NaN];
  private blendEq = NaN;
  private mask = -1;
  private unit = -1;
  private readonly units: Maybe<WebGLTexture | null>[] = [];

  constructor(readonly gl: WebGL2RenderingContext) {}

  /** Forgets everything (the next call of each kind is issued). */
  reset(): void {
    this.program = this.drawFb = this.readFb = this.vao = UNKNOWN;
    this.vp.fill(NaN);
    this.sc.fill(NaN);
    this.cc.fill(NaN);
    this.caps.clear();
    this.blendFn.fill(NaN);
    this.blendEq = NaN;
    this.mask = -1;
    this.unit = -1;
    this.units.length = 0;
  }

  private hit(): boolean {
    this.skipped++;
    return true;
  }

  useProgram(p: WebGLProgram | null): void {
    if (this.program === p && this.hit()) return;
    this.gl.useProgram(p);
    this.program = p;
    this.issued++;
  }

  /** Binds `fb` for drawing and reading. */
  bindFramebuffer(fb: WebGLFramebuffer | null): void {
    if (this.drawFb === fb && this.readFb === fb && this.hit()) return;
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, fb);
    this.drawFb = this.readFb = fb;
    this.issued++;
    this.framebufferBinds++;
  }

  bindDrawFramebuffer(fb: WebGLFramebuffer | null): void {
    if (this.drawFb === fb && this.hit()) return;
    this.gl.bindFramebuffer(this.gl.DRAW_FRAMEBUFFER, fb);
    this.drawFb = fb;
    this.issued++;
    this.framebufferBinds++;
  }

  bindReadFramebuffer(fb: WebGLFramebuffer | null): void {
    if (this.readFb === fb && this.hit()) return;
    this.gl.bindFramebuffer(this.gl.READ_FRAMEBUFFER, fb);
    this.readFb = fb;
    this.issued++;
    this.framebufferBinds++;
  }

  bindVertexArray(vao: WebGLVertexArrayObject | null): void {
    if (this.vao === vao && this.hit()) return;
    this.gl.bindVertexArray(vao);
    this.vao = vao;
    this.issued++;
  }

  private same4(a: number[], x: number, y: number, z: number, w: number): boolean {
    return a[0] === x && a[1] === y && a[2] === z && a[3] === w;
  }

  viewport(x: number, y: number, w: number, h: number): void {
    if (this.same4(this.vp, x, y, w, h) && this.hit()) return;
    this.gl.viewport(x, y, w, h);
    this.vp.splice(0, 4, x, y, w, h);
    this.issued++;
  }

  scissor(x: number, y: number, w: number, h: number): void {
    if (this.same4(this.sc, x, y, w, h) && this.hit()) return;
    this.gl.scissor(x, y, w, h);
    this.sc.splice(0, 4, x, y, w, h);
    this.issued++;
  }

  clearColor(r: number, g: number, b: number, a: number): void {
    // Object.is keeps −0 and +0 apart (and NaN equal to itself).
    const c = this.cc;
    if (Object.is(c[0], r) && Object.is(c[1], g) && Object.is(c[2], b) && Object.is(c[3], a))
      if (this.hit()) return;
    this.gl.clearColor(r, g, b, a);
    this.cc.splice(0, 4, r, g, b, a);
    this.issued++;
  }

  /** Enables or disables a capability (BLEND, CULL_FACE, SCISSOR_TEST, …). */
  set(cap: number, on: boolean): void {
    if (this.caps.get(cap) === on && this.hit()) return;
    if (on) this.gl.enable(cap);
    else this.gl.disable(cap);
    this.caps.set(cap, on);
    this.issued++;
  }

  blendEquation(mode: number): void {
    if (this.blendEq === mode && this.hit()) return;
    this.gl.blendEquation(mode);
    this.blendEq = mode;
    this.issued++;
  }

  blendFuncSeparate(srcRgb: number, dstRgb: number, srcA: number, dstA: number): void {
    if (this.same4(this.blendFn, srcRgb, dstRgb, srcA, dstA) && this.hit()) return;
    this.gl.blendFuncSeparate(srcRgb, dstRgb, srcA, dstA);
    this.blendFn.splice(0, 4, srcRgb, dstRgb, srcA, dstA);
    this.issued++;
  }

  colorMask(r: boolean, g: boolean, b: boolean, a: boolean): void {
    const m = (r ? 1 : 0) | (g ? 2 : 0) | (b ? 4 : 0) | (a ? 8 : 0);
    if (this.mask === m && this.hit()) return;
    this.gl.colorMask(r, g, b, a);
    this.mask = m;
    this.issued++;
  }

  /** Binds a 2D texture to a texture unit. */
  bindTexture(unit: number, tex: WebGLTexture | null): void {
    if (this.units[unit] === tex && this.hit()) return;
    if (this.unit !== unit) {
      this.gl.activeTexture(this.gl.TEXTURE0 + unit);
      this.unit = unit;
      this.issued++;
    }
    this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
    this.units[unit] = tex;
    this.issued++;
  }
}

/** One uniform of a program, with the last value sent; sends that change nothing are skipped. */
export class CachedUniform {
  private readonly last = new Float64Array(4);
  private known = false;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly location: WebGLUniformLocation | null,
    private readonly counter: { sent: number; skipped: number },
  ) {}

  private same(n: number, a: number, b: number, c: number, d: number): boolean {
    const l = this.last;
    if (!this.known) return false;
    // Object.is keeps −0 and +0 apart, which matter to a shader.
    return (
      Object.is(l[0], a) &&
      (n < 2 || Object.is(l[1], b)) &&
      (n < 3 || Object.is(l[2], c)) &&
      (n < 4 || Object.is(l[3], d))
    );
  }

  private store(a: number, b: number, c: number, d: number): void {
    const l = this.last;
    l[0] = a;
    l[1] = b;
    l[2] = c;
    l[3] = d;
    this.known = true;
    this.counter.sent++;
  }

  set1i(a: number): void {
    if (this.location === null) return;
    if (this.same(1, a, 0, 0, 0)) {
      this.counter.skipped++;
      return;
    }
    this.gl.uniform1i(this.location, a);
    this.store(a, 0, 0, 0);
  }

  set1f(a: number): void {
    if (this.location === null) return;
    if (this.same(1, a, 0, 0, 0)) {
      this.counter.skipped++;
      return;
    }
    this.gl.uniform1f(this.location, a);
    this.store(a, 0, 0, 0);
  }

  set2f(a: number, b: number): void {
    if (this.location === null) return;
    if (this.same(2, a, b, 0, 0)) {
      this.counter.skipped++;
      return;
    }
    this.gl.uniform2f(this.location, a, b);
    this.store(a, b, 0, 0);
  }

  set3f(a: number, b: number, c: number): void {
    if (this.location === null) return;
    if (this.same(3, a, b, c, 0)) {
      this.counter.skipped++;
      return;
    }
    this.gl.uniform3f(this.location, a, b, c);
    this.store(a, b, c, 0);
  }

  private lastMatrix: Float32Array | null = null;

  /** A 4 × 4 matrix, column-major (as WebGL takes it). */
  setMatrix4(m: Float32Array): void {
    if (this.location === null) return;
    const l = this.lastMatrix;
    if (l && l.every((v, i) => Object.is(v, m[i]))) {
      this.counter.skipped++;
      return;
    }
    this.gl.uniformMatrix4fv(this.location, false, m);
    this.lastMatrix = Float32Array.from(m);
    this.counter.sent++;
  }

  set4f(a: number, b: number, c: number, d: number): void {
    if (this.location === null) return;
    if (this.same(4, a, b, c, d)) {
      this.counter.skipped++;
      return;
    }
    this.gl.uniform4f(this.location, a, b, c, d);
    this.store(a, b, c, d);
  }
}
