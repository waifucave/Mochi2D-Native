/**
 * Rotation world forms: the angle under a parent read back from two mapped
 * probe points, the base angle added last, radians without reduction, the
 * float32 library sine and cosine (libm32.ts), and the scale folded into C
 * and S. Every vector (V1 to V8), bit for bit, in every kernel mode.
 * Coordinates are file coordinates (y down); the instance reports y negated.
 */
import { describe, expect, it } from "vitest";
import { loadMoc } from "../src/core/moc/model.js";
import { atan2f, cosf, sinf } from "../src/core/math/libm32.js";
import { PROBE_WARP, probedAngle, rotationCS } from "../src/core/eval/rotation.js";
import { radians32 } from "../src/core/eval/f32.js";
import { evaluateAll } from "./support/evaluate.js";
import { Synth } from "./support/synth.js";

const fr = Math.fround;

interface Rot {
  angle: number;
  base?: number;
  x?: number;
  y?: number;
  scale?: number;
  mirrorX?: boolean;
  mirrorY?: boolean;
}

/**
 * A chain: a parent (a rotation, a warp given by its 1×1 grid, or none) and
 * a child rotation holding a mesh with the given vertices. Returns the
 * vertices in file coordinates.
 */
function chain(
  parent: { rotation: Rot } | { warp: number[]; bilinear: boolean } | null,
  child: Rot,
  vertices: number[],
): number[] {
  const s = new Synth(5);
  s.part({ id: "Root" });
  const rot = (r: Rot) => ({
    angle: r.angle,
    x: r.x ?? 0,
    y: r.y ?? 0,
    scale: r.scale ?? 1,
    mirrorX: r.mirrorX ?? false,
    mirrorY: r.mirrorY ?? false,
  });
  let p = -1;
  if (parent && "rotation" in parent)
    p = s.rotation({
      id: "P",
      baseAngle: parent.rotation.base ?? 0,
      keyforms: [rot(parent.rotation)],
    });
  else if (parent)
    p = s.warp({
      id: "P",
      rows: 1,
      cols: 1,
      bilinear: parent.bilinear,
      keyforms: [{ points: parent.warp }],
    });
  const c = s.rotation({
    id: "R",
    ...(p >= 0 ? { parent: p } : {}),
    baseAngle: child.base ?? 0,
    keyforms: [rot(child)],
  });
  const n = vertices.length / 2;
  s.mesh({
    id: "M",
    deformer: c,
    triangles: n >= 3 ? [0, 1, 2] : [],
    keyforms: [{ positions: vertices }],
  });
  const out = evaluateAll(loadMoc(s.build())).vertices[0]!;
  return out.map((v, i) => (i % 2 ? -v : v));
}

describe("the float32 library functions (libm32)", () => {
  it("give the runtime's sine and cosine, also where they are not correctly rounded", () => {
    // V1–V3: θ → r → cos, sin.
    const cases: [number, number, number, number][] = [
      [344.7542419433594, 6.017096519470215, 0.9648067951202393, -0.26295989751815796],
      [78.1448974609375, 1.363885760307312, 0.20543734729290009, 0.9786702990531921],
      [30, 0.5235987901687622, 0.8660253882408142, 0.5],
    ];
    for (const [theta, r, c, s] of cases) {
      expect(radians32(theta)).toBe(r);
      expect([cosf(r), sinf(r)]).toEqual([c, s]);
    }
    // The correctly rounded values differ for V1's cosine and V2's sine.
    expect(fr(Math.cos(cases[0]![1]))).toBe(0.9648067355155945);
    expect(fr(Math.sin(cases[1]![1]))).toBe(0.9786702394485474);
  });

  it("follow the C functions on special values and the large-argument reduction", () => {
    expect([atan2f(0, -1), atan2f(-0, -1), atan2f(1, 0), atan2f(-1, 0)]).toEqual([
      fr(Math.PI),
      -fr(Math.PI),
      fr(Math.PI / 2),
      -fr(Math.PI / 2),
    ]);
    expect(Object.is(atan2f(-0, 1), -0)).toBe(true);
    expect(atan2f(Infinity, -Infinity)).toBe(fr(fr(3 * fr(Math.PI)) / 4));
    expect(Number.isNaN(sinf(Infinity)) && Number.isNaN(cosf(NaN))).toBe(true);
    // Arguments of every size stay within one float32 ulp of the true values
    // (the large ones through the 2/π table); |sin|² + |cos|² ≈ 1.
    for (const x of [1e-5, 0.7, 2.1, 4.4, 7.3, 100.5, 12345.678, 3.0e8, 1.0e9, 6.0e15, 3.4e38]) {
      const v = fr(x);
      const [s, c] = [sinf(v), cosf(v)];
      expect(Math.abs(s * s + c * c - 1)).toBeLessThan(1e-6);
      if (v < 1e8) {
        expect(Math.abs(s - Math.sin(v))).toBeLessThan(2 ** -23);
        expect(Math.abs(c - Math.cos(v))).toBeLessThan(2 ** -23);
      }
      expect(sinf(-v)).toBe(-s);
      expect(cosf(-v)).toBe(c);
    }
  });
});

describe("rotation chains, bit for bit", () => {
  it("V1–V3: root rotations", () => {
    // Vertex (1, 0) reports cos and sin themselves; V1 maps (100, 0) as given.
    expect(chain(null, { angle: 344.7542419433594 }, [1, 0, 100, 0, 0, 1]).slice(0, 4)).toEqual([
      0.9648067951202393, -0.26295989751815796, 96.48068237304688, -26.295989990234375,
    ]);
    expect(chain(null, { angle: 78.1448974609375 }, [1, 0, 0, 1, 1, 1]).slice(0, 2)).toEqual([
      0.20543734729290009, 0.9786702990531921,
    ]);
    expect(chain(null, { angle: 30 }, [1, 0, 0, 1, 1, 1]).slice(0, 2)).toEqual([
      0.8660253882408142, 0.5,
    ]);
  });

  const V4_PARENT: Rot = { angle: 30, base: 15, x: 100, y: -50, scale: 2 };
  const V4_CHILD: Rot = { angle: 10, x: 20, y: 30, scale: 0.5 };

  it("V4: a rotation under a rotation", () => {
    expect(chain({ rotation: V4_PARENT }, V4_CHILD, [1, 0, 100, 0, 0, 1]).slice(0, 4)).toEqual([
      86.43144226074219, 21.529830932617188, 143.21551513671875, 102.62588500976562,
    ]);
    // The angle from the probe outputs: P = 45, θ = 55.
    const theta = probedAngle(10, 0, 85.85786437988281, 20.710678100585938, 100, 6.56854248046875);
    expect(theta).toBe(55);
    expect(rotationCS(theta, 1)).toEqual([0.5735764503479004, 0.8191520571708679]);
    expect(atan2f(fr(-14.142135620117188), fr(14.142135620117188))).toBe(-0.7853981852531433);
  });

  it("V5: the parent mirrored in y turns the probe around", () => {
    const parent = { ...V4_PARENT, mirrorY: true };
    expect(chain({ rotation: parent }, V4_CHILD, [100, 0, 0, 1, 1, 1]).slice(0, 2)).toEqual([
      113.35303497314453, -146.05734252929688,
    ]);
    const theta = probedAngle(
      10,
      0,
      170.71067810058594,
      -64.14213562011719,
      156.56854248046875,
      -50,
    );
    expect(theta).toBe(-125); // the old rule gave 235
    expect(rotationCS(theta, 1)).toEqual([-0.5735764503479004, -0.8191519975662231]);
  });

  it("V6: a tiny parent scale moves the angle by thousandths of a degree", () => {
    const parent: Rot = { angle: 37, x: 0.25, y: -0.5, scale: fr(1e-4) };
    const child: Rot = { angle: 0, x: 8100, y: -4960, scale: 8 };
    expect(chain({ rotation: parent }, child, [100, 0, 0, 1, 1, 1]).slice(0, 2)).toEqual([
      1.2592878341674805, -0.3605104386806488,
    ]);
    const theta = probedAngle(
      0,
      0,
      1.1953949928283691,
      -0.40865299105644226,
      1.1959967613220215,
      -0.4094516336917877,
    );
    expect(theta).toBe(36.99762725830078);
    expect(rotationCS(theta, fr(8 * fr(1e-4)))).toEqual([
      fr(0.0007999999797903001 * 0.798660397529602),
      fr(0.0007999999797903001 * 0.601781964302063),
    ]);
    expect(rotationCS(theta, 1)).toEqual([0.798660397529602, 0.601781964302063]);
  });

  it("V7: a rotation under a bilinear warp", () => {
    const warp = { warp: [0, 0, 200, 20, -30, 180, 190, 210], bilinear: true };
    const child: Rot = { angle: 20, base: 5, x: 0.25, y: 0.30000001192092896, scale: 1.5 };
    expect(chain(warp, child, [100, 0, 0, 1, 1, 1]).slice(0, 2)).toEqual([
      168.58473205566406, 141.00662231445312,
    ]);
    const theta = probedAngle(20, 5, 42.5, 59.75, 44.999996185302734, 41.500003814697266);
    expect(theta).toBe(32.80017852783203);
    expect(rotationCS(theta, 1)).toEqual([0.8405649065971375, 0.5417107939720154]);
  });

  it("V8: the probe offset is a float32 subtraction (triangle-mode warp, from its outputs)", () => {
    const y = 0.2292606383562088;
    expect(fr(y - PROBE_WARP)).toBe(0.12926062941551208);
    expect(fr(y - 0.1)).toBe(0.12926064431667328); // the double offset differs
    const [ox, oy] = [118.36258697509766, 38.834800720214844];
    const theta = probedAngle(
      -241.5941162109375,
      0,
      ox,
      oy,
      125.95867156982422,
      23.607532501220703,
    );
    expect(theta).toBe(-215.08192443847656);
    // With the double offset's probe output the angle would differ.
    expect(
      probedAngle(-241.5941162109375, 0, ox, oy, 125.95867156982422, 23.607534408569336),
    ).not.toBe(theta);
    // Vertex (1000, 0): X = f32(O_x + f32(C·1000)), Y = f32(O_y + f32(S·1000)).
    const [c, s] = rotationCS(theta, 2.8078689575195312);
    expect([fr(ox + fr(c * 1000)), fr(oy + fr(s * 1000))]).toEqual([
      -2179.403564453125, 1652.6497802734375,
    ]);
  });
});
