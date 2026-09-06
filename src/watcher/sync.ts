/**
 * Incremental synchronization layer (Phase 3).
 *
 * - Watches the repository with chokidar (ignoring vendor/build dirs).
 * - On add/change, hashes the file and, if the hash changed, re-prunes it and
 *   updates the in-memory graph cache.
 * - Extracts import/require specifiers from each file and normalizes relative
 *   and aliased paths to absolute file paths on disk.
 *
 * The graph cache is shared with the Context Assembler, which reads ring-1
 * skeletons out of it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import chokidar, { type FSWatcher, type Matcher } from 'chokidar';

import { ensureParserInit } from '../parser/pruner.js';
import { analyze } from '../parser/analyze.js';
import type { SymbolInfo } from '../parser/symbols.js';
import { matchesAny, type TokenShrinkConfig } from '../config.js';

export type { Matcher };

/** Default paths that will never be indexed or watched. */
export const DEFAULT_IGNORED = [
  /(^|[/\\])\.[^/\\]+/, // dotfiles / dot-dirs (.git, .cursor, .env, ...)
  /node_modules/,
  /[/\\](build|dist|out|coverage|\.next|\.turbo|\.cache)[/\\]/,
];

export interface CacheEntry {
  /** sha1 of the last-indexed file content. */
  hash: string;
  /** Pruned skeleton for this file. */
  skeleton: string;
  /** The language name used to prune it (or null if unsupported). */
  language: string | null;
  /** Absolute paths of the files this file imports. */
  imports: string[];
  /** Named definitions found while indexing (for expand_symbol / search). */
  symbols?: SymbolInfo[];
}

export type GraphCache = Map<string, CacheEntry>;

export class ContextCache {
  readonly entries: GraphCache = new Map();
  private initPromise: Promise<void> | null = null;

  ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = ensureParserInit();
    }
    return this.initPromise;
  }

  /** Returns the cached skeleton for a file, if present. */
  getSkeleton(filePath: string): CacheEntry | null {
    return this.entries.get(path.resolve(filePath)) ?? null;
  }

  get imports() {
    return this.entries;
  }
}

/** Compute a sha1 of a string. */
export function hashOf(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/**
 * Extract import/require specifiers from source text using a robust,
 * language-agnostic regex (AST-based import queries are grammar-fragile and
 * occasionally malformed; regex covers the common import forms across JS/TS,
 * Python, Go, Rust, Dart, Swift, Java, Kotlin, PHP, C/C++).
 * Returns the matched specifier strings (may be relative or absolute).
 */
export function extractImports(_filePath: string, source: string): string[] {
  const out: string[] = [];

  // import ... from 'x'   |   import 'x'   |   require('x')
  const re =
    /(?:from\s+['"`]([^'"`]+)['"`]|import\s+['"`]([^'"`]+)['"`]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) out.push(spec);
  }

  // Python / Go / Rust / Dart / Swift / Java / Kotlin / C/C++ single-quote not
  // covered by the JS-style regex is out of scope for the first pass.

  return [...new Set(out)].filter(Boolean);
}

/** Normalize a specifier to an absolute file path when it resolves locally. */
export function resolveImport(
  importer: string,
  specifier: string,
  root: string,
): string | null {
  // Skip bare, non-relative imports (npm packages) and obviously external.
  if (!/^[.~@]/.test(specifier)) {
    // Alias `@/...` and `~` map to the project root.
    if (specifier.startsWith('@/')) {
      return resolveCandidate(path.join(root, specifier.slice(2)));
    }
    if (specifier.startsWith('@')) {
      return null; // scoped package, not local
    }
    if (specifier.startsWith('~')) {
      return resolveCandidate(path.join(root, specifier.slice(1)));
    }
    return null;
  }

  const base = path.dirname(path.resolve(importer));
  return resolveCandidate(path.resolve(base, specifier));
}

/** Try a specifier with common extension/index additions. */
function resolveCandidate(p: string): string | null {
  const candidates = [
    p,
    `${p}.ts`,
    `${p}.tsx`,
    `${p}.js`,
    `${p}.jsx`,
    `${p}.mjs`,
    `${p}.cjs`,
    `${p}.py`,
    `${p}.go`,
    `${p}.rs`,
    `${p}.dart`,
    `${p}.swift`,
    `${p}.java`,
    `${p}.kt`,
    `${p}.c`,
    `${p}.cpp`,
    `${p}.h`,
    `${p}.hpp`,
    `${p}.php`,
    path.join(p, 'index.ts'),
    path.join(p, 'index.js'),
    path.join(p, 'index.tsx'),
    path.join(p, 'index.jsx'),
    path.join(p, 'index.py'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.resolve(c);
  }
  return null;
}

export interface SyncOptions {
  root: string;
  ignored?: Matcher[];
  /** Optional `.tokenshrinkrc.json` settings. */
  config?: TokenShrinkConfig;
  onIndexed?: (filePath: string, entry: CacheEntry) => void;
  /** Called when a watched file disappears from disk (cache entry dropped). */
  onRemoved?: (filePath: string) => void;
}

/**
 * Watch a project root and keep the graph cache fresh. Returns the cache and
 * a close() handle. `prune` is awaited per change to keep hot-reload latency
 * predictable.
 */
export function createWatcher(opts: SyncOptions) {
  const cache = new ContextCache();
  const { root, ignored = DEFAULT_IGNORED, config, onIndexed, onRemoved } = opts;

  // Config `ignorePatterns` become extra matchers evaluated against the path
  // relative to the repo root (so globs like `**/dist/**` behave predictably).
  const rel = (abs: string) => path.relative(root, abs);
  const effectiveIgnored: Matcher[] = [
    ...ignored,
    ...(config?.ignorePatterns?.length
      ? [(_abs: string) => matchesAny(rel(String(_abs)), config.ignorePatterns)]
      : []),
  ];

  // Debounce a burst of events into a single re-prune per file.
  const pending = new Map<string, NodeJS.Timeout>();
  const DEBOUNCE_MS = 100;

  async function handle(filePath: string) {
    const abs = path.resolve(filePath);
    let source: string;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return; // sockets/symlinks etc.
      source = fs.readFileSync(abs, 'utf8');
    } catch {
      return; // file vanished between event and read
    }
    const hash = hashOf(source);
    const cached = cache.entries.get(abs);
    if (cached && cached.hash === hash) return; // unchanged

    await cache.ensureInit();
    const keepFull = config?.keepUnpruned?.length
      ? matchesAny(path.relative(root, abs), config.keepUnpruned)
      : false;
    const { code, language, symbols } = await analyze(abs, source, {
      skipPrune: keepFull,
      preserveAnnotations: config?.preserveAnnotations,
    });
    const imports = extractImports(abs, source);
    const entry: CacheEntry = {
      hash,
      skeleton: code,
      language,
      imports: imports
        .map((spec) => resolveImport(abs, spec, root))
        .filter((p): p is string => p !== null),
      ...(symbols.length > 0 ? { symbols } : {}),
    };
    cache.entries.set(abs, entry);
    onIndexed?.(abs, entry);
  }

  const watcher: FSWatcher = chokidar.watch(root, {
    // Combine path matchers with a stat check so non-regular files (e.g. unix
    // sockets) are never opened with fs.watch (which raises UVException).
    ignored(_p, stats) {
      if (stats && !stats.isFile() && !stats.isDirectory()) return true;
      return isIgnored(path.resolve(String(_p)), effectiveIgnored);
    },
    alwaysStat: true,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
  });

  function debounce(filePath: string) {
    const abs = path.resolve(filePath);
    const existing = pending.get(abs);
    if (existing) clearTimeout(existing);
    // Fire immediately on the first event, then coalesce noise.
    if (!existing) void handle(abs);
    pending.set(
      abs,
      setTimeout(() => pending.delete(abs), DEBOUNCE_MS),
    );
  }

  watcher.on('add', debounce);
  watcher.on('change', debounce);
  watcher.on('unlink', (filePath: string) => {
    const abs = path.resolve(filePath);
    cache.entries.delete(abs);
    onRemoved?.(abs);
  });

  return {
    cache,
    watcher,
    /** Index an existing file right now (bypasses the watcher). */
    index: handle,
    /**
     * Index the whole tree once (cold start). Returns the number of files
     * successfully indexed.
     */
    async indexAll(): Promise<number> {
      const files: string[] = [];
      await walk(root, (f) => files.push(f), effectiveIgnored);
      let ok = 0;
      for (const f of files) {
        try {
          await handle(f);
          ok++;
        } catch {
          /* skip unparseable files */
        }
      }
      return ok;
    },
    close: () => watcher.close(),
  };
}

/** Recursively list supported source files, honoring ignore patterns. */
async function walk(
  root: string,
  push: (f: string) => void,
  ignored: Matcher[],
): Promise<void> {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(root, e.name);
    if (isIgnored(abs, ignored)) continue;
    if (e.isDirectory()) {
      await walk(abs, push, ignored);
    } else if (e.isFile()) {
      push(abs);
    }
    // Skip sockets, symlinks to non-files, devices, etc. to avoid chokidar/fs
    // throwing UVException while trying to watch them.
  }
}

function isIgnored(abs: string, ignored: Matcher[]): boolean {
  for (const m of ignored) {
    if (typeof m === 'function') {
      if (m(abs)) return true;
      continue;
    }
    if (typeof m === 'string' && abs.includes(m)) return true;
    if (m instanceof RegExp && m.test(abs)) return true;
  }
  return false;
}
