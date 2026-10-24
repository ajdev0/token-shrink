/**
 * Async context assembly on top of `assembleMany`: computes the per-file
 * overrides that need a fresh parse, then hands them to the sync assembler.
 *
 *   - Focused Ring 0: when Ring 0 alone exceeds `maxTokens`, files with
 *     focus lines (cursor, changed hunks) keep only the definitions around
 *     those lines; every other body is pruned.
 *   - Used-exports Ring 1 (`ringOneMode: 'used'`): each dependency skeleton
 *     keeps only the names Ring 0 imports from it, plus what their
 *     signatures reference.
 */

import fs from 'node:fs';
import path from 'node:path';

import { analyze } from '../parser/analyze.js';
import type { RingOneMode } from '../config.js';
import type { GraphCache } from '../watcher/sync.js';
import { approximateTokens } from '../tokens.js';
import {
  assembleMany,
  MARKDOWN_OVERHEAD_TOKENS,
  resolveLocal,
  type AssembleOptions,
  type AssembleResult,
} from './assembler.js';

export interface ContextOptions extends AssembleOptions {
  /** 1-based focus lines per Ring-0 file (absolute or cwd-relative paths). */
  focusLines?: Record<string, number[]>;
  /** Ring-1 skeleton mode; defaults to `full`. */
  ringOneMode?: RingOneMode;
  /** Annotation markers that keep definitions unpruned (from config). */
  preserveAnnotations?: string[];
  /** Files that must never be pruned or filtered (from config `keepUnpruned`). */
  isKeepUnpruned?: (absPath: string) => boolean;
}

/** `'*'` = the importer may use anything (namespace, side-effect, require). */
export type ImportedNames = Set<string> | '*';

const JS_FAMILY = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * Names each specifier is imported under, from a JS/TS source. Specifiers the
 * importer could use wholesale (`* as`, `export *`, side-effect imports,
 * `require`, dynamic `import()`) map to `'*'`.
 */
export function importedNames(source: string): Map<string, ImportedNames> {
  const out = new Map<string, ImportedNames>();
  const add = (spec: string, names: ImportedNames) => {
    const prev = out.get(spec);
    if (prev === '*' || names === '*') {
      out.set(spec, '*');
      return;
    }
    out.set(spec, new Set([...(prev ?? []), ...names]));
  };
  const braceNames = (inner: string) =>
    inner
      .split(',')
      .map((p) => p.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
      .filter(Boolean);

  let m: RegExpExecArray | null;
  const fromRe = /\bimport\s+(?:type\s+)?([^'"`;]*?)\s+from\s+['"]([^'"]+)['"]/g;
  while ((m = fromRe.exec(source)) !== null) {
    const clause = m[1].trim();
    if (/\*\s*as\s/.test(clause)) {
      add(m[2], '*');
      continue;
    }
    const names = new Set<string>();
    const brace = clause.match(/\{([^}]*)\}/);
    if (brace) braceNames(brace[1]).forEach((n) => names.add(n));
    const head = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim();
    if (head) names.add('default');
    add(m[2], names);
  }
  const reExportRe = /\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s+['"]([^'"]+)['"]/g;
  while ((m = reExportRe.exec(source)) !== null) add(m[2], new Set(braceNames(m[1])));
  const wholesale = [
    /\bexport\s+\*(?:\s+as\s+\w+)?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of wholesale) {
    while ((m = re.exec(source)) !== null) add(m[1], '*');
  }
  return out;
}

function readSource(abs: string): string {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

/** Build the compressed context, applying focused Ring 0 and used-exports Ring 1. */
export async function assembleContext(
  activeFiles: string[],
  cache: GraphCache,
  opts: ContextOptions = {},
): Promise<AssembleResult> {
  const absList = activeFiles.map((p) => path.resolve(p));
  const activeSet = new Set(absList);
  const sources = new Map(absList.map((abs) => [abs, readSource(abs)]));
  const keepFull = (abs: string) => opts.isKeepUnpruned?.(abs) ?? false;
  const { preserveAnnotations } = opts;

  const ring1Overrides = new Map<string, string>();
  if (opts.ringOneMode === 'used') {
    const usage = new Map<string, ImportedNames>();
    const merge = (dep: string, names: ImportedNames) => {
      const prev = usage.get(dep);
      usage.set(
        dep,
        prev === '*' || names === '*' ? '*' : new Set([...(prev ?? []), ...names]),
      );
    };
    for (const abs of absList) {
      const known = new Set<string>();
      if (JS_FAMILY.test(abs)) {
        for (const [spec, names] of importedNames(sources.get(abs) ?? '')) {
          const dep = resolveLocal(abs, spec);
          if (!dep || activeSet.has(dep)) continue;
          known.add(dep);
          merge(dep, names);
        }
      }
      // Edges the regex could not attribute to names: assume full usage.
      for (const dep of cache.get(abs)?.imports ?? []) {
        if (!known.has(dep) && !activeSet.has(dep)) merge(dep, '*');
      }
    }
    for (const [dep, names] of usage) {
      const entry = cache.get(dep);
      if (names === '*' || names.size === 0 || !entry || keepFull(dep)) continue;
      const res = await analyze(dep, readSource(dep), {
        keepOnly: [...names],
        preserveAnnotations,
      });
      if (res.code.length < entry.skeleton.length) ring1Overrides.set(dep, res.code);
    }
  }

  const ring0Overrides = new Map<string, string>();
  const focus = new Map(
    Object.entries(opts.focusLines ?? {}).map(([p, lines]) => [path.resolve(p), lines]),
  );
  if (opts.maxTokens !== undefined && focus.size > 0) {
    const ring0Tokens = [...sources.values()].reduce((acc, t) => acc + approximateTokens(t), 0);
    if (ring0Tokens > opts.maxTokens - MARKDOWN_OVERHEAD_TOKENS) {
      for (const abs of absList) {
        const lines = focus.get(abs);
        if (!lines?.length || keepFull(abs)) continue;
        const res = await analyze(abs, sources.get(abs) ?? '', {
          focusLines: lines,
          preserveAnnotations,
        });
        if (res.language) ring0Overrides.set(abs, res.code);
      }
    }
  }

  return assembleMany(activeFiles, cache, { ...opts, ring0Overrides, ring1Overrides });
}
