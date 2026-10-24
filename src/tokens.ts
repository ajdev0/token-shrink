/**
 * Token accounting shared by the watcher, assembler and servers: the cheap
 * token estimate, the human "tokens saved" line, and the per-project stats
 * file (`<root>/.token-shrink/stats.json`) that status lines read.
 */

import fs from 'node:fs';
import path from 'node:path';
import picocolors from 'picocolors';

declare const __TOKEN_SHRINK_VERSION__: string;

/** Package version, inlined from package.json at build time. */
export const VERSION: string =
  typeof __TOKEN_SHRINK_VERSION__ === 'string' ? __TOKEN_SHRINK_VERSION__ : '0.0.0-dev';

/** Rough, dependency-free token approximation (words + punctuation runs). */
export function approximateTokens(text: string): number {
  if (!text) return 0;
  const tokens = text.match(/[A-Za-z0-9_$]+|[^A-Za-z0-9_\s$]/g);
  return tokens ? tokens.length : 0;
}

/** Before/after token counts for one payload. */
export interface Savings {
  originalTokens: number;
  totalTokens: number;
}

/** Tokens saved and the percentage reduction (one decimal). */
export function savingsOf(s: Savings): { savedTokens: number; reductionPct: number } {
  const savedTokens = Math.max(0, s.originalTokens - s.totalTokens);
  const reductionPct =
    s.originalTokens > 0
      ? Math.round((savedTokens / s.originalTokens) * 1000) / 10
      : 0;
  return { savedTokens, reductionPct };
}

const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * One-line savings summary, e.g.
 * `⚡ token-shrink: 12,480 → 1,936 tokens (−10,544 · 84.5% saved)`.
 * `color` wraps it in yellow; leave it off for text the model reads.
 */
export function formatSavings(
  s: Savings,
  opts: { color?: boolean; label?: string } = {},
): string {
  const { savedTokens, reductionPct } = savingsOf(s);
  const line =
    `⚡ ${opts.label ?? 'token-shrink'}: ${fmt(s.originalTokens)} → ${fmt(s.totalTokens)} tokens ` +
    `(−${fmt(savedTokens)} · ${reductionPct}% saved)`;
  return opts.color ? picocolors.yellow(line) : line;
}

/** Whether a stream should get ANSI color (TTY or FORCE_COLOR). */
export function wantsColor(stream: NodeJS.WriteStream = process.stderr): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(stream.isTTY);
}

/** Persisted savings for a project, read by `token-shrink stats` and status lines. */
export interface StatsFile {
  version: 1;
  last: Savings & { tool: string; at: string };
  /** Totals since the current server process started. */
  session: Savings & { calls: number; startedAt: string };
  /** Totals across every run in this project. */
  allTime: Savings & { calls: number };
}

export function statsPathFor(root: string): string {
  return path.join(root, '.token-shrink', 'stats.json');
}

export function readStats(root: string): StatsFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(statsPathFor(root), 'utf8'));
    return parsed?.version === 1 ? (parsed as StatsFile) : null;
  } catch {
    return null;
  }
}

/**
 * Add one call's savings to the project's stats file. `sessionStartedAt`
 * identifies the running server: a different value resets the session totals.
 * Written atomically (`*.tmp` → rename); failures are swallowed so stats can
 * never break a tool call.
 */
export function recordSavings(
  root: string,
  tool: string,
  s: Savings,
  sessionStartedAt: string,
): StatsFile | null {
  try {
    const prev = readStats(root);
    const sameSession = prev?.session.startedAt === sessionStartedAt;
    const next: StatsFile = {
      version: 1,
      last: {
        originalTokens: s.originalTokens,
        totalTokens: s.totalTokens,
        tool,
        at: new Date().toISOString(),
      },
      session: {
        originalTokens: (sameSession ? prev!.session.originalTokens : 0) + s.originalTokens,
        totalTokens: (sameSession ? prev!.session.totalTokens : 0) + s.totalTokens,
        calls: (sameSession ? prev!.session.calls : 0) + 1,
        startedAt: sessionStartedAt,
      },
      allTime: {
        originalTokens: (prev?.allTime.originalTokens ?? 0) + s.originalTokens,
        totalTokens: (prev?.allTime.totalTokens ?? 0) + s.totalTokens,
        calls: (prev?.allTime.calls ?? 0) + 1,
      },
    };
    const file = statsPathFor(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return next;
  } catch {
    return null;
  }
}
