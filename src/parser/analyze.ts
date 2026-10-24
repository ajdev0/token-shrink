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
 * Drop ranges nested inside (or overlapping) an earlier kept range. Splicing
 * an inner range first would leave the outer range's offsets stale.
 */
export function outermostRanges(ranges: PruneRange[]): PruneRange[] {
  const byStart = [...ranges].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  );
  const kept: PruneRange[] = [];
  for (const r of byStart) {
    const last = kept[kept.length - 1];
    if (last && r.start < last.end) continue;
    kept.push(r);
  }
  return kept;
}

/**
 * Replace all ranges with their tokens. Nested ranges are collapsed into
 * their outermost range, then spliced descending by start offset so each
 * splice happens at the tail of the string first, keeping earlier offsets
 * stable.
 */
export function spliceRanges(source: string, ranges: PruneRange[]): {
  code: string;
  removed: number;
} {
  let removed = 0;
  const sorted = outermostRanges(ranges).reverse();
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
    const annotationRe = annotationRegExp(opts.preserveAnnotations ?? []);

    const ranges: PruneRange[] = [];
    for (const rule of spec.rules) {
      const { replacement } = rule;
      let query: Parser.Query;
      try {
        query = language.query(rule.query);
      } catch {
        continue; // node type missing from this grammar version — skip the rule
      }
      const captures = query.captures(tree.rootNode);
      for (const cap of captures) {
        const { startIndex: start, endIndex: end } = cap.node;
        // Skip captures whose source text is empty (there's nothing to shrink).
        if (start === end) continue;
        if (replacement.minLength && end - start < replacement.minLength) continue;
        if (replacement.skipNodeTypes?.includes(cap.node.type)) continue;
        // Allow rules to keep certain blocks (e.g. 'use client/server').
        if (replacement.keepIf?.test(cap.node.text)) continue;
        // Config keep-rules (preserveAnnotations / keepBlocksInside).
        if (isProtected(start, end)) continue;
        if (replacement.comment) {
          if (annotationRe?.test(cap.node.text)) continue;
          const range = commentRange(source, start, end);
          if (range) ranges.push(range);
          continue;
        }
        const braced =
          replacement.bracedToken !== undefined &&
          /(statement|clause)$|^arrow_function$/.test(cap.node.parent?.type ?? '');
        ranges.push({
          start,
          end,
          token: braced ? replacement.bracedToken! : replacement.token,
        });
      }
      query.delete();
    }

    const { code, removed } = spliceRanges(source, ranges);
    return {
      code: ranges.length > 0 ? normalizeWhitespace(code) : code,
      language: spec.name,
      removed,
      symbols,
    };
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
  const re = annotationRegExp(annotations);
  if (!re) return [];
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

/** `@marker` matcher for the configured annotations, or null when none. */
function annotationRegExp(annotations: string[]): RegExp | null {
  const markers = annotations.filter(Boolean).map(escapeRegExp);
  if (markers.length === 0) return null;
  return new RegExp(`@(${markers.join('|')})\\b`, 'i');
}

/** Doc tags worth keeping when a JSDoc-style comment is compressed. */
const KEPT_DOC_TAGS = /^@(param|returns?|throws|deprecated|template|typeParam)\b/;
/** Longest summary / tag line kept from a doc comment. */
const DOC_LINE_MAX = 100;

const clip = (text: string) =>
  text.length > DOC_LINE_MAX ? `${text.slice(0, DOC_LINE_MAX - 1).trimEnd()}…` : text;

/**
 * Compress a comment for a skeleton: `/** … *\/` docs keep their first
 * sentence plus key `@tags` on one line; `///` / `//!` docs and TS
 * `/// <reference>` directives are kept as-is; everything else is dropped.
 */
export function compressComment(text: string): string {
  if (/^\/\/[/!]/.test(text)) return text;
  if (!text.startsWith('/**')) return '';
  const lines = text
    .replace(/^\/\*\*+/, '')
    .replace(/\*+\/$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*?\s?/, '').trim());
  const tagStart = lines.findIndex((l) => l.startsWith('@'));
  const prose = (tagStart === -1 ? lines : lines.slice(0, tagStart))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const summary = prose.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? prose;
  const tags = (tagStart === -1 ? [] : lines.slice(tagStart)).filter((l) =>
    KEPT_DOC_TAGS.test(l),
  );
  const parts = [summary, ...tags].filter(Boolean).map(clip);
  return parts.length > 0 ? `/** ${parts.join(' ')} */` : '';
}

/**
 * Prune range for a comment. A dropped comment that is alone on its line
 * takes the whole line (and its newline) with it.
 */
function commentRange(source: string, start: number, end: number): PruneRange | null {
  const token = compressComment(source.slice(start, end));
  if (token === source.slice(start, end)) return null;
  if (token !== '') return { start, end, token };
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const nl = source.indexOf('\n', end);
  const lineEnd = nl === -1 ? source.length : nl + 1;
  const aloneOnLine =
    source.slice(lineStart, start).trim() === '' &&
    source.slice(end, nl === -1 ? source.length : nl).trim() === '';
  return aloneOnLine ? { start: lineStart, end: lineEnd, token: '' } : { start, end, token: '' };
}

/** Trim trailing spaces and collapse runs of blank lines left by pruning. */
function normalizeWhitespace(code: string): string {
  return code.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

