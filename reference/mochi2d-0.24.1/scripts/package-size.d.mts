// Types of scripts/package-size.mjs (for the tests).
export interface SizeEntry {
  name: string;
  file: string;
  platform: string;
  target?: string;
  external?: string[];
  only?: string[];
}
export interface Measured {
  name: string;
  bytes: number;
  gzip: number;
  inputs: string[];
  code: string;
}
export const SIZE_ENTRIES: SizeEntry[];
export const SIZE_IMPORTS: SizeEntry[];
export function measureEntry(entry: SizeEntry): Promise<Measured>;
export function measureAll(): Promise<Measured[]>;
