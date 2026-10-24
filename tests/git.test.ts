import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { gitChangedFiles, gitChangedLines } from '../src/git.js';

describe('gitChangedFiles', () => {
  let repo: string;
  let plain: string;
  let srcA: string;
  let srcB: string;
  let srcC: string;

  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-git-'));
    git(['init', '-b', 'main'], repo);
    git(['config', 'user.email', 't@example.com'], repo);
    git(['config', 'user.name', 'Test'], repo);

    srcA = path.join(repo, 'a.ts');
    srcB = path.join(repo, 'b.ts');
    srcC = path.join(repo, 'c.ts');
    fs.writeFileSync(srcA, 'export const a = 1;\n');
    fs.writeFileSync(srcB, 'export const b = 2;\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'initial'], repo);

    // b.ts now has an unstaged modification.
    fs.writeFileSync(srcB, 'export const b = 22;\n');

    plain = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-nogit-'));
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(plain, { recursive: true, force: true });
  });

  it('lists unstaged worktree changes as absolute existing files', async () => {
    const res = await gitChangedFiles(repo, { scope: 'worktree' });
    expect(res.error).toBeUndefined();
    expect(res.files).toContain(srcB);
    expect(res.files).not.toContain(srcA);
  });

  it('separates staged from unstaged', async () => {
    fs.writeFileSync(srcA, 'export const a = 11;\n');
    git(['add', 'a.ts'], repo);
    try {
      const staged = await gitChangedFiles(repo, { scope: 'staged' });
      expect(staged.files).toContain(srcA);
      expect(staged.files).not.toContain(srcB);
    } finally {
      git(['reset', '-q'], repo); // unstage a.ts
    }
  });

  it('optionally includes untracked files', async () => {
    fs.writeFileSync(srcC, 'export const c = 3;\n');
    try {
      const without = await gitChangedFiles(repo, { scope: 'worktree' });
      expect(without.files).not.toContain(srcC);
      const withUntracked = await gitChangedFiles(repo, {
        scope: 'worktree',
        includeUntracked: true,
      });
      expect(withUntracked.files).toContain(srcC);
    } finally {
      fs.rmSync(srcC, { force: true });
    }
  });

  it('supports branch ranges (base...head)', async () => {
    // Commit the pending b.ts change, then a second commit.
    git(['add', '-A'], repo);
    git(['commit', '-m', 'change b'], repo);
    try {
      const res = await gitChangedFiles(repo, { scope: 'branch', base: 'HEAD~1', head: 'HEAD' });
      expect(res.files).toContain(srcB);
    } finally {
      git(['reset', '--hard', '-q', 'HEAD~1'], repo);
    }
  });

  it('reports a helpful error outside a git repository', async () => {
    const res = await gitChangedFiles(plain, { scope: 'worktree' });
    expect(res.error).toBeTruthy();
    expect(res.files).toEqual([]);
  });
});

describe('gitChangedLines', () => {
  it('reports new-side line numbers for modified and deleted lines', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-hunks-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 't@example.com']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'diff.noprefix', 'true']);
    const file = path.join(repo, 'x.ts');
    fs.writeFileSync(file, ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'].join('\n') + '\n');
    git(['add', '-A']);
    git(['commit', '-m', 'init']);
    // change line 2, delete line 5, append a line
    fs.writeFileSync(file, ['l1', 'L2', 'l3', 'l4', 'l6', 'l7'].join('\n') + '\n');
    try {
      const lines = await gitChangedLines(repo, { scope: 'worktree' });
      expect(lines.get(file)).toEqual([2, 4, 6]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
