import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyze } from '../src/parser/analyze.js';
import { assembleContext, importedNames } from '../src/server/context.js';
import { approximateTokens } from '../src/tokens.js';
import type { GraphCache } from '../src/watcher/sync.js';

async function cacheFor(files: Record<string, string[]>): Promise<GraphCache> {
  const cache: GraphCache = new Map();
  for (const [abs, imports] of Object.entries(files)) {
    const source = fs.readFileSync(abs, 'utf8');
    const { code, language } = await analyze(abs, source);
    cache.set(abs, { hash: abs, skeleton: code, language, imports, originalTokens: approximateTokens(source) });
  }
  return cache;
}

describe('importedNames', () => {
  it('collects named, default, aliased and type imports per specifier', () => {
    const names = importedNames(
      [
        "import Def, { a, b as c, type T } from './x';",
        "import type { U } from './x';",
        "import * as ns from './ns';",
        "import './side';",
        "export { r } from './re';",
        "const lazy = await import('./lazy');",
      ].join('\n'),
    );
    expect([...(names.get('./x') as Set<string>)].sort()).toEqual(['T', 'U', 'a', 'b', 'default']);
    expect(names.get('./ns')).toBe('*');
    expect(names.get('./side')).toBe('*');
    expect([...(names.get('./re') as Set<string>)]).toEqual(['r']);
    expect(names.get('./lazy')).toBe('*');
  });
});

describe('assembleContext', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-ctx-'));
  const main = path.join(dir, 'main.ts');
  const util = path.join(dir, 'util.ts');
  const other = path.join(dir, 'other.ts');
  fs.writeFileSync(
    util,
    [
      'export interface Opts { loud: boolean }',
      'export function used(o: Opts): string {',
      "  return o.loud ? 'A' : 'a';",
      '}',
      'export function unusedOne(n: number): number {',
      '  return n + 1;',
      '}',
      'export class UnusedTwo { run(): void { console.log(1); } }',
    ].join('\n'),
  );
  fs.writeFileSync(other, "export const x = 1;\nexport const y = 'y';\n");
  const body = Array.from({ length: 40 }, (_, i) => `  const v${i} = ${i} * Math.random();`).join('\n');
  fs.writeFileSync(
    main,
    [
      "import { used } from './util';",
      "import * as all from './other';",
      'export function focusHere(): string {', // line 3
      "  return used({ loud: true }) + all.x;", // line 4
      '}',
      'export function bigUnrelated(): void {',
      body,
      '}',
    ].join('\n'),
  );

  it("ringOneMode 'used' keeps only imported exports and their types", async () => {
    const cache = await cacheFor({ [main]: [util, other], [util]: [], [other]: [] });
    const full = await assembleContext([main], cache);
    const used = await assembleContext([main], cache, { ringOneMode: 'used' });

    const utilInc = used.included.find((i) => i.filePath === util)!;
    expect(utilInc.usedOnly).toBe(true);
    expect(utilInc.skeleton).toContain('export interface Opts');
    expect(utilInc.skeleton).toContain('export function used(o: Opts): string');
    expect(utilInc.skeleton).not.toContain('unusedOne');
    expect(utilInc.skeleton).not.toContain('UnusedTwo');
    expect(used.markdown).toContain('(used exports only)');
    // Namespace import: full skeleton.
    expect(used.included.find((i) => i.filePath === other)!.usedOnly).toBeUndefined();
    expect(used.tokenStats.totalTokens).toBeLessThan(full.tokenStats.totalTokens);
    expect(used.tokenStats.originalTokens).toBe(full.tokenStats.originalTokens);
  });

  it('focuses Ring 0 only when it alone exceeds maxTokens', async () => {
    const cache = await cacheFor({ [main]: [util, other], [util]: [], [other]: [] });
    const roomy = await assembleContext([main], cache, { maxTokens: 100_000, focusLines: { [main]: [4] } });
    expect(roomy.ring0Focused).toBe(false);
    expect(roomy.ring0Texts[0]).toContain('const v39');

    const tight = await assembleContext([main], cache, { maxTokens: 100, focusLines: { [main]: [4] } });
    expect(tight.ring0Focused).toBe(true);
    expect(tight.ring0Texts[0]).toContain("return used({ loud: true }) + all.x;");
    expect(tight.ring0Texts[0]).toContain('export function bigUnrelated(): void /* ... */');
    expect(tight.markdown).toContain('_Focused to fit the token budget');
    expect(tight.tokenStats.activeTokens).toBeLessThan(roomy.tokenStats.activeTokens / 3);
  });

  it('never focuses without focus lines', async () => {
    const cache = await cacheFor({ [main]: [util, other], [util]: [], [other]: [] });
    const res = await assembleContext([main], cache, { maxTokens: 100 });
    expect(res.ring0Focused).toBe(false);
  });
});
