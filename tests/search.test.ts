import { describe, it, expect } from 'vitest';

import { SymbolSearch } from '../src/search/index.js';
import type { SymbolInfo } from '../src/parser/symbols.js';
import type { CacheEntry } from '../src/watcher/sync.js';

function sym(
  name: string,
  kind: SymbolInfo['kind'],
  line: number,
  signature: string,
): SymbolInfo {
  return { name, kind, line, start: 0, end: signature.length, signature };
}

function entry(symbols: SymbolInfo[]): CacheEntry {
  return { hash: 'h', skeleton: '', language: 'TypeScript', imports: [], symbols };
}

const cache = new Map<string, CacheEntry>([
  [
    '/repo/src/payments.ts',
    entry([
      sym('processPayment', 'function', 3, 'export function processPayment(amount: number): string'),
      sym('processRefund', 'function', 9, 'export function processRefund(id: string): void'),
      sym('PaymentService', 'class', 1, 'export class PaymentService {'),
    ]),
  ],
  [
    '/repo/src/users.ts',
    entry([
      sym('getUser', 'function', 2, 'export function getUser(id: string): User'),
      sym('User', 'interface', 1, 'export interface User {'),
    ]),
  ],
]);

describe('SymbolSearch', () => {
  it('loads cache entries and indexes symbols', () => {
    const idx = new SymbolSearch();
    idx.loadCache(cache);
    expect(idx.size).toBe(5);
  });

  it('ranks exact > prefix > substring matches', () => {
    const idx = new SymbolSearch();
    idx.loadCache(cache);

    const exact = idx.search('User', { maxResults: 1 });
    expect(exact[0].name).toBe('User'); // interface wins over nothing else named User
    expect(exact[0].label).toContain('/repo/src/users.ts:1');

    const prefix = idx.search('process', { maxResults: 10 });
    expect(prefix.map((h) => h.name).sort()).toEqual(['processPayment', 'processRefund']);
  });

  it('supports kind filters and camelCase queries', () => {
    const idx = new SymbolSearch();
    idx.loadCache(cache);
    const onlyFunctions = idx.search('process', { kind: 'function' });
    expect(onlyFunctions.every((h) => h.kind === 'function')).toBe(true);

    // camelCase tokenization: "payment service" still finds PaymentService.
    const camel = idx.search('payment', { maxResults: 10 });
    expect(camel.some((h) => h.name === 'PaymentService')).toBe(true);
  });

  it('removes files when told to', () => {
    const idx = new SymbolSearch();
    idx.loadCache(cache);
    idx.removeFile('/repo/src/payments.ts');
    expect(idx.size).toBe(2);
    expect(idx.search('process')).toHaveLength(0);
    // Signature hits (`getUser(id): User`) rank below the exact `User` symbol.
    const userHits = idx.search('User');
    expect(userHits[0].name).toBe('User');
  });

  it('answers quickly at modest scale', () => {
    const big = new Map<string, CacheEntry>();
    const symbols: SymbolInfo[] = [];
    for (let i = 0; i < 2000; i++) {
      symbols.push(
        sym(`handlerItem${i}`, 'function', i + 1, `export function handlerItem${i}(x: number) {}`),
      );
    }
    big.set('/repo/src/big.ts', entry(symbols));
    const idx = new SymbolSearch();
    idx.loadCache(big);

    const started = performance.now();
    const hits = idx.search('handlerItem1999');
    const elapsed = performance.now() - started;

    expect(hits).toHaveLength(1);
    expect(elapsed).toBeLessThan(50);
  });
});
