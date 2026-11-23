/**
 * Classification of files in a model folder by file-name suffix only. This does
 * not read or interpret file contents.
 */
export type ModelFileKind =
  | "settings"
  | "moc"
  | "texture"
  | "motion"
  | "expression"
  | "physics"
  | "pose"
  | "userdata"
  | "displayinfo"
  | "sound"
  | "other";

const SUFFIXES: [string, ModelFileKind][] = [
  [".model3.json", "settings"],
  [".moc3", "moc"],
  [".motion3.json", "motion"],
  [".exp3.json", "expression"],
  [".physics3.json", "physics"],
  [".pose3.json", "pose"],
  [".userdata3.json", "userdata"],
  [".cdi3.json", "displayinfo"],
  [".png", "texture"],
  [".wav", "sound"],
  [".mp3", "sound"],
  [".ogg", "sound"],
];

export function classifyModelFile(path: string): ModelFileKind {
  const lower = path.toLowerCase();
  for (const [suffix, kind] of SUFFIXES) if (lower.endsWith(suffix)) return kind;
  return "other";
}

/** Groups paths by kind. Paths inside each group keep their input order. */
export function groupModelFiles(paths: readonly string[]): Map<ModelFileKind, string[]> {
  const out = new Map<ModelFileKind, string[]>();
  for (const p of paths) {
    const k = classifyModelFile(p);
    let list = out.get(k);
    if (!list) out.set(k, (list = []));
    list.push(p);
  }
  return out;
}
