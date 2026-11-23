declare const __MOCHI2D_VERSION__: string | undefined;

/** The library version (set by the library build; "dev" when running from source). */
export const MOCHI2D_VERSION: string =
  typeof __MOCHI2D_VERSION__ === "string" ? __MOCHI2D_VERSION__ : "dev";
