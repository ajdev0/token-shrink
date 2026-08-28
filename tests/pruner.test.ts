import { describe, it, expect } from 'vitest';

import { spliceRanges, prune } from '../src/parser/pruner.js';
import { registry, languageForFile, allExtensions } from '../src/parser/registry.js';

describe('spliceRanges (descending-range splicing)', () => {
  it('splices multiple ranges bottom-up without shifting offsets', () => {
    const src = 'abcdefghij';
    // Two non-overlapping ranges. Splicing bottom-up must keep earlier offsets valid.
    const { code } = spliceRanges(src, [
      { start: 2, end: 3, token: 'X' }, // "c"
      { start: 6, end: 8, token: 'Y' }, // "gh"
    ]);
    // "ab" + "X" + "def" + "Y" + "ij"
    expect(code).toBe('abXdefYij');
  });

  it('skips out-of-bounds ranges safely', () => {
    const { code, removed } = spliceRanges('abcd', [
      { start: 0, end: 2, token: 'Z' },
      { start: 5, end: 9, token: 'W' }, // out of bounds -> skipped
    ]);
    expect(code).toBe('Zcd');
    expect(removed).toBe(2);
  });

  it('overlapping ranges are pruned against the original source', () => {
    // Even though they overlap, descending order keeps indices valid.
    const { code } = spliceRanges('0123456789', [
      { start: 2, end: 8, token: 'A' },
      { start: 3, end: 4, token: 'B' },
    ]);
    // descending: start 3 first -> "0123B56789"? then start 2 -> "01A..."
    expect(code).toBe('01A89');
  });
});

describe('registry', () => {
  it('supports 12+ languages', () => {
    const ids = Object.keys(registry);
    expect(ids.length).toBeGreaterThanOrEqual(12);
  });

  it('maps extensions to languages', () => {
    expect(languageForFile('a.ts')?.name).toBe('TypeScript');
    expect(languageForFile('a.tsx')?.name).toContain('React');
    expect(languageForFile('a.py')?.name).toBe('Python');
    expect(languageForFile('a.go')?.name).toBe('Go');
    expect(languageForFile('a.rs')?.name).toBe('Rust');
    expect(languageForFile('a.swift')?.name).toContain('Swift');
    expect(languageForFile('a.java')?.name).toBe('Java');
    expect(languageForFile('unknown.xyz')).toBeNull();
  });

  it('covers the documented extensions', () => {
    for (const ext of ['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.dart', '.swift', '.java', '.kt', '.c', '.cpp', '.php']) {
      expect(allExtensions).toContain(ext);
    }
  });
});

describe('prune (downloads grammar on first run)', () => {
  it('keeps signatures and prunes TS function bodies', async () => {
    const source = [
      "import { foo } from './foo';",
      'export interface User {',
      '  id: number;',
      '  name: string;',
      '}',
      'export function greet(u: User) {',
      '  console.log(u.name);',
      '  return `hi ${u.name}`;',
      '}',
      'export const add = (a: number, b: number) => {',
      '  return a + b;',
      '};',
    ].join('\n');

    const res = await prune('/tmp/x.ts', source);
    expect(res.language).toBe('TypeScript');
    // Interface fully retained.
    expect(res.code).toContain('export interface User');
    expect(res.code).toContain('id: number;');
    // Function bodies replaced by the block token.
    expect(res.code).toContain('export function greet(u: User) /* ... */');
    expect(res.code).toContain('export const add = (a: number, b: number) => /* ... */');
    // Signature line intact for exported members.
    expect(res.code).toMatch(/export function greet\(u: User\)/);
    // Meaningful reduction.
    expect(res.removed).toBeGreaterThan(0);
  });

  it('reduces token count by a meaningful margin', async () => {
    const source = [
      'export function heavyWork(n: number) {',
      '  let total = 0;',
      '  for (let i = 0; i < n; i++) {',
      '    total += i * Math.sqrt(i);',
      '  }',
      '  return total;',
      '}',
      'export const secret = () => {',
      '  const k = something();',
      '  return k ** 2;',
      '};',
    ].join('\n');

    const { code } = await prune('/tmp/bench.ts', source);
    const tokenCount = (s: string) =>
      (s.match(/[A-Za-z0-9_$]+|[^A-Za-z0-9_\s$]/g) ?? []).length;
    const before = tokenCount(source);
    const after = tokenCount(code);
    expect(after).toBeLessThan(before * 0.5); // at least 50% fewer tokens
  });
});
