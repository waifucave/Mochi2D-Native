/**
 * The published check values of the catalog generators (4q and
 * 4u), as executable checks. Each returns a list of mismatches (empty when
 * everything matches).
 */
import type { MocModel } from "../../../src/core/moc/model.js";
import { DSRAND_SEED, NumberStream, dsrandInputs, randomList } from "./rng.js";

const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/** 4q, corrected: the first draws of the dsrand stream and the dsrand scenarios. */
export function checkDsrand(model: MocModel): string[] {
  const problems: string[] = [];
  const g = new NumberStream(DSRAND_SEED);
  [0.47532436, 0.5163225122, 0.9656537434].forEach((want, i) => {
    const got = g.next();
    if (!close(got, want, 5e-11))
      problems.push(`draw ${i + 1} from state ${DSRAND_SEED}: ${got} (want ${want})`);
  });
  const all = dsrandInputs(model, 300);
  const rows: [number, number, [string, number][], [string, number][] | number][] = [
    [
      0,
      16,
      [
        ["RRibbonX2", 0.149563015],
        ["Param40", 0.408121705],
        ["Movement2", -0.0674732849],
      ],
      [],
    ],
    [
      1,
      94,
      [
        ["ribbonY1", -0.982213378],
        ["LateHairY5", 0.502273679],
      ],
      [],
    ],
    [
      2,
      509,
      [
        ["RRibbonY4", 0.626279712],
        ["ShortPonytailXBS", 0.352459639],
      ],
      [
        ["Part128", 0.6307],
        ["ArtMesh669_Skinning", -0.0281],
      ],
    ],
    [
      3,
      21,
      [
        ["LittleFlower11", 0.885122776],
        ["CheeksWiggleY", 1.00109994],
      ],
      6,
    ],
  ];
  for (const [s, count, first, parts] of rows) {
    const d = all[s]!;
    const id = `dsrand-${String(s).padStart(3, "0")}`;
    if (d.order.length !== count)
      problems.push(`${id}: ${d.order.length} parameters (want ${count})`);
    first.forEach(([pid, v], i) => {
      if (d.order[i] !== pid || d.parameters[pid] !== v)
        problems.push(
          `${id}: entry ${i} is ${d.order[i]} ${d.parameters[d.order[i]!]} (want ${pid} ${v})`,
        );
    });
    const got = Object.entries(d.partOpacities);
    if (typeof parts === "number") {
      if (got.length !== parts)
        problems.push(`${id}: ${got.length} part opacities (want ${parts})`);
      if (s === 3 && (got[0]?.[0] !== "Part68" || got[0]?.[1] !== 0.7956))
        problems.push(`${id}: first part opacity ${got[0]} (want Part68 0.7956)`);
    } else if (
      JSON.stringify(got.slice(0, parts.length)) !== JSON.stringify(parts) ||
      (parts.length === 0 && got.length)
    )
      problems.push(
        `${id}: part opacities ${JSON.stringify(got)} (want ${JSON.stringify(parts)}…)`,
      );
  }
  const params = all.reduce((n, d) => n + d.order.length, 0);
  const withParts = all.filter((d) => Object.keys(d.partOpacities).length).length;
  const partEntries = all.reduce((n, d) => n + Object.keys(d.partOpacities).length, 0);
  if (params !== 49880) problems.push(`total parameter entries ${params} (want 49880)`);
  if (withParts !== 105) problems.push(`scenarios with part opacities ${withParts} (want 105)`);
  if (partEntries !== 362) problems.push(`part-opacity entries ${partEntries} (want 362)`);
  return problems;
}

/** 4u: R(7) and R(101). */
export function checkRandomLists(): string[] {
  const problems: string[] = [];
  const rows: [number, number[]][] = [
    [7, [0.2387808398, 0.9134932647, 0.6124916663]],
    [101, [0.275210768, 0.43964719, 0.9750692663]],
  ];
  for (const [seed, want] of rows) {
    const got = randomList(seed);
    if (got.length !== 64) problems.push(`R(${seed}) has ${got.length} numbers`);
    want.forEach((w, i) => {
      if (!close(got[i]!, w, 5e-11)) problems.push(`R(${seed})[${i}] = ${got[i]} (want ${w})`);
    });
  }
  return problems;
}
