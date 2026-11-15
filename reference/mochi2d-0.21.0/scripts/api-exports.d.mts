// Types of scripts/api-exports.mjs (for the tests).
export const ENTRIES: Record<string, string>;
export const MARKS: string[];
export const GROUP_ORDER: string[];
export const BEGIN: string;
export const END: string;
export interface ExportInfo {
  kind: string;
  group: string;
  deprecated: boolean;
}
export interface StabilityRow {
  kind: string;
  entries: string[];
  mark: string;
}
export function entryExports(
  root: string,
  ext?: string,
): Record<string, Record<string, ExportInfo>>;
export function exportRows(
  exports: Record<string, Record<string, ExportInfo>>,
): (ExportInfo & { name: string; entries: string[] })[];
export function parseStabilityDoc(text: string): Map<string, StabilityRow>;
export function renderLists(
  exports: Record<string, Record<string, ExportInfo>>,
  previous: Map<string, StabilityRow>,
): string;
export function withLists(doc: string, lists: string): string;
