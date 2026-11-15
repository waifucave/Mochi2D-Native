// License comments for the built bundles: Mochi2D's own, then one per
// third-party package bundled in, read from the package's own package.json
// and LICENSE, and one per project whose code is ported into Mochi2D's own
// sources (PORTED). The full license texts are in THIRD_PARTY_NOTICES.md.
// Legal comments (/*! … */) are kept by esbuild and by Vite's minifier.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const copyrightLines = (text) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /copyright\s*(\(c\)|©)/i.test(l))
    .join("; ");

/**
 * Code ported into Mochi2D's sources from other projects (not npm packages):
 * the source files that hold it, and the license comment of every bundle
 * that includes them.
 */
export const PORTED = {
  musl: {
    files: ["src/core/math/libm32.ts"],
    comment:
      "/*! musl 1.2.6 (atan2f, atanf, sinf, cosf; ported) | MIT License | Copyright © 2005-2020 Rich Felker, et al.; Copyright (C) 1993 by Sun Microsystems, Inc. */",
  },
};

/** The PORTED name of a bundled input path ("src/core/math/libm32.ts" → "musl"), or null. */
export function portedOf(input) {
  const path = input.replace(/\\/g, "/");
  for (const [name, { files }] of Object.entries(PORTED))
    if (files.some((f) => path === f || path.endsWith(`/${f}`))) return name;
  return null;
}

/** The license file of an installed package (LICENSE, LICENSE.md, license.txt…). */
export function licenseFile(name) {
  const dir = resolve(root, "node_modules", name);
  const file = readdirSync(dir).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
  if (!file) throw new Error(`node_modules/${name} has no license file`);
  return resolve(dir, file);
}

/** The npm package a bundled input path comes from ("node_modules/@scope/name/…" → "@scope/name"). */
export function packageOf(input) {
  const i = input.lastIndexOf("node_modules/");
  if (i < 0) return null;
  const parts = input.slice(i + "node_modules/".length).split("/");
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

function packageComment(name) {
  if (Object.hasOwn(PORTED, name)) return PORTED[name].comment;
  const pkg = json(resolve(root, "node_modules", name, "package.json"));
  const copyright = copyrightLines(readFileSync(licenseFile(name), "utf8"));
  return `/*! ${pkg.name} ${pkg.version} | ${pkg.license} License${copyright ? ` | ${copyright}` : ""} */`;
}

/**
 * The license comment block for a bundle that includes the given npm
 * packages and PORTED code (for example ["fflate", "musl"]).
 * @param {readonly string[]} thirdParty
 * @returns {string}
 */
export function licenseBanner(thirdParty = []) {
  const pkg = json(resolve(root, "package.json"));
  const own = copyrightLines(readFileSync(resolve(root, "LICENSE"), "utf8"));
  return [
    `/*! Mochi2D ${pkg.version} | ${pkg.license} License | ${own} | third-party notices: THIRD_PARTY_NOTICES.md */`,
    ...thirdParty.map(packageComment),
  ].join("\n");
}
