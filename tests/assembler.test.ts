import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assemble } from '../src/server/assembler.js';
import { extractImports, resolveImport, hashOf } from '../src/watcher/sync.js';

describe('extractImports (regex-based)', () => {
  it('extracts ESM + CJS + dynamic specifiers', () => {
    const src = [
      "import foo from './a';",
      "import { bar } from '../b/c.js';",
      "import './side-effect';",
      "const d = require('pkg/mod')",
    ].join('\n');
    const out = extractImports('x.ts', src);
    expect(out).toEqual(['./a', '../b/c.js', './side-effect', 'pkg/mod']);
  });
});

describe('resolveImport', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'util.ts'), 'x');
  });

  it('resolves a relative specifier with extension machinery', () => {
    const importer = path.join(dir, 'src', 'main.ts');
    const resolved = resolveImport(importer, './util', dir);
    expect(resolved).toBe(path.join(dir, 'src', 'util.ts'));
  });

  it('returns null for bare/package specifiers', () => {
    expect(resolveImport(path.join(dir, 'src', 'main.ts'), 'fastify', dir)).toBeNull();
    expect(resolveImport(path.join(dir, 'src', 'main.ts'), '@scope/pkg', dir)).toBeNull();
  });
});

describe('hashOf', () => {
  it('is deterministic and content-addressed', () => {
    expect(hashOf('abc')).toBe(hashOf('abc'));
    expect(hashOf('abc')).not.toBe(hashOf('abd'));
  });
});

describe('assemble', () => {
  let dir: string;
  let util: string;
  let main: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-asm-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    util = path.join(dir, 'src', 'util.ts');
    main = path.join(dir, 'src', 'main.ts');
    fs.writeFileSync(util, 'export const x = 1;');
    fs.writeFileSync(main, "import './util'; export const y = 2;");
  });

  it('builds a markdown payload with the active file as Ring 0', () => {
    const cache = new Map();
    cache.set(main, { hash: 'h1', skeleton: 'SKEL_MAIN', language: 'TypeScript', imports: [util] });
    cache.set(util, { hash: 'h2', skeleton: 'SKEL_UTIL', language: 'TypeScript', imports: [] });

    const res = assemble(main, cache);
    // Ring 0 is the raw active source.
    expect(res.activeSource).toContain("import './util'");
    expect(res.markdown).toContain('# Compressed Code Context');
    // Ring 1 includes the util skeleton.
    expect(res.markdown).toContain('SKEL_UTIL');
    expect(res.included.map((i) => i.filePath)).toContain(util);
  });

  it('reports unresolved imports when the target is not cached', () => {
    const cache = new Map();
    cache.set(main, { hash: 'h1', skeleton: 'S', language: 'TypeScript', imports: ['/does/not/exist.ts'] });
    const res = assemble(main, cache);
    expect(res.unresolved).toContain('/does/not/exist.ts');
    expect(res.included).toHaveLength(0);
  });
});
