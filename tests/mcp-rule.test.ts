import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createAutoRule,
  createCursorRule,
  RULE_TARGET_PATH,
  CLAUDE_RULE_SENTINEL,
  CLINE_RULE_SENTINEL,
  AUTO_RULE_SENTINEL,
  CURSOR_RULE_PATH,
  CLAUDE_RULE_PATH,
  CLINE_RULE_PATH,
} from '../src/mcp.js';

const targets = ['cursor', 'claude', 'cline'] as const;

function sentinelFor(target: (typeof targets)[number]): string {
  if (target === 'cursor') return AUTO_RULE_SENTINEL;
  if (target === 'claude') return CLAUDE_RULE_SENTINEL;
  return CLINE_RULE_SENTINEL;
}

describe('createAutoRule (idempotent per target)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rule-'));
  });

  it.each(targets)('creates a tagged rule file when absent for %s', (target) => {
    const res = createAutoRule(dir, target);
    expect(res.created).toBe(true);
    expect(res.skipped).toBe('none');

    const rel = RULE_TARGET_PATH[target];
    const rulePath = path.join(dir, rel);
    expect(res.filePath).toBe(rulePath);
    expect(fs.existsSync(rulePath)).toBe(true);
    const content = fs.readFileSync(rulePath, 'utf8');
    const sentinel = sentinelFor(target);
    expect(content).toContain(sentinel);
    expect(content).toContain('get_compressed_code_context');
  });

  it.each(targets)('does not rewrite when %s rule already has our sentinel', (target) => {
    const rulePath = path.join(dir, RULE_TARGET_PATH[target]);
    const sentinel = sentinelFor(target);
    fs.mkdirSync(path.dirname(rulePath), { recursive: true });
    fs.writeFileSync(rulePath, `custom\n${sentinel}\n`, 'utf8');

    const res = createAutoRule(dir, target);
    expect(res.created).toBe(false);
    expect(res.skipped).toBe('exists');
    expect(fs.readFileSync(rulePath, 'utf8')).toBe(`custom\n${sentinel}\n`);
  });

  it.each(targets)("leaves a user-authored %s rule untouched without sentinel", (target) => {
    const rulePath = path.join(dir, RULE_TARGET_PATH[target]);
    fs.mkdirSync(path.dirname(rulePath), { recursive: true });
    fs.writeFileSync(rulePath, 'my own rule\n', 'utf8');

    const res = createAutoRule(dir, target);
    expect(res.created).toBe(false);
    expect(res.skipped).toBe('user');
    expect(fs.readFileSync(rulePath, 'utf8')).toBe('my own rule\n');
  });
});

describe('back-compat createCursorRule', () => {
  it('writes to the cursor path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rule-'));
    const res = createCursorRule(dir);
    expect(res.created).toBe(true);
    expect(res.filePath).toBe(path.join(dir, CURSOR_RULE_PATH));
  });
});

describe('rule path constants', () => {
  it('points at the expected integration files', () => {
    expect(CURSOR_RULE_PATH).toBe('.cursor/rules/token-shrink.mdc');
    expect(CLAUDE_RULE_PATH).toBe('.claude/rules/token-shrink.md');
    expect(CLINE_RULE_PATH).toBe('.clinerules/token-shrink.md');
  });
});
