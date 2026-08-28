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

import type { GraphCache } from '../watcher/sync.js';

export interface AssembleOptions {
  /** Number of PRD-style stats to append (disabled by default). */
  includeStats?: boolean;
  /** Maximum number of ring-1 files to include. */
  maxSkeletons?: number;
  /** Whether the active file itself should also be pruned (Ring 0 raw by default). */
  pruneActiveFile?: boolean;
}

export interface AssembleResult {
  /** Human-readable Markdown payload for an agent. */
  markdown: string;
  activeFilePath: string;
  /** Ring-0 full text of the active file. */
  activeSource: string;
  /** Ring-1 entries actually included. */
  included: { filePath: string; language: string | null }[];
  /** Paths referenced by imports that could not be resolved to a file. */
  unresolved: string[];
}

/**
 * Build the compressed context for an open file.
 * `activeFilePath` may be absolute or project-relative.
 */
export function assemble(
  activeFilePath: string,
  cache: GraphCache,
  opts: AssembleOptions = {},
): AssembleResult {
  const { includeStats = false, maxSkeletons = 50, pruneActiveFile = false } = opts;

  const abs = path.resolve(activeFilePath);
  const activeSource = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const activeEntry = cache.get(abs);

  const included: AssembleResult['included'] = [];
  const unresolved: string[] = [];

  // Ring 1: walk the active file's direct imports.
  const seen = new Set<string>();
  if (activeEntry) {
    for (const imp of activeEntry.imports) {
      const entry = cache.get(imp);
      if (!entry) {
        unresolved.push(imp);
        continue;
      }
      if (seen.has(imp)) continue;
      seen.add(imp);
      included.push({ filePath: imp, language: entry.language });
      if (included.length >= maxSkeletons) break;
    }
  }

  // If the active file is unsupported (no cache entry), try to resolve its
  // imports on the fly from disk so the payload is still useful.
  if (!activeEntry && activeSource) {
    // Fallback: derive imports from a lightweight regex and resolve from disk.
    const specifiers = extractSpecifiers(activeSource);
    for (const spec of specifiers) {
      const resolved = resolveLocal(abs, spec);
      if (!resolved) {
        unresolved.push(spec);
        continue;
      }
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      const cached = cache.get(resolved);
      included.push({ filePath: resolved, language: cached?.language ?? null });
      if (included.length >= maxSkeletons) break;
    }
  }

  const lines: string[] = [];
  lines.push('# Compressed Code Context', '');
  lines.push(`Active file: \`${rel(abs)}\``, '');

  // Ring 0.
  lines.push('## Ring 0 — Active file (full text)', '');
  const ring0 = pruneActiveFile && activeEntry ? activeEntry.skeleton : activeSource;
  lines.push(`\`\`\`${ext(activeFilePath)}`);
  lines.push(ring0.trim() || '(empty or unreadable file)');
  lines.push('```', '');

  // Ring 1.
  lines.push(
    `## Ring 1 — Pruned dependencies (${included.length})`,
    '',
    'Implementation bodies removed; type signatures, interfaces and exports retained.',
    '',
  );
  if (included.length === 0) {
    lines.push('_No local dependency skeletons available._', '');
  }
  for (const inc of included) {
    const entry = cache.get(inc.filePath);
    const label = rel(inc.filePath);
    lines.push(`### \`${label}\``, '');
    if (entry) {
      lines.push(`\`\`\`${ext(inc.filePath)}`);
      lines.push(entry.skeleton.trim());
      lines.push('```', '');
    } else {
      lines.push('_Unindexed file._', '');
    }
  }

  if (unresolved.length > 0) {
    lines.push('## Unresolved imports', '');
    for (const u of unresolved) lines.push(`- \`${u}\``);
    lines.push('');
  }

  if (includeStats) {
    const depTokens = included.reduce(
      (acc, inc) => {
        const e = cache.get(inc.filePath);
        return e ? acc + approximateTokens(e.skeleton) : acc;
      },
      0,
    );
    lines.push('---', '');
    lines.push(
      `_Token estimate — active: ${approximateTokens(activeSource)} · pruned deps: ${depTokens}._`,
      '',
    );
  }

  return {
    markdown: lines.join('\n'),
    activeFilePath: abs,
    activeSource,
    included,
    unresolved,
  };
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

/** Rough, dependency-free token approximation (words + punctuation runs). */
export function approximateTokens(text: string): number {
  if (!text) return 0;
  const tokens = text.match(/[A-Za-z0-9_$]+|[^A-Za-z0-9_\s$]/g);
  return tokens ? tokens.length : 0;
}

export function assembleFromCache(
  activeFilePath: string,
  cache: GraphCache,
): AssembleResult {
  return assemble(activeFilePath, cache);
}
