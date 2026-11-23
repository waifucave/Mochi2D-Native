/** A synthetic model for the model-data tests (test/moc-data.test.ts and others). */
import { Synth } from "./synth.js";

/** A small model using what each version can hold: warps, rotations, masks, glues, colors, blend shapes. */
export function sampleModel(version: number): Uint8Array {
  const s = new Synth(version);
  const root = s.part({ id: "Root" });
  s.part({ id: "Child", parent: root, keyforms: [{ drawOrder: 520 }] });
  const angle = s.param("ParamAngle", -30, 30, 0);
  const open = s.param("ParamOpen", 0, 1, 1);
  const bAngle = s.binding(angle, [-30, 0, 30]);
  const bOpen = s.binding(open, [0, 1]);
  const band = s.band([bAngle]);
  const band2 = s.band([bOpen, bAngle]);
  const grid = (d: number) =>
    [0, 0, 1, 0, 0, 1, 1, 1].map((v, i) => Math.fround(v + (i % 2 ? d : -d)));
  const warp = s.warp({
    id: "Warp",
    band,
    part: root,
    rows: 1,
    cols: 1,
    ...(version >= 2 ? { bilinear: true } : {}),
    keyforms: [
      {
        points: grid(-0.1),
        ...(version >= 4 ? { multiply: [1, 0.9, 0.8] as [number, number, number] } : {}),
      },
      { points: grid(0) },
      { points: grid(0.1), opacity: 0.5 },
    ],
  });
  const rot = s.rotation({
    id: "Rot",
    parent: warp,
    baseAngle: 5,
    keyforms: [
      {
        angle: 10,
        x: 0.5,
        y: 0.5,
        scale: 1,
        ...(version >= 4 ? { screen: [0.1, 0, 0] as [number, number, number] } : {}),
      },
    ],
  });
  const tri = [0.2, 0.2, 0.8, 0.2, 0.5, 0.8];
  const mask = s.mesh({
    id: "Mask",
    deformer: warp,
    keyforms: [{ positions: tri, drawOrder: 400 }],
  });
  const mesh = s.mesh({
    id: "Mesh",
    band: band2,
    deformer: rot,
    flags: 4 | 8,
    masks: [mask, -1],
    keyforms: Array.from({ length: 6 }, (_, k) => ({
      positions: tri.map((v) => Math.fround(v + 0.01 * k)),
      drawOrder: 500 + k,
      opacity: 1 - k / 10,
    })),
  });
  s.glue({ id: "Glue", a: mask, b: mesh, pairs: [[0, 0.5, 1, 0.5]], intensities: [1] });
  if (version >= 4) {
    const bs = s.param("ParamBlend", -1, 1, 0, { type: 1 });
    s.blendShape("mesh", mask, {
      param: bs,
      keys: [-1, 0, 1],
      base: 1,
      keyforms: [
        { positions: tri.map((v) => v + 0.05), drawOrder: 400 },
        { positions: tri, drawOrder: 400 },
        { positions: tri.map((v) => v - 0.05), drawOrder: 400 },
      ],
    });
    if (version >= 5)
      s.blendShape("rotation", 0, {
        param: bs,
        keys: [-1, 0, 1],
        base: 1,
        keyforms: [
          { angle: -20, x: 0.5, y: 0.5, scale: 1 },
          { angle: 0, x: 0.5, y: 0.5, scale: 1 },
          { angle: 20, x: 0.5, y: 0.5, scale: 1 },
        ],
      });
    if (version >= 6) {
      // An offscreen on Child (atop + multiply, masked, inverted), a mesh in it
      // drawn with atop + hard light, and a blend shape on the offscreen.
      const off = s.offscreen({
        part: 1,
        flags: 4 | 8,
        blendMode: 0x106,
        masks: [mask],
        keyforms: [{ opacity: 0.8, multiply: [1, 0.9, 0.8], screen: [0, 0.1, 0] }],
      });
      const inner = s.mesh({
        id: "Inner",
        part: 1,
        deformer: warp,
        blendMode: 0x10e,
        keyforms: [{ positions: tri, drawOrder: 510 }],
      });
      // Child (the offscreen's part) in the root group, its mesh in its own group.
      s.groups = [
        {
          min: 0,
          max: 1000,
          objects: [
            { kind: 0, index: mask },
            { kind: 0, index: mesh },
            { kind: 1, index: 1, nested: 1 },
          ],
        },
        { min: 0, max: 1000, objects: [{ kind: 0, index: inner }] },
      ];
      s.blendShape("offscreen", off, {
        param: bs,
        keys: [-1, 0, 1],
        base: 1,
        keyforms: [
          { opacity: -0.3, multiply: [0, 0, 0], screen: [0, 0, 0] },
          { opacity: 0, multiply: [0, 0, 0], screen: [0, 0, 0] },
          { opacity: 0.2, multiply: [0, 0, 0], screen: [0.1, 0.1, 0.1] },
        ],
      });
    }
  }
  return s.build();
}
