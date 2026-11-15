/**
 * The catalog's crafted files served from memory (for tests): the same
 * `crafts/...` paths as on disk under `assets/models/`, built on demand from
 * DeepSeek-chan's files, so scenarios run without writing any craft to disk.
 */
import { join, sep } from "node:path";
import { repoRoot } from "../cli.js";
import { DISK_IO, type ModelIo } from "../model-cache.js";
import type { ModelResolver } from "../conformance-runner.js";
import { searchResolver } from "../conformance-runner.js";
import { DEEPSEEK_MOC_NAME, mocCrafts } from "./moc-crafts.js";
import { deepseekDir } from "../model-roots.js";
import { ANIM_LINKS, animFolderFiles, questionFolderFiles } from "./anim-files.js";
import { craftSettings } from "./write.js";

const VROOT = join(repoRoot(), ".virtual-crafts");
const encoder = new TextEncoder();
const bytesOf = (c: string | Uint8Array) => (typeof c === "string" ? encoder.encode(c) : c);

export function virtualCatalog(capacity = 2): { resolver: ModelResolver; io: ModelIo } {
  const root = repoRoot();
  const deepseek = deepseekDir(root);
  const crafts = new Map(mocCrafts().map((c) => [c.name, c]));
  const built = new Map<string, Uint8Array>();
  const build = (name: string) => {
    let b = built.get(name);
    if (!b) {
      b = crafts.get(name)!.build();
      built.set(name, b);
      while (built.size > capacity) built.delete(built.keys().next().value!);
    }
    return b;
  };
  let anim: Map<string, string | Uint8Array> | null = null;
  let animQ: Map<string, string | Uint8Array> | null = null;
  const diskResolver = searchResolver(root);
  /** A file of `crafts/<folder>/<rest>`: bytes, or a path on disk. */
  const lookup = (rel: string): Uint8Array | string | undefined => {
    const m = /^crafts\/([^/]+)\/(.+)$/.exec(rel);
    if (!m) return undefined;
    const [, folder, file] = m as unknown as [string, string, string];
    if (folder === "anim") {
      anim ??= animFolderFiles();
      const f = anim.get(file);
      if (f !== undefined) return bytesOf(f);
      const head = file.split("/")[0]!;
      return ANIM_LINKS[head] !== undefined
        ? join(deepseek, ANIM_LINKS[head]!, file.slice(head.length))
        : undefined;
    }
    if (folder === "anim-q") {
      animQ ??= questionFolderFiles();
      const f = animQ.get(file);
      if (f !== undefined) return bytesOf(f);
      return file === DEEPSEEK_MOC_NAME ? join(deepseek, DEEPSEEK_MOC_NAME) : undefined;
    }
    if (!crafts.has(folder)) return undefined;
    if (file === "m.moc3") return build(folder);
    if (file === "m.model3.json") return encoder.encode(craftSettings());
    if (file.startsWith("大肥鱼.4096/")) return join(deepseek, file);
    return undefined;
  };
  const toRel = (path: string) =>
    path.startsWith(VROOT + sep)
      ? path
          .slice(VROOT.length + 1)
          .split(sep)
          .join("/")
      : null;
  const io: ModelIo = {
    read(path) {
      const rel = toRel(path);
      if (rel === null) return DISK_IO.read(path);
      const f = lookup(rel);
      return typeof f === "string" ? DISK_IO.read(f) : f;
    },
    version(path) {
      const rel = toRel(path);
      if (rel === null) return DISK_IO.version(path);
      const f = lookup(rel);
      return f === undefined
        ? undefined
        : typeof f === "string"
          ? DISK_IO.version(f)
          : `virtual:${rel}`;
    },
  };
  const resolver: ModelResolver = {
    resolve: (rel) =>
      rel.startsWith("crafts/")
        ? lookup(rel) !== undefined
          ? join(VROOT, rel)
          : undefined
        : diskResolver.resolve(rel),
    candidates: (rel) =>
      rel.startsWith("crafts/") ? [join(VROOT, rel)] : diskResolver.candidates(rel),
  };
  return { resolver, io };
}
