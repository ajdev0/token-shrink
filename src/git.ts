/**
 * Thin `git` plumbing helpers for the `git_diff_context` MCP tool. Uses the
 * system `git` binary via spawn (no native deps) and always runs with
 * `--no-pager` + `LC_ALL=C` so output is deterministic and parseable.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export type GitDiffScope = 'worktree' | 'staged' | 'branch';

export interface GitChangedOptions {
  scope: GitDiffScope;
  /** Base ref for `scope: 'branch'` (e.g. `main`). Defaults to `HEAD~1`. */
  base?: string;
  /** Head ref for `scope: 'branch'`. Defaults to `HEAD`. */
  head?: string;
  /** Include untracked files (worktree scope only). */
  includeUntracked?: boolean;
}

export interface GitChangedResult {
  /** Absolute paths of changed files that exist on disk. */
  files: string[];
  /** Non-empty when git could not be satisfied (not a repo, bad ref, …). */
  error?: string;
}

function runGit(root: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', ['--no-pager', ...args], {
      cwd: root,
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', (e) => resolve({ ok: false, out: '', err: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, out, err }));
  });
}

/** Split git name-only output into relative paths. */
function parseNames(out: string): string[] {
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function isFatal(err: string): string | undefined {
  if (!err) return undefined;
  const e = err.trim();
  if (/not a git repository|fatal:/i.test(e)) return e;
  return undefined;
}

/**
 * List files changed in the repository at `root`. Paths are returned absolute
 * and filtered to files that still exist on disk.
 */
export async function gitChangedFiles(
  root: string,
  opts: GitChangedOptions,
): Promise<GitChangedResult> {
  const scope = opts.scope ?? 'worktree';
  const filter = '--diff-filter=ACMRT';

  let relative: string[] = [];
  if (scope === 'staged') {
    const r = await runGit(root, ['diff', '--cached', '--name-only', filter]);
    const fatal = isFatal(r.err);
    if (!r.ok) return { files: [], ...(fatal ? { error: fatal } : {}) };
    relative = parseNames(r.out);
  } else if (scope === 'branch') {
    const base = opts.base ?? 'HEAD~1';
    const head = opts.head ?? 'HEAD';
    const r = await runGit(root, ['diff', '--name-only', `${base}...${head}`, filter]);
    const fatal = isFatal(r.err);
    if (!r.ok) return { files: [], ...(fatal ? { error: fatal } : {}) };
    relative = parseNames(r.out);
  } else {
    // worktree = staged + unstaged (merged, deduped).
    const [unstaged, staged] = await Promise.all([
      runGit(root, ['diff', '--name-only', filter]),
      runGit(root, ['diff', '--cached', '--name-only', filter]),
    ]);
    const fatal = isFatal(unstaged.err) ?? isFatal(staged.err);
    if (!unstaged.ok && !staged.ok) {
      return { files: [], ...(fatal ? { error: fatal } : {}) };
    }
    const merged = new Set([...parseNames(unstaged.out), ...parseNames(staged.out)]);
    if (opts.includeUntracked) {
      const ut = await runGit(root, ['ls-files', '--others', '--exclude-standard']);
      for (const f of parseNames(ut.out)) merged.add(f);
    }
    relative = [...merged];
  }

  const files = relative
    .map((rel) => path.resolve(root, rel))
    .filter((abs) => {
      try {
        return fs.statSync(abs).isFile();
      } catch {
        return false; // deleted in the meantime / rename source
      }
    });

  return { files };
}

/** `git diff` arguments selecting the same changes as `gitChangedFiles`. */
function diffArgsFor(opts: GitChangedOptions): string[][] {
  if (opts.scope === 'staged') return [['--cached']];
  if (opts.scope === 'branch') return [[`${opts.base ?? 'HEAD~1'}...${opts.head ?? 'HEAD'}`]];
  return [[], ['--cached']];
}

/**
 * Changed (new-side) line numbers per absolute file path, from zero-context
 * hunks. A pure deletion marks the line it happened at. Untracked files have
 * no hunks and are simply absent.
 */
export async function gitChangedLines(
  root: string,
  opts: GitChangedOptions,
): Promise<Map<string, number[]>> {
  const out = new Map<string, Set<number>>();
  for (const args of diffArgsFor(opts)) {
    const r = await runGit(root, [
      'diff',
      '-U0',
      '--no-color',
      '--no-ext-diff',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      ...args,
    ]);
    if (!r.ok) continue;
    let file: string | null = null;
    for (const line of r.out.split('\n')) {
      if (line.startsWith('+++ ')) {
        const p = line.slice(4).trim();
        file = p === '/dev/null' ? null : path.resolve(root, p.slice(2));
        continue;
      }
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hunk || !file) continue;
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const set = out.get(file) ?? new Set<number>();
      if (count === 0) set.add(Math.max(1, start));
      for (let l = start; l < start + count; l++) set.add(l);
      out.set(file, set);
    }
  }
  return new Map([...out].map(([f, s]) => [f, [...s].sort((a, b) => a - b)]));
}
