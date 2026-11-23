import { execFileSync } from "node:child_process";

declare const __MOCHI2D_BUILD_SHA__: string | undefined;

/** "mochi2d@<git sha>" for the working tree (with "+dirty" if modified), else the build-time sha. */
export function producerId(repoRoot: string): string {
  let sha: string | undefined;
  try {
    sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (dirty) sha += "+dirty";
  } catch {
    sha = typeof __MOCHI2D_BUILD_SHA__ === "string" ? __MOCHI2D_BUILD_SHA__ : undefined;
  }
  return `mochi2d@${sha ?? "unknown"}`;
}
