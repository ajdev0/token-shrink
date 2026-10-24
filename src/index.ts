/**
 * token-shrink — public library entry.
 *
 * Re-exports the pruning engine, language registry, incremental watcher/cache,
 * and context assembler for embedding. To run the servers, see `./cli.js`
 * (HTTP) and `./mcp.js` (MCP stdio), which are the packaged CLIs.
 */

export { prune, spliceRanges, outermostRanges, analyze, ensureParserInit, loadLanguage } from './parser/analyze.js';
export type { AnalyzeOptions, AnalyzeResult, PruneRange } from './parser/analyze.js';
export { collectSymbols, matchSymbols } from './parser/symbols.js';
export type { SymbolInfo, SymbolKind } from './parser/symbols.js';
export { languageForFile, registry, supportedLanguageIds, allExtensions } from './parser/registry.js';
export type { LanguageSpec, Replacement } from './parser/registry.js';
export { getGrammar, warmGrammars } from './parser/wasm.js';

export { detectProjectRoot, PROJECT_MANIFEST_FILES, VCS_MARKER_DIRS } from './detect.js';

export { SymbolSearch } from './search/index.js';
export type { SymbolDoc, SymbolHit } from './search/index.js';

export {
  loadConfig,
  matchesAny,
  matchesGlob,
  globToRegExp,
  EMPTY_CONFIG,
  CONFIG_FILE_NAME,
  configPathFor,
} from './config.js';
export type { TokenShrinkConfig } from './config.js';

export {
  createWatcher,
  hashOf,
  extractImports,
  resolveImport,
  DEFAULT_IGNORED,
} from './watcher/sync.js';
export type { CacheEntry, GraphCache, SyncOptions } from './watcher/sync.js';

export { assemble, assembleMany, extractSpecifiers, approximateTokens } from './server/assembler.js';
export type { AssembleOptions, AssembleResult, TokenStats } from './server/assembler.js';

export { startServer } from './cli.js';
export type { CliOptions } from './cli.js';
export {
  startMcpServer,
  createAutoRule,
  createCursorRule,
  AUTO_RULE_PATH,
  AUTO_RULE_SENTINEL,
  CURSOR_RULE_PATH,
  CLAUDE_RULE_PATH,
  CLAUDE_RULE_SENTINEL,
  CLINE_RULE_PATH,
  CLINE_RULE_SENTINEL,
  RULE_TARGET_PATH,
} from './mcp.js';
export type { McpServerOptions, RuleWriteResult, RuleTarget } from './mcp.js';

export { VERSION as version } from './tokens.js';
export {
  formatSavings,
  readStats,
  recordSavings,
  savingsOf,
  statsPathFor,
} from './tokens.js';
export type { Savings, StatsFile } from './tokens.js';
export { printStats } from './cli.js';
