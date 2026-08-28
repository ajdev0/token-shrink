/**
 * Polyglot AST pruning engine. Parses a source file with its language grammar
 * and replaces matched implementation blocks with a compact skeleton token,
 * preserving type signatures, interfaces, and module exports.
 *
 * Range splicing is done bottom-up (descending start offset) so that earlier
 * replacements never shift the byte offsets of later ones.
 */

import Parser from 'web-tree-sitter';
import { createRequire } from 'node:module';
import path from 'node:path';

import { languageForFile, type LanguageSpec } from './registry.js';
import { getGrammar } from './wasm.js';

/** A byte-range that will be replaced by `token`. */
interface PruneRange {
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
export function loadLanguage(spec: LanguageSpec, force = false): Promise<Parser.Language> {
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
 * Prune the implementation bodies out of `source` (a file at `filePath`).
 * If the language has no registered rules, returns the source unchanged.
 */
export async function prune(
  filePath: string,
  source: string,
  opts: { forceDownload?: boolean } = {},
): Promise<{ code: string; language: string | null; removed: number }> {
  const spec = languageForFile(filePath);
  if (!spec || spec.rules.length === 0) {
    return { code: source, language: null, removed: 0 };
  }

  const language = await loadLanguage(spec, opts.forceDownload);

  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);

  const ranges: PruneRange[] = [];
  for (const rule of spec.rules) {
    const query = language.query(rule.query);
    const captures = query.captures(tree.rootNode);
    for (const cap of captures) {
      // Skip captures whose source text is empty (there's nothing to shrink).
      if (cap.node.startIndex === cap.node.endIndex) continue;
      // Allow rules to keep certain blocks (e.g. 'use client/server').
      if (rule.replacement.keepIf?.test(cap.node.text)) continue;
      ranges.push({
        start: cap.node.startIndex,
        end: cap.node.endIndex,
        token: rule.replacement.token,
      });
    }
    query.delete();
  }
  tree.delete();
  parser.delete();

  const { code, removed } = spliceRanges(source, ranges);
  return { code, language: spec.name, removed };
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

