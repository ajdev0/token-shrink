import { describe, it, expect } from 'vitest';

import { analyze } from '../src/parser/analyze.js';

describe('focusLines (Ring-0 slimming)', () => {
  const source = [
    'export function a(x: number): number {', // 1
    '  if (x) { return 1; }', // 2
    '  return 2;', // 3
    '}', // 4
    'export class K {', // 5
    '  m(): void {', // 6
    '    console.log(1);', // 7
    '  }', // 8
    '  n(): void {', // 9
    '    console.log(2);', // 10
    '  }', // 11
    '}', // 12
  ].join('\n');

  it('keeps the innermost definition around the focus line, prunes the rest', async () => {
    const { code } = await analyze('/tmp/f.ts', source, { focusLines: [7] });
    expect(code).toContain('export function a(x: number): number /* ... */');
    expect(code).toContain('  m(): void {\n    console.log(1);\n  }');
    expect(code).toContain('  n(): void /* ... */');
  });

  it('keeps nested blocks inside the focused function intact', async () => {
    const { code } = await analyze('/tmp/f.ts', source, { focusLines: [3] });
    expect(code).toContain('  if (x) { return 1; }\n  return 2;');
    expect(code).toContain('  m(): void /* ... */');
  });

  it('ignores focus lines past the end of the file', async () => {
    const { code } = await analyze('/tmp/f.ts', source, { focusLines: [999] });
    expect(code).toContain('export function a(x: number): number /* ... */');
  });
});

describe('keepOnly (used-exports Ring 1)', () => {
  const source = [
    "import { helper } from './helper';",
    "import type { Big } from './big';",
    'export interface User { id: Id; name: string }',
    'type Id = string;',
    '/** Unused thing. */',
    'export function unused(b: Big): void {',
    '  helper(b);',
    '}',
    'export function greet(u: User): string {',
    '  return helper(u.name);',
    '}',
    'export function greet(u: User, loud: boolean): string;',
    'export default class Store {}',
    'const internal = 1;',
    'export { internal as exposed };',
    "export * from './more';",
  ].join('\n');

  it('keeps the used exports, the types their signatures reference, and barrel lines', async () => {
    const { code } = await analyze('/tmp/m.ts', source, { keepOnly: ['greet'] });
    expect(code).toBe(
      [
        'export interface User { id: Id; name: string }',
        'type Id = string;',
        'export function greet(u: User): string /* ... */',
        'export function greet(u: User, loud: boolean): string;',
        "export * from './more';",
      ].join('\n'),
    );
  });

  it('follows default and aliased exports to their locals and imports', async () => {
    const { code } = await analyze('/tmp/m.ts', source, { keepOnly: ['default', 'exposed', 'unused'] });
    expect(code).toContain("import type { Big } from './big';");
    expect(code).toContain('export function unused(b: Big): void /* ... */');
    expect(code).toContain('export default class Store {}');
    expect(code).toContain('const internal = 1;');
    expect(code).toContain('export { internal as exposed };');
    expect(code).not.toContain('greet');
    // `helper` is only used inside pruned bodies, so its import goes too.
    expect(code).not.toContain('helper');
  });

  it('leaves CommonJS and unmatched files untouched', async () => {
    const cjs = 'const a = () => 1;\nmodule.exports = { a };\n';
    expect((await analyze('/tmp/c.ts', cjs, { keepOnly: ['a'] })).code).toBe(cjs);
    const res = await analyze('/tmp/m.ts', source, { keepOnly: ['notHere'] });
    expect(res.code).toContain('export function unused');
  });
});
