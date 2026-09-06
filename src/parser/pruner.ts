/**
 * Back-compat facade. The parse/prune engine moved to `parser/analyze.ts`;
 * this module re-exports the historical surface (`prune`, `spliceRanges`, the
 * parser init and language loading helpers) so existing importers and the
 * public API stay unchanged.
 */

export {
  analyze,
  prune,
  spliceRanges,
  ensureParserInit,
  loadLanguage,
} from './analyze.js';
export type {
  AnalyzeOptions,
  AnalyzeResult,
  PruneRange,
} from './analyze.js';
