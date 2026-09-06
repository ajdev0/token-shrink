import { describe, it, expect } from 'vitest';

import { analyze } from '../src/parser/analyze.js';
import { matchSymbols } from '../src/parser/symbols.js';

const SOURCE = [
  "import { x } from './x';",
  '',
  'export interface User {',
  '  id: number;',
  '  name: string;',
  '}',
  '',
  'export function greet(u: User): string {',
  "  return 'hi ' + u.name;",
  '}',
  '',
  'export class Foo {',
  '  greet(): void {',
  '    console.log("hi");',
  '  }',
  '  private helper(n: number): number {',
  '    return n * 2;',
  '  }',
  '}',
  '',
  'export const add = (a: number, b: number): number => {',
  '  return a + b;',
  '};',
  '',
  'const plain = function () {',
  '  return 1;',
  '};',
  '',
  'export enum Color {',
  '  Red,',
  '  Green,',
  '}',
  '',
].join('\n');

describe('symbol extraction (TypeScript, cached grammar)', () => {
  it('collects named definitions with kinds', async () => {
    const { symbols } = await analyze('/tmp/probe.ts', SOURCE, { skipPrune: true });
    const names = symbols.map((s) => s.name).sort();
    expect(names).toEqual(['Color', 'Foo', 'User', 'add', 'greet', 'greet', 'helper', 'plain'].sort());
    expect(symbols.find((s) => s.name === 'User')?.kind).toBe('interface');
    expect(symbols.find((s) => s.name === 'Foo')?.kind).toBe('class');
    expect(symbols.find((s) => s.name === 'Color')?.kind).toBe('enum');
    expect(symbols.filter((s) => s.name === 'greet')).toHaveLength(2);
    expect(symbols.find((s) => s.name === 'add')?.kind).toBe('arrow');
    expect(symbols.find((s) => s.name === 'plain')?.kind).toBe('arrow');
  });

  it('returns the full un-pruned body for a symbol', async () => {
    const { symbols } = await analyze('/tmp/probe.ts', SOURCE, { skipPrune: true });
    const matches = matchSymbols(symbols, 'helper');
    expect(matches).toHaveLength(1);
    const body = SOURCE.slice(matches[0].start, matches[0].end);
    expect(body).toContain('private helper(n: number): number');
    expect(body).toContain('return n * 2;');
  });

  it('matches overloads / same-named members and exposes line numbers', async () => {
    const { symbols } = await analyze('/tmp/probe.ts', SOURCE, { skipPrune: true });
    const matches = matchSymbols(symbols, 'greet');
    expect(matches.length).toBeGreaterThan(1);
    expect(matches.every((m) => m.line > 0)).toBe(true);
  });

  it('finds nothing for unknown names', async () => {
    const { symbols } = await analyze('/tmp/probe.ts', SOURCE, { skipPrune: true });
    expect(matchSymbols(symbols, 'doesNotExist')).toHaveLength(0);
  });
});

describe('analyze (single parse: skeleton + symbols)', () => {
  it('prunes skeletons exactly like the historical prune()', async () => {
    const { code, language, removed } = await analyze('/tmp/probe.ts', SOURCE);
    expect(language).toBe('TypeScript');
    expect(code).toContain('export function greet(u: User): string /* ... */');
    expect(removed).toBeGreaterThan(0);
  });

  it('yields symbols and a pruned skeleton from the same parse', async () => {
    const res = await analyze('/tmp/probe.ts', SOURCE);
    expect(res.symbols.length).toBeGreaterThan(0);
    expect(res.code).toContain('/* ... */');
  });
});

describe('analyze preserveAnnotations (config rule)', () => {
  it('keeps an annotated function fully un-pruned while pruning the rest', async () => {
    const src = [
      '/** @keepContext */',
      'export function apiRoute(): number {',
      '  return expensiveInternal();',
      '}',
      '',
      'export function normal(): number {',
      '  return 2;',
      '}',
      '',
    ].join('\n');

    const { code } = await analyze('/tmp/anno.ts', src, {
      preserveAnnotations: ['keepContext'],
    });
    expect(code).toContain('return expensiveInternal();'); // kept
    expect(code).toContain('export function normal(): number /* ... */'); // pruned
  });

  it('prunes everything when no annotation matches', async () => {
    const src = [
      'export function plain(): number {',
      '  return 1;',
      '}',
      '',
    ].join('\n');
    const { code } = await analyze('/tmp/plain.ts', src, {
      preserveAnnotations: ['keepContext'],
    });
    expect(code).toContain('export function plain(): number /* ... */');
  });
});
