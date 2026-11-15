/**
 * Pose files `*.pose3.json` (3f) and the pose effect (3o):
 * mutually exclusive part groups. An entry's "value" is the value named by its
 * part ID (a parameter with that ID, else a free value, 3g.3).
 */
import { AnimationFormatError, arr, isObject, obj, optNum, parseJson, str } from "./json.js";
import type { AnimationValues } from "./values.js";

export interface PoseEntry {
  id: string;
  links: string[];
}

export interface PoseFile {
  label: string;
  /** Fade time F; missing or negative: 0.5 (3f). */
  fade: number;
  groups: PoseEntry[][];
}

export function parsePose(input: Uint8Array | string | unknown, label = "pose"): PoseFile {
  const json =
    typeof input === "string" || input instanceof Uint8Array ? parseJson(input, label) : input;
  if (!isObject(json)) throw new AnimationFormatError(`${label}: not a JSON object`);
  const f = optNum(json.FadeInTime);
  return {
    label,
    fade: f === undefined || f < 0 ? 0.5 : f,
    groups: arr(json.Groups).map((g) =>
      arr(g).map((e) => {
        const ee = obj(e);
        return {
          id: str(ee.Id),
          links: arr(ee.Link).filter((x): x is string => typeof x === "string"),
        };
      }),
    ),
  };
}

export class PoseRig {
  private initialized = false;

  constructor(
    readonly file: PoseFile,
    private readonly values: AnimationValues,
  ) {}

  /** 3o.1 on the first frame, then 3o.2. */
  frame(dt: number): void {
    const v = this.values;
    if (!this.initialized) {
      this.initialized = true;
      for (const group of this.file.groups)
        group.forEach((e, j) => {
          v.set(e.id, 1);
          v.setPartOpacity(e.id, j === 0 ? 1 : 0);
          v.set(e.id, j === 0 ? 1 : 0);
          for (const link of e.links) v.set(link, 1);
        });
    }
    const step = dt < 0 ? 0 : dt;
    const F = this.file.fade;
    for (const group of this.file.groups) {
      if (group.length === 0) continue;
      let visible = group.findIndex((e) => v.get(e.id) > 0.001);
      let o: number;
      if (visible < 0) {
        visible = 0;
        o = 1;
      } else {
        o = F === 0 ? 1 : Math.min(1, v.partOpacity(group[visible]!.id) + step / F);
      }
      group.forEach((e, j) => {
        if (j === visible) return;
        let a = 1 - o;
        if ((1 - a) * (1 - o) > 0.15) a = 1 - 0.15 / (1 - o);
        v.setPartOpacity(e.id, Math.min(v.partOpacity(e.id), a));
      });
      v.setPartOpacity(group[visible]!.id, o);
    }
    for (const group of this.file.groups)
      for (const e of group) {
        const op = v.partOpacity(e.id);
        for (const link of e.links) v.setPartOpacity(link, op);
      }
  }
}
