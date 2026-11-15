/**
 * GPU time of a frame's phases, measured with EXT_disjoint_timer_query_webgl2
 * where the browser offers it. A frame is a sequence of phases ("masks",
 * "draws", …); each phase run is one TIME_ELAPSED query, since those cannot
 * nest. Results arrive a few frames later; {@link GpuTimer.latest} holds the
 * most recent complete frame.
 */
interface TimerQueryExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

export interface GpuFrameTime {
  totalMs: number;
  /** Milliseconds per phase name. */
  phases: Record<string, number>;
}

export class GpuTimer {
  latest: GpuFrameTime | null = null;
  private readonly pool: WebGLQuery[] = [];
  private pending: { name: string; query: WebGLQuery }[][] = [];
  private frame: { name: string; query: WebGLQuery }[] | null = null;
  private active: string | null = null;

  private constructor(
    readonly gl: WebGL2RenderingContext,
    private readonly ext: TimerQueryExt,
  ) {}

  /** A timer, or null if the extension is unavailable. */
  static create(gl: WebGL2RenderingContext): GpuTimer | null {
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerQueryExt | null;
    return ext ? new GpuTimer(gl, ext) : null;
  }

  beginFrame(): void {
    this.collect();
    this.frame = [];
  }

  /** Ends the running phase and starts timing `name`. */
  phase(name: string): void {
    if (!this.frame || this.active === name) return;
    this.stop();
    const query = this.pool.pop() ?? this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.frame.push({ name, query });
    this.active = name;
  }

  endFrame(): void {
    this.stop();
    if (this.frame?.length) this.pending.push(this.frame);
    this.frame = null;
    // Do not let results pile up if they never arrive.
    while (this.pending.length > 6) this.release(this.pending.shift()!);
  }

  private stop(): void {
    if (this.active === null) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.active = null;
  }

  private release(frame: { query: WebGLQuery }[]): void {
    for (const f of frame) this.pool.push(f.query);
  }

  /** Reads the frames whose queries have all completed. */
  collect(): void {
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length) {
      const frame = this.pending[0]!;
      if (!frame.every((f) => gl.getQueryParameter(f.query, gl.QUERY_RESULT_AVAILABLE))) break;
      this.pending.shift();
      if (!disjoint) {
        const phases: Record<string, number> = {};
        let total = 0;
        for (const f of frame) {
          const ms = (gl.getQueryParameter(f.query, gl.QUERY_RESULT) as number) / 1e6;
          phases[f.name] = (phases[f.name] ?? 0) + ms;
          total += ms;
        }
        this.latest = { totalMs: total, phases };
      }
      this.release(frame);
    }
  }

  dispose(): void {
    this.stop();
    for (const f of this.pending) this.release(f);
    this.pending = [];
    for (const q of this.pool) this.gl.deleteQuery(q);
    this.pool.length = 0;
  }
}
