import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assembleMany } from '../src/server/assembler.js';
import {
  approximateTokens,
  formatSavings,
  readStats,
  recordSavings,
  savingsOf,
} from '../src/tokens.js';
import { printStats } from '../src/cli.js';
import type { GraphCache } from '../src/watcher/sync.js';

describe('token savings accounting', () => {
  it('reports original vs emitted tokens for Ring 1', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-save-'));
    const a = path.join(dir, 'a.ts');
    const b = path.join(dir, 'b.ts');
    fs.writeFileSync(a, "import { b } from './b';\nexport const a = b();\n");
    const fullB = 'export function b() {\n  const x = [1, 2, 3].map((n) => n * 2);\n  return x.length;\n}\n';
    const skelB = 'export function b() /* ... */\n';
    const cache: GraphCache = new Map([
      [a, { hash: 'a', skeleton: '', language: 'TypeScript', imports: [b] }],
      [b, { hash: 'b', skeleton: skelB, language: 'TypeScript', imports: [], originalTokens: approximateTokens(fullB) }],
    ]);

    const { tokenStats: ts } = assembleMany([a], cache, { includeStats: true });
    const active = approximateTokens(fs.readFileSync(a, 'utf8'));
    expect(ts.totalTokens).toBe(active + approximateTokens(skelB));
    expect(ts.originalTokens).toBe(active + approximateTokens(fullB));
    expect(ts.savedTokens).toBe(approximateTokens(fullB) - approximateTokens(skelB));
    expect(ts.reductionPct).toBeGreaterThan(0);
    expect(ts.reductionPct).toBeLessThan(100);
  });

  it('falls back to the skeleton size when originalTokens is unknown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-save-'));
    const a = path.join(dir, 'a.ts');
    fs.writeFileSync(a, 'export const a = 1;\n');
    const { tokenStats: ts } = assembleMany([a], new Map());
    expect(ts.savedTokens).toBe(0);
    expect(ts.reductionPct).toBe(0);
  });

  it('formats the savings line, yellow only on request', () => {
    const s = { originalTokens: 12480, totalTokens: 1936 };
    expect(savingsOf(s)).toEqual({ savedTokens: 10544, reductionPct: 84.5 });
    const plain = formatSavings(s);
    expect(plain).toBe('⚡ token-shrink: 12,480 → 1,936 tokens (−10,544 · 84.5% saved)');
    expect(plain).not.toContain('\x1b[');
  });

  it('accumulates session and all-time totals in stats.json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-stats-'));
    recordSavings(root, 'tool', { originalTokens: 100, totalTokens: 20 }, 's1');
    recordSavings(root, 'tool', { originalTokens: 50, totalTokens: 10 }, 's1');
    recordSavings(root, 'tool', { originalTokens: 10, totalTokens: 5 }, 's2');
    const stats = readStats(root)!;
    expect(stats.last).toMatchObject({ originalTokens: 10, totalTokens: 5, tool: 'tool' });
    expect(stats.session).toMatchObject({ originalTokens: 10, totalTokens: 5, calls: 1, startedAt: 's2' });
    expect(stats.allTime).toMatchObject({ originalTokens: 160, totalTokens: 35, calls: 3 });

    const lines: string[] = [];
    expect(printStats(root, (l) => lines.push(l))).toBe(true);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('160 → 35 tokens');
  });
});
