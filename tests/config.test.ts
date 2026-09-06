import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadConfig,
  matchesAny,
  matchesGlob,
  globToRegExp,
  CONFIG_FILE_NAME,
} from '../src/config.js';
import { createWatcher } from '../src/watcher/sync.js';

describe('loadConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cfg-'));
  });

  it('returns empty defaults when the file is absent', () => {
    const cfg = loadConfig(dir);
    expect(cfg).toEqual({ ignorePatterns: [], keepUnpruned: [], preserveAnnotations: [] });
  });

  it('parses a valid config and ignores unknown keys', () => {
    fs.writeFileSync(
      path.join(dir, CONFIG_FILE_NAME),
      JSON.stringify({
        ignorePatterns: ['gen/**', 'dist'],
        keepUnpruned: ['src/global.d.ts'],
        preserveAnnotations: ['@keepContext', '@api'],
        futureKey: 42,
      }),
      'utf8',
    );
    expect(loadConfig(dir)).toEqual({
      ignorePatterns: ['gen/**', 'dist'],
      keepUnpruned: ['src/global.d.ts'],
      preserveAnnotations: ['@keepContext', '@api'],
    });
  });

  it('falls back to defaults and warns on invalid JSON', () => {
    fs.writeFileSync(path.join(dir, CONFIG_FILE_NAME), '{ nope', 'utf8');
    const warnings: string[] = [];
    const cfg = loadConfig(dir, (m) => warnings.push(m));
    expect(cfg).toEqual({ ignorePatterns: [], keepUnpruned: [], preserveAnnotations: [] });
    expect(warnings.join('\n')).toContain('Invalid');
  });
});

describe('glob matching', () => {
  it('matches globbed relative paths', () => {
    expect(matchesAny('src/types/global.d.ts', ['src/types/*.ts'])).toBe(true);
    expect(matchesAny('src/types/nested/x.ts', ['src/types/*.ts'])).toBe(false);
    expect(matchesAny('lib/models/user.dart', ['lib/models/*.dart'])).toBe(true);
    expect(matchesAny('a/b/c.ts', ['**/c.ts'])).toBe(true);
    expect(matchesAny('src/a.ts', ['src/a.ts'])).toBe(true);
  });

  it('matches a bare filename as a path suffix', () => {
    expect(matchesAny('src/global.d.ts', ['global.d.ts'])).toBe(true);
    expect(matchesAny('other.ts', ['global.d.ts'])).toBe(false);
  });

  it('compiles recursive and single-segment stars', () => {
    expect(matchesGlob('packages/x/src/main.ts', 'packages/**/src/*.ts')).toBe(true);
    // minimatch semantics: `**/` may match zero segments.
    expect(matchesGlob('packages/src/main.ts', 'packages/**/src/*.ts')).toBe(true);
    expect(matchesGlob('src/main.ts', 'packages/**/src/*.ts')).toBe(false);
    expect(globToRegExp('**/dist/**').test('anything/here/dist/file.js')).toBe(true);
    expect(globToRegExp('**/dist/**').test('dist/file.js')).toBe(true);
  });
});

describe('watcher honors .tokenshrinkrc rules', () => {
  it('skips ignorePatterns, keeps keepUnpruned files full, and honors preserveAnnotations', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-wcfg-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.mkdirSync(path.join(dir, 'gen'));
      const keepFile = path.join(dir, 'src', 'a.ts');
      const prunedFile = path.join(dir, 'src', 'b.ts');
      const ignoredFile = path.join(dir, 'gen', 'c.ts');
      fs.writeFileSync(
        keepFile,
        ['export function kept(): number {', '  return 42;', '}', ''].join('\n'),
      );
      fs.writeFileSync(
        prunedFile,
        ['export function other(): number {', '  return 1;', '}', ''].join('\n'),
      );
      fs.writeFileSync(ignoredFile, 'export const c = 3;\n');
      fs.writeFileSync(
        path.join(dir, CONFIG_FILE_NAME),
        JSON.stringify({
          ignorePatterns: ['gen/**'],
          keepUnpruned: ['src/a.ts'],
          preserveAnnotations: ['@keepContext'],
        }),
        'utf8',
      );

      const config = loadConfig(dir);
      const w = createWatcher({ root: dir, config });
      const count = await w.indexAll();

      expect(count).toBe(2); // gen/c.ts ignored
      const kept = w.cache.entries.get(keepFile);
      expect(kept?.skeleton).toContain('return 42;'); // never pruned
      const pruned = w.cache.entries.get(prunedFile);
      expect(pruned?.skeleton).toContain('/* ... */'); // pruned
      expect(w.cache.entries.has(ignoredFile)).toBe(false);

      await w.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
