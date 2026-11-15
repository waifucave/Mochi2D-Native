/**
 * GpuTimer bookkeeping against a fake WebGL2 context with a fake timer-query
 * extension (headless SwiftShader has none, so the real path cannot run here).
 */
import { describe, expect, it } from "vitest";
import { GpuTimer } from "../src/render/gl/gpu-timer.js";

function fakeGl(opts: { extension?: boolean } = {}) {
  const ext = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
  let next = 0;
  let active: { id: number; started: boolean } | null = null;
  const results = new Map<number, number>();
  const available = new Set<number>();
  let disjoint = false;
  const log: string[] = [];
  const gl = {
    QUERY_RESULT_AVAILABLE: 1,
    QUERY_RESULT: 2,
    getExtension: (name: string) =>
      opts.extension !== false && name === "EXT_disjoint_timer_query_webgl2" ? ext : null,
    createQuery: () => ({ id: next++ }),
    deleteQuery: () => {},
    beginQuery: (target: number, q: { id: number }) => {
      if (active) throw new Error("nested query");
      expect(target).toBe(ext.TIME_ELAPSED_EXT);
      active = { id: q.id, started: true };
      log.push(`begin ${q.id}`);
    },
    endQuery: () => {
      if (!active) throw new Error("no active query");
      log.push(`end ${active.id}`);
      active = null;
    },
    getQueryParameter: (q: { id: number }, p: number) =>
      p === 1 ? available.has(q.id) : results.get(q.id),
    getParameter: (p: number) => (p === ext.GPU_DISJOINT_EXT ? disjoint : null),
  };
  return {
    gl: gl as unknown as WebGL2RenderingContext,
    log,
    complete(id: number, ns: number) {
      results.set(id, ns);
      available.add(id);
    },
    setDisjoint(v: boolean) {
      disjoint = v;
    },
  };
}

describe("GpuTimer", () => {
  it("is null without the extension", () => {
    expect(GpuTimer.create(fakeGl({ extension: false }).gl)).toBeNull();
  });

  it("times phases with one query per run, never nested, and sums them per frame", () => {
    const f = fakeGl();
    const t = GpuTimer.create(f.gl)!;
    t.beginFrame();
    t.phase("draws"); // query 0
    t.phase("draws"); // still the same run
    t.phase("masks"); // query 1
    t.phase("draws"); // query 2
    t.endFrame();
    expect(f.log).toEqual(["begin 0", "end 0", "begin 1", "end 1", "begin 2", "end 2"]);
    // Not available yet: nothing reported.
    t.beginFrame();
    t.endFrame();
    expect(t.latest).toBeNull();
    f.complete(0, 2e6);
    f.complete(1, 3e6);
    f.complete(2, 1e6);
    t.collect();
    expect(t.latest).toEqual({ totalMs: 6, phases: { draws: 3, masks: 3 } });
  });

  it("drops frames measured across a disjoint event and reuses their queries", () => {
    const f = fakeGl();
    const t = GpuTimer.create(f.gl)!;
    t.beginFrame();
    t.phase("draws"); // query 0
    t.endFrame();
    f.complete(0, 5e6);
    f.setDisjoint(true);
    t.collect();
    expect(t.latest).toBeNull();
    f.setDisjoint(false);
    t.beginFrame();
    t.phase("draws"); // reuses query 0
    t.endFrame();
    expect(f.log.slice(-2)).toEqual(["begin 0", "end 0"]);
  });
});
