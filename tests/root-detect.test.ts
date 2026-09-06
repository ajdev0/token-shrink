import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectProjectRoot } from '../src/detect.js';

describe('detectProjectRoot', () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-detect-'));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  /** Create a directory (default) or empty file under `base`. */
  function mk(rel: string, asDir = true): string {
    const p = path.join(base, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (asDir) fs.mkdirSync(p, { recursive: true });
    else fs.writeFileSync(p, '', 'utf8');
    return p;
  }

  it('returns the git root above nested manifests (monorepo)', () => {
    mk('.git');
    mk('packages/app/package.json', false);
    const file = mk('packages/app/src/main.ts', false);

    expect(detectProjectRoot(file)).toBe(base);
  });

  it('returns the deepest manifest dir when no VCS dir exists', () => {
    mk('app/package.json', false);
    const file = mk('app/src/main.ts', false);

    expect(detectProjectRoot(file)).toBe(path.join(base, 'app'));
  });

  it('accepts a directory path as the start point', () => {
    mk('.git');
    const sub = mk('lib');

    expect(detectProjectRoot(sub)).toBe(base);
  });

  it('supports non-git VCS markers', () => {
    mk('.hg');
    const file = mk('src/a.py', false);

    expect(detectProjectRoot(file)).toBe(base);
  });

  it('treats a nested git root as the boundary, not the parent repo', () => {
    mk('.git'); // outer repo
    mk('nested/.git'); // inner repo
    const file = mk('nested/src/a.ts', false);

    expect(detectProjectRoot(file)).toBe(path.join(base, 'nested'));
  });

  it('works for files that do not exist yet (active-file pending writes)', () => {
    mk('proj/package.json', false);
    const ghost = path.join(base, 'proj', 'src', 'not-created.ts');

    expect(detectProjectRoot(ghost)).toBe(path.join(base, 'proj'));
  });

  it('recognizes common per-language manifests', () => {
    const cases = [
      ['py', 'pyproject.toml'],
      ['go', 'go.mod'],
      ['rs', 'Cargo.toml'],
      ['dart', 'pubspec.yaml'],
      ['swift', 'Package.swift'],
      ['java', 'pom.xml'],
      ['kt', 'build.gradle.kts'],
      ['php', 'composer.json'],
    ] as const;
    for (const [dir, manifest] of cases) {
      const root = path.join(base, `app-${dir}`);
      mk(path.join(`app-${dir}`, manifest), false);
      expect(detectProjectRoot(mk(`app-${dir}/src/main`))).toBe(root);
    }
  });

  it('returns null for a marker-free tree (walks to the fs root)', () => {
    const file = mk('plain/deep/file.ts', false);

    expect(detectProjectRoot(file)).toBeNull();
  });
});
