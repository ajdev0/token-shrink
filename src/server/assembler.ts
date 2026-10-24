/**
 * Context Assembler (Phase 4). Produces a Markdown context payload from the
 * graph cache:
 *
 *   Ring 0 — the active file's raw, full text.
 *   Ring 1 — pruned skeletons of the files it directly imports.
 *
 * The payload keeps full type signatures (imports, interfaces, exports) while
 * dropping implementation bodies, delivering the 80–90% reduction target.
 */

import fs from 'node:fs';
import path from 'node:path';

import { tsSourcesFor, type GraphCache } from '../watcher/sync.js';
import { approximateTokens, savingsOf } from '../tokens.js';

export { approximateTokens } from '../tokens.js';

export interface AssembleOptions {
  /** Number of PRD-style stats to append (disabled by default). */
  includeStats?: boolean;
  /** Maximum number of ring-1 files to include. */
  maxSkeletons?: number;
  /**
   * Hard token budget for the whole payload (Ring 0 + Ring 1). When set, Ring 1
   * candidates are ranked by relevance and greedily packed until the budget is
   * exhausted; Ring 0 is always kept in full.
   */
  maxTokens?: number;
  /** Whether the active file itself should also be pruned (Ring 0 raw by default). */
  pruneActiveFile?: boolean;
}

/** Token accounting for an assembled payload. */
export interface TokenStats {
  activeTokens: number;
  dependencyTokens: number;
  totalTokens: number;
  /**
   * Tokens the same files would cost un-pruned (Ring 0 as emitted + the full
   * source of every included Ring-1 file): the savings baseline.
   */
  originalTokens: number;
  /** `originalTokens - totalTokens`. */
  savedTokens: number;
  /** Percentage of `originalTokens` saved, one decimal. */
  reductionPct: number;
  /** When `maxTokens` was supplied, the budget that was enforced. */
  budget?: number;
  /** Number of Ring 1 candidates dropped by the token budget. */
  trimmed: number;
}

export interface AssembleResult {
  /** Human-readable Markdown payload for an agent. */
  markdown: string;
  /** First active file (back-compat; prefer `activeFilePaths`). */
  activeFilePath: string;
  /** Every resolved Ring-0 path, in request order. */
  activeFilePaths: string[];
  /** Ring-0 full text of the active file(s). */
  activeSource: string;
  /** Ring-1 entries actually included. */
  included: { filePath: string; language: string | null }[];
  /** Paths referenced by imports that could not be resolved to a file. */
  unresolved: string[];
  /** Approximate token accounting for this payload. */
  tokenStats: TokenStats;
}

/** Markdown headers/fences overhead subtracted from a `maxTokens` budget. */
const MARKDOWN_OVERHEAD_TOKENS = 40;

/**
 * Build the compressed context for one or more open files.
 * `activeFiles` may be absolute or project-relative. Every listed file is
 * emitted in full as Ring 0; the combined set of their local imports is
 * emitted as pruned Ring-1 skeletons, minus any file already in Ring 0.
 *
 * When `opts.maxTokens` is set, Ring 1 candidates are ranked by a cheap
 * relevance proxy (fan-in → path depth → declaration order) and greedily
 * packed until the budget is exhausted; Ring 0 is always kept in full.
 */
export function assembleMany(
  activeFiles: string[],
  cache: GraphCache,
  opts: AssembleOptions = {},
): AssembleResult {
  const {
    includeStats = false,
    maxSkeletons = 50,
    maxTokens,
    pruneActiveFile = false,
  } = opts;

  const absList = activeFiles.map((p) => path.resolve(p));
  const sources = absList.map((abs) => {
    try {
      return fs.readFileSync(abs, 'utf8');
    } catch {
      return '';
    }
  });
  const activeSet = new Set(absList);

  // Ring-0 text that will actually be emitted (pruned only on request).
  const ring0Texts = absList.map((abs, i) => {
    const entry = cache.get(abs);
    return pruneActiveFile && entry ? entry.skeleton : sources[i];
  });

  const included: AssembleResult['included'] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const addUnresolved = (p: string) => {
    if (!unresolved.includes(p)) unresolved.push(p);
  };
  const addIncluded = (p: string, allowUncached: boolean) => {
    if (seen.has(p)) return;
    const entry = cache.get(p);
    if (!entry && !allowUncached) {
      addUnresolved(p);
      return;
    }
    seen.add(p);
    included.push({ filePath: p, language: entry?.language ?? null });
  };

  for (let i = 0; i < absList.length; i++) {
    const abs = absList[i];
    const entry = cache.get(abs);
    if (entry) {
      // Indexed active file: walk its resolved imports.
      for (const imp of entry.imports) {
        if (activeSet.has(imp)) continue; // already full Ring 0
        addIncluded(imp, false);
      }
    } else if (sources[i]) {
      // Unindexed active file: resolve imports from disk with the fallback
      // so the payload is still useful.
      for (const spec of extractSpecifiers(sources[i])) {
        const resolved = resolveLocal(abs, spec);
        if (!resolved) {
          addUnresolved(spec);
          continue;
        }
        if (activeSet.has(resolved)) continue;
        addIncluded(resolved, true);
      }
    }
  }

  // Keep declaration order by default (stable output); rank by relevance only
  // when a token budget forces us to drop lower-value dependencies.
  const ordered =
    maxTokens === undefined ? included : rankByRelevance(included, cache);

  // Greedy packing: respect maxSkeletons always; additionally stay within the
  // token budget when one is given.
  const budget =
    maxTokens === undefined
      ? undefined
      : Math.max(0, maxTokens - MARKDOWN_OVERHEAD_TOKENS);
  const selected: AssembleResult['included'] = [];
  let trimmed = 0;
  let dependencyTokens = 0;
  let dependencyOriginalTokens = 0;
  for (const cand of ordered) {
    if (selected.length >= maxSkeletons) break;
    const entry = cache.get(cand.filePath);
    // Unindexed candidates get a small nominal cost until they are indexed.
    const cost = entry ? approximateTokens(entry.skeleton) : 8;
    if (budget !== undefined && dependencyTokens + cost > budget) {
      trimmed++;
      continue;
    }
    selected.push(cand);
    dependencyTokens += cost;
    dependencyOriginalTokens += entry?.originalTokens ?? cost;
  }
  const activeTokens = ring0Texts.reduce(
    (acc, t) => acc + approximateTokens(t),
    0,
  );
  // Ring 0 baseline is the full source, even when it was pruned on request.
  const activeOriginalTokens = sources.reduce(
    (acc, t) => acc + approximateTokens(t),
    0,
  );
  const totalTokens = activeTokens + dependencyTokens;
  const originalTokens = Math.max(
    totalTokens,
    activeOriginalTokens + dependencyOriginalTokens,
  );
  const savings = savingsOf({ originalTokens, totalTokens });

  const lines: string[] = [];
  lines.push('# Compressed Code Context', '');

  if (absList.length === 1) {
    lines.push(`Active file: \`${rel(absList[0])}\``, '');
  } else {
    lines.push('Active files:', '');
    for (const p of absList) lines.push(`- \`${rel(p)}\``);
    lines.push('');
  }

  // Ring 0.
  lines.push(
    absList.length === 1
      ? '## Ring 0 — Active file (full text)'
      : '## Ring 0 — Active files (full text)',
    '',
  );
  for (let i = 0; i < absList.length; i++) {
    if (absList.length > 1) lines.push(`### \`${rel(absList[i])}\``, '');
    const body = ring0Texts[i].trim() || '(empty or unreadable file)';
    lines.push(`\`\`\`${ext(absList[i])}`, body, '```', '');
  }

  // Ring 1.
  lines.push(
    `## Ring 1 — Pruned dependencies (${selected.length})`,
    '',
    'Implementation bodies removed; type signatures, interfaces and exports retained.',
    '',
  );
  if (selected.length === 0) {
    lines.push('_No local dependency skeletons available._', '');
  }
  for (const inc of selected) {
    const entry = cache.get(inc.filePath);
    const label = rel(inc.filePath);
    lines.push(`### \`${label}\``, '');
    if (entry) {
      lines.push(`\`\`\`${ext(inc.filePath)}`, entry.skeleton.trim(), '```', '');
    } else {
      lines.push('_Unindexed file._', '');
    }
  }
  if (maxTokens !== undefined && trimmed > 0) {
    lines.push(
      `_Note: token budget of ${maxTokens} excluded ${trimmed} lower-priority dependenc${trimmed === 1 ? 'y' : 'ies'}._`,
      '',
    );
  }

  if (unresolved.length > 0) {
    lines.push('## Unresolved imports', '');
    for (const u of unresolved) lines.push(`- \`${u}\``);
    lines.push('');
  }

  if (includeStats) {
    const budgetNote =
      maxTokens !== undefined ? ` · budget ${maxTokens} (${trimmed} deps trimmed)` : '';
    lines.push(
      '---',
      '',
      `_Token estimate — active: ${activeTokens} · pruned deps: ${dependencyTokens} · ` +
        `original: ${originalTokens} · saved: ${savings.savedTokens} (${savings.reductionPct}%)${budgetNote}._`,
      '',
    );
  }

  return {
    markdown: lines.join('\n'),
    activeFilePath: absList[0] ?? '',
    activeFilePaths: absList,
    activeSource: sources.join('\n'),
    included: selected,
    unresolved,
    tokenStats: {
      activeTokens,
      dependencyTokens,
      totalTokens,
      originalTokens,
      ...savings,
      ...(maxTokens !== undefined ? { budget: maxTokens } : {}),
      trimmed,
    },
  };
}

/**
 * Build the compressed context for a single open file.
 * `activeFilePath` may be absolute or project-relative.
 */
export function assemble(
  activeFilePath: string,
  cache: GraphCache,
  opts: AssembleOptions = {},
): AssembleResult {
  return assembleMany([activeFilePath], cache, opts);
}

/** Rank Ring-1 candidates by a cheap relevance proxy: fan-in desc, then depth asc. */
function rankByRelevance(
  candidates: AssembleResult['included'],
  cache: GraphCache,
): AssembleResult['included'] {
  const fanIn = new Map<string, number>();
  for (const entry of cache.values()) {
    for (const imp of entry.imports) fanIn.set(imp, (fanIn.get(imp) ?? 0) + 1);
  }
  return candidates
    .map((cand, idx) => ({ cand, idx }))
    .sort((a, b) => {
      const fa = fanIn.get(a.cand.filePath) ?? 0;
      const fb = fanIn.get(b.cand.filePath) ?? 0;
      if (fa !== fb) return fb - fa;
      const da = pathDepth(a.cand.filePath);
      const db = pathDepth(b.cand.filePath);
      if (da !== db) return da - db;
      return a.idx - b.idx;
    })
    .map((x) => x.cand);
}

/** Number of path segments (a rough "nearby module" proxy). */
function pathDepth(p: string): number {
  return p.split(/[/\\]+/).filter(Boolean).length;
}

/** Fallback import specifier extraction when no AST index exists yet. */
export function extractSpecifiers(source: string): string[] {
  const found: string[] = [];
  // import ... from 'x'; / import 'x'; / require('x')
  const re = /(?:from\s+['"`]|import\s+['"`]|require\s*\(\s*['"`])([^'"`]+)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[1]) found.push(m[1]);
  }
  return [...new Set(found)];
}

/** Resolve a fallback specifier to an existing file, mirroring sync.resolveImport. */
function resolveLocal(importer: string, specifier: string): string | null {
  if (!/^[.~@]/.test(specifier)) return null;
  if (specifier.startsWith('@/')) specifier = specifier.slice(2);
  else if (specifier.startsWith('~')) specifier = specifier.slice(1);
  const base = path.dirname(path.resolve(importer));
  const p = path.resolve(base, specifier);
  const candidates = [
    p,
    ...tsSourcesFor(p),
    `${p}.ts`,
    `${p}.tsx`,
    `${p}.js`,
    `${p}.jsx`,
    `${p}.py`,
    `${p}.go`,
    `${p}.rs`,
    `${p}.dart`,
    `${p}.swift`,
    `${p}.java`,
    `${p}.kt`,
    `${p}.c`,
    `${p}.cpp`,
    path.join(p, 'index.ts'),
    path.join(p, 'index.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.resolve(c);
  }
  return null;
}

/** Relative path for display (fall back to basename). */
function rel(p: string): string {
  try {
    const cwd = process.cwd();
    if (p.startsWith(cwd)) return '.' + p.slice(cwd.length);
  } catch {
    /* noop */
  }
  return p;
}

/** Return a code-block language label for a file path. */
function ext(p: string): string {
  return path.extname(p).replace(/^\./, '') || 'text';
}

export function assembleFromCache(
  activeFilePath: string,
  cache: GraphCache,
): AssembleResult {
  return assemble(activeFilePath, cache);
}
