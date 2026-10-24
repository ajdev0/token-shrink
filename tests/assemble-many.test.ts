import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assembleMany, approximateTokens } from '../src/server/assembler.js';
import type { GraphCache } from '../src/watcher/sync.js';

function entry(skeleton: string, imports: string[] = []) {
  return { hash: `h-${skeleton.length}`, skeleton, language: 'TypeScript', imports };
}

describe('assembleMany (multi-file Ring 0 + token budgets)', () => {
  let dir: string;
  let a: string;
  let b: string;
  let c: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-many-'));
    a = path.join(dir, 'src', 'a.ts');
    b = path.join(dir, 'src', 'b.ts');
    c = path.join(dir, 'src', 'c.ts');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(a, "import { b } from './b';\nexport const a = b();\n");
    fs.writeFileSync(b, "import { c } from './c';\nexport const b = () => 1;\n");
    fs.writeFileSync(c, 'export const c = 42;\n');
  });

  it('keeps every Ring-0 file full and excludes Ring-0 files from Ring 1', () => {
    const cache: GraphCache = new Map([
      [a, entry('SKEL_A', [b])],
      [b, entry('SKEL_B', [c])],
      [c, entry('SKEL_C')],
    ]);

    const res = assembleMany([a, b], cache);

    // Both Ring-0 files are present verbatim.
    expect(res.activeFilePaths).toEqual([a, b]);
    expect(res.markdown).toContain("export const a = b();");
    expect(res.markdown).toContain("export const b = () => 1;");
    // b is Ring 0, so c (b's import) is the only Ring-1 member.
    const ring1 = res.included.map((i) => i.filePath);
    expect(ring1).toContain(c);
    expect(ring1).not.toContain(a);
    expect(ring1).not.toContain(b);
    expect(res.markdown).toContain('SKEL_C');
  });

  it('combines imports across multiple Ring-0 files and dedupes', () => {
    const shared = path.join(dir, 'src', 'shared.ts');
    const d = path.join(dir, 'src', 'd.ts');
    fs.writeFileSync(shared, 'export const shared = 1;\n');
    fs.writeFileSync(d, 'export const d = 2;\n');
    const cache: GraphCache = new Map([
      [a, entry('SKEL_A', [shared])],
      [d, entry('SKEL_D', [shared])],
      [shared, entry('SKEL_SHARED')],
    ]);

    const res = assembleMany([a, d], cache);

    expect(res.included).toHaveLength(1);
    expect(res.included[0].filePath).toBe(shared);
  });

  it('enforces maxTokens by trimming lower-priority dependencies', () => {
    const big = path.join(dir, 'src', 'big.ts');
    const small = path.join(dir, 'src', 'small.ts');
    fs.writeFileSync(big, 'export const big = 1;'.repeat(400)); // ~large
    fs.writeFileSync(small, 'export const small = 1;\n');

    const bigSkeleton = 'export const big = 1;'.repeat(400);
    const smallSkeleton = 'export const small = 1;';
    const cache: GraphCache = new Map([
      [a, entry('SKEL_A', [big, small])],
      [big, entry(bigSkeleton)],
      [small, entry(smallSkeleton)],
    ]);

    // Budget: exactly what the payload with only `small` costs, plus room
    // for the "excluded 1 dependency" note — so big cannot fit.
    const withSmall = assembleMany([a], new Map([...cache].filter(([p]) => p !== big)));
    const maxTokens = approximateTokens(withSmall.markdown) + 20;
    const res = assembleMany([a], cache, { maxTokens });

    expect(res.included.map((i) => i.filePath)).toEqual([small]);
    expect(res.tokenStats.budget).toBe(maxTokens);
    expect(res.tokenStats.trimmed).toBe(1);
    expect(res.markdown).toContain('token budget');
  });

  it('leaves declaration order unchanged when no budget is given', () => {
    const x = path.join(dir, 'src', 'x.ts');
    const y = path.join(dir, 'src', 'y.ts');
    const cache: GraphCache = new Map([
      [a, entry('SKEL_A', [y, x])], // y declared before x
      [x, entry('SKEL_X')],
      [y, entry('SKEL_Y')],
    ]);

    const res = assembleMany([a], cache);
    expect(res.included.map((i) => i.filePath)).toEqual([y, x]);
  });
});

describe('maxTokens is a whole-payload budget', () => {
  it('keeps the emitted markdown within maxTokens when Ring 0 fits', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-budget-'));
    const main = path.join(dir, 'main.ts');
    const deps = Array.from({ length: 12 }, (_, i) => path.join(dir, `d${i}.ts`));
    fs.writeFileSync(main, deps.map((_, i) => `import { d${i} } from './d${i}';`).join('\n'));
    const cache: GraphCache = new Map([
      [main, entry('SKEL_MAIN', deps)],
      ...deps.map((d, i) => [d, entry(`export declare function d${i}(a: number, b: string): Promise<void>;`)] as const),
    ]);
    // maxTokens 0: Ring 0 alone (always kept) plus the trimmed note.
    const floor = approximateTokens(assembleMany([main], cache, { maxTokens: 0 }).markdown);
    for (const maxTokens of [floor + 40, floor + 100, floor + 250]) {
      const res = assembleMany([main], cache, { maxTokens });
      expect(approximateTokens(res.markdown)).toBeLessThanOrEqual(maxTokens);
      expect(res.tokenStats.trimmed).toBeGreaterThan(0);
    }
  });
});

describe('Ring 0 over budget', () => {
  it('keeps Ring 0 and says it exceeds the budget', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-over-'));
    const main = path.join(dir, 'main.ts');
    fs.writeFileSync(main, 'export const big = 1;\n'.repeat(50));
    const res = assembleMany([main], new Map(), { maxTokens: 10 });
    expect(res.ring0Texts[0]).toContain('export const big = 1;');
    expect(res.markdown).toContain('alone exceed the token budget of 10');
    const fits = assembleMany([main], new Map(), { maxTokens: 100_000 });
    expect(fits.markdown).not.toContain('alone exceed');
  });
});
