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
  /** Ring-0 text to emit instead of the full source (focused slimming), by absolute path. */
  ring0Overrides?: Map<string, string>;
  /** Ring-1 text to emit instead of the cached skeleton (used exports), by absolute path. */
  ring1Overrides?: Map<string, string>;
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
  /** Ring-0 text actually emitted, in `activeFilePaths` order. */
  ring0Texts: string[];
  /** True when any Ring-0 file was slimmed to its focus lines. */
  ring0Focused: boolean;
  /**
   * Ring-1 entries actually included. `skeleton` is the emitted text (absent
   * for unindexed files); `usedOnly` marks a used-exports filtered skeleton.
   */
  included: {
    filePath: string;
    language: string | null;
    skeleton?: string;
    usedOnly?: boolean;
  }[];
  /** Paths referenced by imports that could not be resolved to a file. */
  unresolved: string[];
  /** Approximate token accounting for this payload. */
  tokenStats: TokenStats;
}

/** Rough fixed Markdown overhead (title + section headings), for quick estimates. */
export const MARKDOWN_OVERHEAD_TOKENS = 40;

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
    ring0Overrides,
    ring1Overrides,
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
    const override = ring0Overrides?.get(abs);
    if (override !== undefined) return override;
    const entry = cache.get(abs);
    return pruneActiveFile && entry ? entry.skeleton : sources[i];
  });
  const focused = absList.some((abs) => ring0Overrides?.has(abs));

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

  const activeTokens = ring0Texts.reduce(
    (acc, t) => acc + approximateTokens(t),
    0,
  );

  // Greedy packing: respect maxSkeletons always; additionally keep the whole
  // rendered payload (Ring 0, Ring 1, headings, fences and notes) within the
  // token budget. Fixed parts are measured from their real text, with
  // worst-case numbers standing in for the counts filled in after packing.
  const view = {
    absList,
    ring0Texts,
    focused,
    unresolved,
    includeStats,
    maxTokens,
  };
  const fixedTokens = approximateTokens(
    [
      ...renderHead(view, maxSkeletons),
      ...renderTail(view, {
        trimmed: 2,
        activeTokens: 1,
        dependencyTokens: 1,
        originalTokens: 1,
        savedTokens: 1,
        reductionPct: 0.5,
      }),
    ].join('\n'),
  );
  const budget =
    maxTokens === undefined ? undefined : Math.max(0, maxTokens - fixedTokens);
  // Ring 0 is never trimmed; say so when it alone cannot fit the budget.
  const ring0OverBudget = maxTokens !== undefined && fixedTokens > maxTokens;
  const selected: AssembleResult['included'] = [];
  let trimmed = 0;
  let dependencyTokens = 0;
  let dependencyOriginalTokens = 0;
  let packed = 0;
  for (const cand of ordered) {
    if (selected.length >= maxSkeletons) break;
    const entry = cache.get(cand.filePath);
    const override = ring1Overrides?.get(cand.filePath);
    const skeleton = entry ? (override ?? entry.skeleton) : undefined;
    const item = {
      ...cand,
      ...(skeleton !== undefined ? { skeleton } : {}),
      ...(entry && override !== undefined ? { usedOnly: true } : {}),
    };
    // Unindexed candidates get a small nominal cost until they are indexed.
    const cost = skeleton !== undefined ? approximateTokens(skeleton) : 8;
    const blockCost = approximateTokens(renderRing1Block(item).join('\n'));
    if (budget !== undefined && packed + blockCost > budget) {
      trimmed++;
      continue;
    }
    packed += blockCost;
    selected.push(item);
    dependencyTokens += cost;
    dependencyOriginalTokens += entry?.originalTokens ?? cost;
  }
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

  const lines = [
    ...renderHead(view, selected.length),
    ...selected.flatMap(renderRing1Block),
    ...renderTail({ ...view, ring0OverBudget }, {
      trimmed,
      activeTokens,
      dependencyTokens,
      originalTokens,
      ...savings,
    }),
  ];

  return {
    markdown: lines.join('\n'),
    activeFilePath: absList[0] ?? '',
    activeFilePaths: absList,
    activeSource: sources.join('\n'),
    ring0Texts,
    ring0Focused: focused,
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

/** What the Markdown renderers need from an assembly. */
interface RenderView {
  absList: string[];
  ring0Texts: string[];
  focused: boolean;
  unresolved: string[];
  includeStats: boolean;
  maxTokens?: number;
  /** Ring 0 alone exceeds `maxTokens` (it is kept in full regardless). */
  ring0OverBudget?: boolean;
}

/** Title, Ring 0 and the Ring-1 intro. */
function renderHead(v: RenderView, ring1Count: number): string[] {
  const lines: string[] = ['# Compressed Code Context', ''];
  if (v.absList.length === 1) {
    lines.push(`Active file: \`${rel(v.absList[0])}\``, '');
  } else {
    lines.push('Active files:', '');
    for (const p of v.absList) lines.push(`- \`${rel(p)}\``);
    lines.push('');
  }
  lines.push(
    v.absList.length === 1
      ? '## Ring 0 — Active file (full text)'
      : '## Ring 0 — Active files (full text)',
    '',
  );
  if (v.focused) {
    lines.push(
      '_Focused to fit the token budget: bodies outside the focus lines are pruned._',
      '',
    );
  }
  for (let i = 0; i < v.absList.length; i++) {
    if (v.absList.length > 1) lines.push(`### \`${rel(v.absList[i])}\``, '');
    const body = v.ring0Texts[i].trim() || '(empty or unreadable file)';
    lines.push(`\`\`\`${ext(v.absList[i])}`, body, '```', '');
  }
  lines.push(
    `## Ring 1 — Pruned dependencies (${ring1Count})`,
    '',
    'Implementation bodies removed; type signatures, interfaces and exports retained.',
    '',
  );
  if (ring1Count === 0) lines.push('_No local dependency skeletons available._', '');
  return lines;
}

/** One Ring-1 dependency: heading plus fenced skeleton. */
function renderRing1Block(inc: AssembleResult['included'][number]): string[] {
  const lines = [`### \`${rel(inc.filePath)}\`${inc.usedOnly ? ' (used exports only)' : ''}`, ''];
  if (inc.skeleton !== undefined) {
    lines.push(`\`\`\`${ext(inc.filePath)}`, inc.skeleton.trim(), '```', '');
  } else {
    lines.push('_Unindexed file._', '');
  }
  return lines;
}

/** Budget note, unresolved imports and the optional stats line. */
function renderTail(
  v: RenderView,
  n: {
    trimmed: number;
    activeTokens: number;
    dependencyTokens: number;
    originalTokens: number;
    savedTokens: number;
    reductionPct: number;
  },
): string[] {
  const lines: string[] = [];
  if (v.ring0OverBudget) {
    lines.push(
      `_Note: the active file${v.absList.length === 1 ? '' : 's'} alone exceed the token budget of ` +
        `${v.maxTokens}; Ring 0 is never trimmed (pass focusLines to slim it)._`,
      '',
    );
  }
  if (v.maxTokens !== undefined && n.trimmed > 0) {
    lines.push(
      `_Note: token budget of ${v.maxTokens} excluded ${n.trimmed} lower-priority dependenc${n.trimmed === 1 ? 'y' : 'ies'}._`,
      '',
    );
  }
  if (v.unresolved.length > 0) {
    lines.push('## Unresolved imports', '');
    for (const u of v.unresolved) lines.push(`- \`${u}\``);
    lines.push('');
  }
  if (v.includeStats) {
    const budgetNote =
      v.maxTokens !== undefined ? ` · budget ${v.maxTokens} (${n.trimmed} deps trimmed)` : '';
    lines.push(
      '---',
      '',
      `_Token estimate — active: ${n.activeTokens} · pruned deps: ${n.dependencyTokens} · ` +
        `original: ${n.originalTokens} · saved: ${n.savedTokens} (${n.reductionPct}%)${budgetNote}._`,
      '',
    );
  }
  return lines;
}

/**
 * Tokens a file's Markdown wrapper costs: its `### \`path\`` heading plus the
 * code fence around its text.
 */
export function fileBlockOverhead(filePath: string): number {
  return approximateTokens(`### \`${rel(filePath)}\`\n\`\`\`${ext(filePath)}\n\`\`\``);
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
export function resolveLocal(importer: string, specifier: string): string | null {
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
