/**
 * The license comment block for a bundle that includes the given npm
 * packages and PORTED code.
 */
export function licenseBanner(thirdParty?: readonly string[]): string;

/** Code ported into Mochi2D's sources from other projects, by project name. */
export const PORTED: {
  readonly musl: { readonly files: readonly string[]; readonly comment: string };
};

/** The PORTED name of a bundled input path, or null. */
export function portedOf(input: string): string | null;
