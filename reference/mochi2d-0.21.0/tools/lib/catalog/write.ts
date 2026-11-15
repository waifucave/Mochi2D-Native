/**
 * Writes the catalog to disk (4o): the crafted model files under
 * `assets/models/crafts/` (gitignored; DeepSeek-chan's unchanged files are
 * linked, never copied into the repository) and the 827 scenario files with an
 * index.
 */
import { lstat, mkdir, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { repoRoot } from "../cli.js";
import { deepseekDir } from "../model-roots.js";
import { encodePng } from "../png.js";
import {
  DEEPSEEK_DIR,
  DEEPSEEK_MOC_NAME,
  DEEPSEEK_TEXTURE_DIR,
  DEEPSEEK_TEXTURES,
  deepseekMocBytes,
  mocCrafts,
} from "./moc-crafts.js";
import {
  ANIM_LINKS,
  animFolderFiles,
  questionFolderFiles,
  type FileContent,
} from "./anim-files.js";
import { fullCatalog, type CatalogEntry } from "./scenarios.js";

export interface CatalogPaths {
  /** Folder of the crafted model files (default `assets/models/crafts`). */
  crafts: string;
  /** Folder of the scenario files (default `out/catalog`). */
  scenarios: string;
}

export function defaultPaths(root = repoRoot()): CatalogPaths {
  return {
    crafts: join(root, "assets", "models", "crafts"),
    scenarios: join(root, "out", "catalog"),
  };
}

/** Creates or replaces a relative symbolic link `at` → `target`. */
async function link(target: string, at: string): Promise<void> {
  const rel = relative(dirname(at), target);
  const st = await lstat(at).catch(() => null);
  if (st?.isSymbolicLink() && (await readlink(at)) === rel) return;
  if (st) await rm(at, { recursive: true, force: true });
  await symlink(rel, at);
}

async function write(path: string, content: FileContent): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const st = await lstat(path).catch(() => null);
  if (st?.isSymbolicLink()) await unlink(path);
  await writeFile(path, content);
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length &&
  Buffer.compare(
    Buffer.from(a.buffer, a.byteOffset, a.length),
    Buffer.from(b.buffer, b.byteOffset, b.length),
  ) === 0;

/** `m.model3.json` of a moc craft (4o). */
export function craftSettings(): string {
  return JSON.stringify(
    { Version: 3, FileReferences: { Moc: "m.moc3", Textures: DEEPSEEK_TEXTURES } },
    null,
    2,
  );
}

/** A 16384 × 4 opaque white PNG (texbig, 4s). */
function bigWhitePng(): Uint8Array {
  const width = 16384;
  const height = 4;
  return encodePng({ width, height, data: new Uint8Array(width * height * 4).fill(255) });
}

export interface WriteReport {
  crafts: string[];
  files: number;
  scenarios: CatalogEntry[];
}

/** Writes every crafted input and every scenario file. */
export async function writeCatalog(
  paths: CatalogPaths,
  log: (line: string) => void = () => {},
): Promise<WriteReport> {
  const root = repoRoot();
  const deepseek = deepseekDir(root);
  const report: WriteReport = { crafts: [], files: 0, scenarios: [] };
  await mkdir(paths.crafts, { recursive: true });

  // Moc crafts (4p) and texbig (4s).
  const original = deepseekMocBytes();
  for (const c of mocCrafts()) {
    const dir = join(paths.crafts, c.name);
    await mkdir(dir, { recursive: true });
    const bytes = c.build();
    if (sameBytes(bytes, original))
      await link(join(deepseek, DEEPSEEK_MOC_NAME), join(dir, "m.moc3"));
    else await write(join(dir, "m.moc3"), bytes);
    await write(join(dir, "m.model3.json"), craftSettings());
    const textures = join(dir, DEEPSEEK_TEXTURE_DIR);
    if (c.name === "texbig") {
      const st = await lstat(textures).catch(() => null);
      if (st?.isSymbolicLink()) await unlink(textures);
      await mkdir(textures, { recursive: true });
      await write(join(textures, "texture_00.png"), bigWhitePng());
      for (const t of DEEPSEEK_TEXTURES.slice(1)) await link(join(deepseek, t), join(dir, t));
    } else await link(join(deepseek, DEEPSEEK_TEXTURE_DIR), textures);
    report.crafts.push(c.name);
    report.files += 2;
    log(`craft ${c.name} (${c.recipe})`);
  }

  // Animation crafts (4t, A7).
  const animDir = join(paths.crafts, "anim");
  await mkdir(animDir, { recursive: true });
  for (const [name, target] of Object.entries(ANIM_LINKS))
    await link(join(deepseek, target), join(animDir, name));
  for (const [name, content] of animFolderFiles()) {
    await write(join(animDir, name), content);
    report.files++;
  }
  report.crafts.push("anim");
  log(`craft anim (${animFolderFiles().size} files)`);
  const qDir = join(paths.crafts, "anim-q");
  await mkdir(qDir, { recursive: true });
  await link(join(deepseek, DEEPSEEK_MOC_NAME), join(qDir, DEEPSEEK_MOC_NAME));
  for (const [name, content] of questionFolderFiles()) {
    await write(join(qDir, name), content);
    report.files++;
  }
  report.crafts.push("anim-q");
  log("craft anim-q");

  // Scenario files.
  const catalog = fullCatalog();
  const index: {
    id: string;
    kind: string;
    group: string;
    file: string;
    official?: string;
    required?: string;
  }[] = [];
  for (const e of catalog) {
    const file = join(e.kind, e.group, `${e.id}.json`);
    await write(join(paths.scenarios, file), JSON.stringify(e.scenario, null, 2) + "\n");
    // Validation cases carry P8's verdicts, which the judge scores against (C27).
    index.push({ id: e.id, kind: e.kind, group: e.group, file, ...e.verdicts });
  }
  await write(
    join(paths.scenarios, "index.json"),
    JSON.stringify({ format: "mochi2d-catalog/0", scenarios: index }, null, 2) + "\n",
  );
  report.scenarios = catalog;
  log(`${catalog.length} scenario files → ${resolve(paths.scenarios)}`);
  return report;
}
