import { describe, it, expect } from 'vitest';

import { Query } from 'web-tree-sitter';

import { loadLanguage, prune } from '../src/parser/pruner.js';
import { registry } from '../src/parser/registry.js';

/** A function with a prunable body, per language id. */
const SAMPLES: Record<string, { file: string; source: string; keep: string }> = {
  typescript: { file: 'a.ts', source: 'export function f(a: number): number {\n  return a + 1;\n}\n', keep: 'export function f(a: number): number' },
  javascript: { file: 'a.js', source: 'export function f(a) {\n  return a + 1;\n}\n', keep: 'export function f(a)' },
  tsx: { file: 'a.tsx', source: 'export function C(): JSX.Element {\n  return <div />;\n}\n', keep: 'export function C(): JSX.Element' },
  jsx: { file: 'a.jsx', source: 'export function C() {\n  return <div />;\n}\n', keep: 'export function C()' },
  python: { file: 'a.py', source: 'def f(a: int) -> int:\n    x = a + 1\n    return x\n', keep: 'def f(a: int) -> int:' },
  dart: { file: 'a.dart', source: 'int f(int a) {\n  return a + 1;\n}\n', keep: 'int f(int a)' },
  swift: { file: 'a.swift', source: 'func f(a: Int) -> Int {\n  let x = a + 1\n  return x\n}\n', keep: 'func f(a: Int) -> Int' },
  go: { file: 'a.go', source: 'package a\n\nfunc F(a int) int {\n\treturn a + 1\n}\n', keep: 'func F(a int) int' },
  rust: { file: 'a.rs', source: 'pub fn f(a: i32) -> i32 {\n    a + 1\n}\n', keep: 'pub fn f(a: i32) -> i32' },
  java: { file: 'A.java', source: 'class A {\n  int f(int a) {\n    return a + 1;\n  }\n}\n', keep: 'int f(int a)' },
  kotlin: { file: 'a.kt', source: 'fun f(a: Int): Int {\n    return a + 1\n}\n', keep: 'fun f(a: Int): Int' },
  c: { file: 'a.c', source: 'int f(int a) {\n  return a + 1;\n}\n', keep: 'int f(int a)' },
  cpp: { file: 'a.cpp', source: 'int f(int a) {\n  return a + 1;\n}\n', keep: 'int f(int a)' },
  php: { file: 'a.php', source: '<?php\nfunction f($a) {\n  return $a + 1;\n}\n', keep: 'function f($a)' },
};

describe('JavaScript grammar', () => {
  it('loads with the bundled runtime and prunes', async () => {
    const res = await prune('/tmp/js.js', 'export function f(a) {\n  return a + 1;\n}\n');
    expect(res.language).toBe('JavaScript');
    expect(res.code).toBe('export function f(a) /* ... */\n');
  });
});

describe.runIf(process.env.NETWORK)('pinned grammars (NETWORK=1)', () => {
  for (const [id, spec] of Object.entries(registry)) {
    const sample = SAMPLES[id];
    it(`${spec.name}: loads, compiles every rule, prunes`, async () => {
      expect(sample, `no sample for ${id}`).toBeDefined();
      const language = await loadLanguage(spec);
      for (const rule of spec.rules) expect(() => new Query(language, rule.query).delete()).not.toThrow();
      const res = await prune(`/tmp/${sample.file}`, sample.source);
      expect(res.language).toBe(spec.name);
      expect(res.removed).toBeGreaterThan(0);
      expect(res.code).toContain(sample.keep);
    });
  }
});
