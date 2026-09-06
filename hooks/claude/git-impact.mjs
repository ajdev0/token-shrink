#!/usr/bin/env node
/**
 * Compact git-impact summary for Claude Code hooks.
 *
 * Prints changed files + diff stat when the working tree is dirty; prints
 * nothing useful (and exits 0) when clean. Intended to be cheap: two git
 * calls. Pair with the `git_diff_context` MCP tool for the heavy payload.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(process.argv[2] || process.env.CLAUDE_PROJECT_DIR || process.cwd());

function run(args) {
  try {
    return execFileSync('git', ['--no-pager', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
  } catch {
    return '';
  }
}

// Not a repo (or git missing) -> stay quiet so hooks never error.
if (!fs.existsSync(path.join(root, '.git')) && !run(['rev-parse', '--is-inside-work-tree']).trim()) {
  process.exit(0);
}

const status = run(['status', '--porcelain']).split('\n').filter(Boolean).slice(0, 40);
if (status.length === 0) {
  process.exit(0);
}

const unstaged = run(['diff', '--stat']).trim();
const staged = run(['diff', '--cached', '--stat']).trim();

const lines = [
  `[token-shrink] git impact — ${status.length} changed file${status.length === 1 ? '' : 's'}:`,
  '',
  ...status.map((s) => `  ${s}`),
];
if (unstaged) lines.push('', 'Unstaged changes:', unstaged);
if (staged) lines.push('', 'Staged changes:', staged);
console.log(lines.join('\n'));
