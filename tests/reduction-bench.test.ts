import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import Parser from 'web-tree-sitter';

import { prune, loadLanguage } from '../src/parser/pruner.js';
import { languageForFile } from '../src/parser/registry.js';
import { approximateTokens } from '../src/tokens.js';

/** Overall Ring-1 reduction on this repo's own sources; guards regressions. */
// 58.6% before the arrow/literal/comment/whitespace passes, 69.2% after.
const BASELINE_PCT = Number(process.env.REDUCTION_BASELINE ?? 65);

/** Count tree-sitter ERROR / MISSING nodes in a parse of `code`. */
async function errorCount(file: string, code: string): Promise<number> {
  const parser = new Parser();
  parser.setLanguage(await loadLanguage(languageForFile(file)!));
  const tree = parser.parse(code);
  let n = 0;
  const walk = (node: Parser.SyntaxNode) => {
    if (node.type === 'ERROR' || node.isMissing) n++;
    for (const child of node.children) walk(child);
  };
  walk(tree.rootNode);
  tree.delete();
  parser.delete();
  return n;
}

function listTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? listTs(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('reduction benchmark (src/)', () => {
  it('prunes the repo sources by at least the baseline', async () => {
    let before = 0;
    let after = 0;
    for (const file of listTs(path.resolve(__dirname, '../src'))) {
      const source = fs.readFileSync(file, 'utf8');
      const { code } = await prune(file, source);
      // Pruning must never introduce syntax errors.
      expect(await errorCount(file, code), file).toBe(await errorCount(file, source));
      before += approximateTokens(source);
      after += approximateTokens(code);
    }
    const pct = Math.round(((before - after) / before) * 1000) / 10;
    console.log(`[bench] src/: ${before} → ${after} tokens (${pct}% saved)`);
    expect(pct).toBeGreaterThanOrEqual(BASELINE_PCT);
  });
});
