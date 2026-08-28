/**
 * token-shrink — public library entry.
 *
 * Re-exports the pruning engine, language registry, incremental watcher/cache,
 * and context assembler for embedding. To run the servers, see `./cli.js`
 * (HTTP) and `./mcp.js` (MCP stdio), which are the packaged CLIs.
 */

export { prune, spliceRanges } from './parser/pruner.js';
export { languageForFile, registry, supportedLanguageIds, allExtensions } from './parser/registry.js';
export type { LanguageSpec, Replacement } from './parser/registry.js';
export { getGrammar, warmGrammars } from './parser/wasm.js';

export {
  createWatcher,
  hashOf,
  extractImports,
  resolveImport,
  DEFAULT_IGNORED,
} from './watcher/sync.js';
export type { CacheEntry, GraphCache, SyncOptions } from './watcher/sync.js';

export { assemble, extractSpecifiers, approximateTokens } from './server/assembler.js';
export type { AssembleOptions, AssembleResult } from './server/assembler.js';

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

export const version = '2.0.0';
