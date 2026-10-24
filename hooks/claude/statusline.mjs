#!/usr/bin/env node
/**
 * Claude Code status line: shows the tokens token-shrink saved, in yellow.
 *
 * Reads `<project>/.token-shrink/stats.json` (written by the MCP server after
 * every context call). Claude Code pipes session JSON on stdin; we take the
 * project dir from it, falling back to CLAUDE_PROJECT_DIR / cwd. Prints
 * nothing when there are no stats yet.
 */
import fs from 'node:fs';
import path from 'node:path';

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {
  /* no / invalid stdin — use env fallbacks */
}

const root = path.resolve(
  process.argv[2] ||
    input.workspace?.project_dir ||
    input.workspace?.current_dir ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd(),
);

let stats;
try {
  stats = JSON.parse(fs.readFileSync(path.join(root, '.token-shrink', 'stats.json'), 'utf8'));
} catch {
  process.exit(0);
}

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const pct = (s) =>
  s.originalTokens > 0
    ? Math.round(((s.originalTokens - s.totalTokens) / s.originalTokens) * 1000) / 10
    : 0;
const saved = (s) => Math.max(0, (s.originalTokens || 0) - (s.totalTokens || 0));

const last = stats.last ?? { originalTokens: 0, totalTokens: 0 };
const session = stats.session ?? last;
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

process.stdout.write(
  `${YELLOW}⚡ token-shrink −${fmt(saved(last))} tokens (${pct(last)}%) · ` +
    `session −${fmt(saved(session))} (${pct(session)}%)${RESET}\n`,
);
