/**
 * Crafted variants of DeepSeek-chan's `.moc3` (4p),
 * rebuilt in memory at test time: read every section, change some arrays,
 * write a new file. No modified copy of the model is ever stored. The
 * builders live with the catalog generator (tools/lib/catalog/moc-crafts.ts).
 */
export {
  DEEPSEEK_MOC,
  bindingKeys,
  craftDeepseek,
  craftQ2,
  craftQ4c,
  craftV6,
  craftValidation,
  deepseekMocBytes,
  deepseekSections,
  groupTotals,
  setLastKey,
  VALIDATION_CASES,
  type Fields,
} from "../../tools/lib/catalog/moc-crafts.js";
