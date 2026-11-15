/**
 * Launches the pre-installed Chromium through the pre-installed Playwright.
 * Playwright is deliberately not a package dependency: it is resolved from the
 * environment (NODE_PATH / global modules), or from MOCHI2D_PLAYWRIGHT
 * (LIVELY2D_PLAYWRIGHT, its name before the rename, is read too).
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type * as PW from "./playwright-types.js";

const FALLBACK_CHROMIUM = "/opt/pw-browsers/chromium";

/** Flags for deterministic software WebGL (SwiftShader via ANGLE). */
export const CHROMIUM_ARGS = [
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
  "--disable-gpu-driver-bug-workarounds",
  "--force-color-profile=srgb",
];

/**
 * npm's default folder for global packages (`npm install -g`), next to this
 * Node: found even when NODE_PATH is not set, as when an MCP client starts a
 * server with only a few environment variables.
 */
function globalModulesDir(): string {
  const prefix = dirname(process.execPath);
  return process.platform === "win32"
    ? join(prefix, "node_modules")
    : join(dirname(prefix), "lib", "node_modules");
}

/**
 * Loads Playwright: `from` (a module name or folder) if given, else
 * MOCHI2D_PLAYWRIGHT, the `playwright` or `playwright-core` package, or a
 * global install.
 */
export function loadPlaywright(from?: string): PW.Playwright {
  const req = createRequire(import.meta.url);
  const global = globalModulesDir();
  const candidates = [
    from,
    process.env.MOCHI2D_PLAYWRIGHT ?? process.env.LIVELY2D_PLAYWRIGHT,
    "playwright",
    "playwright-core",
    ...["playwright", "playwright-core"]
      .map((name) => join(global, name))
      .filter((dir) => existsSync(dir)),
  ].filter(Boolean) as string[];
  const errors: string[] = [];
  for (const c of candidates) {
    try {
      return req(c) as PW.Playwright;
    } catch (e) {
      errors.push(`${c}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(
    `Playwright is not available. It is expected to be pre-installed (require('playwright')).\n` +
      `Set MOCHI2D_PLAYWRIGHT to its path to override.\n  ${errors.join("\n  ")}`,
  );
}

/**
 * Flags that keep Chromium off the network for work that only loads local
 * pages (the agent interface's renders): no background requests, component
 * updates, sync, pings or safe-browsing lookups.
 */
export const CHROMIUM_OFFLINE_ARGS = [
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-domain-reliability",
  "--disable-client-side-phishing-detection",
  "--no-pings",
  "--no-first-run",
  "--metrics-recording-only",
  "--safebrowsing-disable-auto-update",
];

/** Extra flags for audio tests: autoplay without a gesture and a fake microphone. */
export const CHROMIUM_MEDIA_ARGS = [
  "--autoplay-policy=no-user-gesture-required",
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
];

export interface LaunchOptions {
  /** A Chromium executable; default Playwright's own, then MOCHI2D_CHROMIUM. */
  executablePath?: string;
  /** Playwright itself (the module), or where to load it from (a module name or folder). */
  playwright?: PW.Playwright | string;
}

/**
 * Launches headless Chromium with software WebGL ({@link CHROMIUM_ARGS}) and
 * `extraArgs`: Playwright's own browser, or the executable given, or
 * MOCHI2D_CHROMIUM.
 */
export async function launchChromium(
  extraArgs: string[] = [],
  options: LaunchOptions = {},
): Promise<PW.Browser> {
  const pw =
    typeof options.playwright === "object"
      ? options.playwright
      : loadPlaywright(options.playwright);
  const args = [...CHROMIUM_ARGS, ...extraArgs];
  if (options.executablePath)
    return pw.chromium.launch({
      args: [...args, "--headless", "--no-sandbox"],
      executablePath: options.executablePath,
    });
  try {
    return await pw.chromium.launch({ args });
  } catch (first) {
    const exe =
      process.env.MOCHI2D_CHROMIUM ??
      process.env.LIVELY2D_CHROMIUM ??
      (existsSync(FALLBACK_CHROMIUM) ? FALLBACK_CHROMIUM : undefined);
    if (!exe) throw first;
    return pw.chromium.launch({
      args: [...args, "--headless", "--no-sandbox"],
      executablePath: exe,
    });
  }
}
