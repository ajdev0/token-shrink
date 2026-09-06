/**
 * Single-parse analysis pass. Produces the pruned skeleton (Ring-1 text) and
 * the per-file symbol index from ONE tree-sitter parse, so the watcher never
 * parses a file twice for pruning and symbol extraction.
 *
 * The previous `prune()` implementation lived in `parser/pruner.ts`; the
 * parser plumbing (init/language cache) moved here and is re-exported from
 * `pruner.ts` for backwards compatibility.
 */

import Parser from 'web-tree-sitter';
import { createRequire } from 'node:module';
import path from 'node:path';

import { languageForFile, type LanguageSpec } from './registry.js';
import { getGrammar } from './wasm.js';
import { collectSymbols, type SymbolInfo } from './symbols.js';

/** A byte-range that will be replaced by `token`. */
export interface PruneRange {
  start: number;
  end: number;
  token: string;
}

/**
 * Cache of decoded web-tree-sitter Language objects, keyed by grammar file
 * name. Grammar bytes only change when the on-disk binary changes, so we can
 * decode once per process and reuse it across all parses for that language.
 */
const languageCache = new Map<string, Parser.Language>();

let initPromise: Promise<void> | null = null;
/** `Parser.init()` only needs to run once; make concurrent calls share it. */
export function ensureParserInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init({
      locateFile: (file: string) => {
        // Point the wasm runtime at the bundled tree-sitter.wasm so it works
        // from tsup's dist build as well as from node_modules. `__filename` is
        // shimmed by tsup for ESM and native in CJS, avoiding the empty
        // `import.meta.url` that crashes the CJS CLI bundle.
        const require = createRequire(__filename);
        try {
          const pkgRoot = path.dirname(require.resolve('web-tree-sitter/package.json'));
          return path.join(pkgRoot, file);
        } catch {
          return file;
        }
      },
    });
  }
  return initPromise;
}

/** Load (and cache) a decoded Language object for a language spec. */
export function loadLanguage(
  spec: LanguageSpec,
  force = false,
): Promise<Parser.Language> {
  if (!force) {
    const cached = languageCache.get(spec.wasm);
    if (cached) return Promise.resolve(cached);
  }
  // Force re-download/re-decode and refresh the cache.
  if (force) languageCache.delete(spec.wasm);
  return (async () => {
    await ensureParserInit();
    const grammar = await getGrammar(spec, force);
    const language = await Parser.Language.load(grammar);
    languageCache.set(spec.wasm, language);
    return language;
  })();
}

/**
 * Replace all ranges with their tokens. Ranges are pre-sorted descending by
 * start offset so each splice happens at the tail of the string first,
 * keeping earlier offsets stable.
 */
export function spliceRanges(source: string, ranges: PruneRange[]): {
  code: string;
  removed: number;
} {
  let removed = 0;
  const sorted = [...ranges].sort((a, b) => b.start - a.start);
  let out = source;
  for (const r of sorted) {
    if (r.start < 0 || r.end > out.length || r.end < r.start) continue;
    removed += r.end - r.start;
    out = out.slice(0, r.start) + r.token + out.slice(r.end);
  }
  return { code: out, removed };
}

export interface AnalyzeOptions {
  forceDownload?: boolean;
  /**
   * Keep the full source instead of producing a pruned skeleton (used by
   * `keepUnpruned` config rules). Symbols are still collected.
   */
  skipPrune?: boolean;
  /**
   * Byte ranges to exempt from pruning (used by `preserveAnnotations` config
   * rules). Blocks fully inside an exempted region are kept unpruned.
   */
  keepBlocksInside?: { start: number; end: number }[];
  /**
   * Annotation markers (e.g. `@keepContext`, `@api`). Any definition whose
   * preceding source window contains `@<marker>` is kept fully unpruned.
   */
  preserveAnnotations?: string[];
}

export interface AnalyzeResult {
  /** Pruned skeleton, or the full source when skipped/unsupported. */
  code: string;
  /** Friendly language name, or null when unsupported/unavailable. */
  language: string | null;
  /** Number of bytes removed by pruning. */
  removed: number;
  /** Named definitions found in this file. */
  symbols: SymbolInfo[];
}

/**
 * Prune a file's implementation bodies and index its symbols from a single
 * parse. When the grammar cannot be loaded (e.g. first offline run) the file
 * is kept usable and unpruned rather than being dropped from the index.
 */
export async function analyze(
  filePath: string,
  source: string,
  opts: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const spec = languageForFile(filePath);
  if (!spec || spec.rules.length === 0) {
    return { code: source, language: null, removed: 0, symbols: [] };
  }

  let language: Parser.Language;
  try {
    language = await loadLanguage(spec, opts.forceDownload);
  } catch {
    return { code: source, language: null, removed: 0, symbols: [] };
  }

  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  try {
    const symbols = collectSymbols(tree.rootNode, source);
    if (opts.skipPrune) {
      return { code: source, language: spec.name, removed: 0, symbols };
    }

    // Config keep-rules: an annotated definition (or an explicit keep range)
    // protects every prunable block inside it.
    const keepRanges: { start: number; end: number }[] = [
      ...(opts.keepBlocksInside ?? []),
      ...(opts.preserveAnnotations?.length
        ? annotatedKeepRanges(symbols, source, opts.preserveAnnotations)
        : []),
    ];
    const isProtected = (start: number, end: number) =>
      keepRanges.some((k) => k.start <= start && end <= k.end);

    const ranges: PruneRange[] = [];
    for (const rule of spec.rules) {
      const query = language.query(rule.query);
      const captures = query.captures(tree.rootNode);
      for (const cap of captures) {
        // Skip captures whose source text is empty (there's nothing to shrink).
        if (cap.node.startIndex === cap.node.endIndex) continue;
        // Allow rules to keep certain blocks (e.g. 'use client/server').
        if (rule.replacement.keepIf?.test(cap.node.text)) continue;
        // Config keep-rules (preserveAnnotations / keepBlocksInside).
        if (isProtected(cap.node.startIndex, cap.node.endIndex)) continue;
        ranges.push({
          start: cap.node.startIndex,
          end: cap.node.endIndex,
          token: rule.replacement.token,
        });
      }
      query.delete();
    }

    const { code, removed } = spliceRanges(source, ranges);
    return { code, language: spec.name, removed, symbols };
  } finally {
    tree.delete();
    parser.delete();
  }
}

/** Back-compat entry point (same contract as the historical `prune`). */
export async function prune(
  filePath: string,
  source: string,
  opts: { forceDownload?: boolean } = {},
): Promise<{ code: string; language: string | null; removed: number }> {
  const res = await analyze(filePath, source, opts);
  return { code: res.code, language: res.language, removed: res.removed };
}

/** How far back from a definition to look for an annotation line. */
const ANNOTATION_WINDOW = 240;

/**
 * Ranges of definitions whose preceding source window mentions any configured
 * annotation (e.g. a `@api` decorator or `// @keepContext` comment). Grammar
 * agnostic: it uses symbol byte ranges plus a plain-text backwards scan, so an
 * annotated function/class keeps ALL of its nested bodies unpruned.
 */
function annotatedKeepRanges(
  symbols: SymbolInfo[],
  source: string,
  annotations: string[],
): { start: number; end: number }[] {
  if (annotations.length === 0) return [];
  const markers = annotations.filter(Boolean).map(escapeRegExp);
  if (markers.length === 0) return [];
  const re = new RegExp(`@(${markers.join('|')})\\b`, 'i');
  return symbols
    .filter((s) => {
      // Look at the slice of source right before the definition. Cut everything
      // back to the last `}`/`;` so an annotation that belongs to a PREVIOUS
      // definition (still inside the 240-char window) can never leak onto the
      // next one.
      const windowStart = Math.max(0, s.start - ANNOTATION_WINDOW);
      const tail = source.slice(windowStart, s.start);
      const cut = Math.max(tail.lastIndexOf('}\n'), tail.lastIndexOf(';\n'));
      const relevant = cut === -1 ? tail : tail.slice(cut + 1);
      return re.test(relevant);
    })
    .map((s) => ({ start: s.start, end: s.end }));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

