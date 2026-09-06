import { describe, it, expect } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The dist bundle is rebuilt on `npm run build` (prepublishOnly / CI). If it is
// missing, skip the entry-point regression tests instead of failing.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distMcp = path.join(repoRoot, 'dist', 'mcp.cjs');

const distExists = fs.existsSync(distMcp);

interface McpProc {
  child: ChildProcess;
  stdout: string;
  stderr: string;
}

/** Spawn `dist/mcp.cjs` with explicit args + cwd; accumulate its output. */
function spawnMcp(args: string[], cwd: string): McpProc {
  const child = spawn(process.execPath, [distMcp, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
  });
  const proc = { child, stdout: '', stderr: '' };
  child.stdout.on('data', (d) => {
    proc.stdout += d;
  });
  child.stderr.on('data', (d) => {
    proc.stderr += d;
  });
  return proc;
}

/** Wait up to `timeoutMs` for all `needles` to appear on stdout or stderr. */
function waitForOutput(proc: McpProc, needles: string[], timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const hay = proc.stdout + proc.stderr;
      if (needles.every((n) => hay.includes(n))) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(
          new Error(
            `timed out waiting for ${JSON.stringify(needles)}. stdout=${proc.stdout} stderr=${proc.stderr}`,
          ),
        );
      }
    }, 50);
  });
}

function send(child: ChildProcess, msg: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}

function initializeMsg(id = 1): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    },
  };
}

function kill(proc: McpProc): Promise<void> {
  proc.child.kill();
  return new Promise((r) => proc.child.once('exit', r));
}

describe.skipIf(!distExists)('MCP binary entry point (dist/mcp.cjs)', () => {
  it('stays alive and answers initialize when invoked directly', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mcp-entry-'));
    const proc = spawnMcp(['--root', dir, '--no-create-rule'], repoRoot);
    try {
      send(proc.child, initializeMsg());
      await waitForOutput(proc, ['serverInfo']);

      expect(proc.stdout).toContain('"name":"token-shrink"');
      // The process must not have exited on its own (the old guard bug did).
      expect(proc.child.exitCode).toBeNull();
      expect(proc.stderr).toContain('MCP server connected');

      await kill(proc);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('auto-detects the project root from the active file when --root is omitted', async () => {
    // A real project the server has to discover on its own…
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-proj-'));
    // …launched from an empty workspace that carries no project markers.
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ws-'));

    fs.mkdirSync(path.join(proj, '.git'));
    fs.writeFileSync(path.join(proj, 'package.json'), '{}\n', 'utf8');
    fs.mkdirSync(path.join(proj, 'src'));
    fs.writeFileSync(
      path.join(proj, 'src', 'greet.ts'),
      [
        'export function greet(name: string): string {',
        "  return 'hello ' + name;",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(proj, 'src', 'index.ts'),
      [
        "import { greet } from './greet';",
        '',
        'export function main(): void {',
        "  console.log(greet('world'));",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const proc = spawnMcp(['--no-create-rule'], ws);
    try {
      send(proc.child, initializeMsg());
      await waitForOutput(proc, ['serverInfo']);

      // No root was supplied and cwd has no markers, so the server waits for a
      // tool call before choosing a root.
      expect(proc.stderr).toContain('will auto-detect the project');

      send(proc.child, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'get_compressed_code_context',
          arguments: {
            activeFilePath: path.join(proj, 'src', 'index.ts'),
          },
        },
      });
      await waitForOutput(proc, ['"id":2', 'Compressed Code Context']);

      // The root came from the active file — not from argv or cwd.
      expect(proc.stderr).toContain('Auto-detected project root');
      expect(proc.stderr).toContain(proj);
      // Ring 0 (active file) and Ring 1 (its import) were both assembled.
      expect(proc.stdout).toContain('greet');
      expect(proc.stdout).toContain('Ring 1');
      expect(proc.child.exitCode).toBeNull();

      await kill(proc);
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('expand_symbol returns the un-pruned body from a source file', async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-exp-'));
    fs.mkdirSync(path.join(proj, '.git'));
    fs.writeFileSync(path.join(proj, 'package.json'), '{}\n', 'utf8');
    fs.mkdirSync(path.join(proj, 'src'));
    fs.writeFileSync(
      path.join(proj, 'src', 'math.ts'),
      [
        'export function calculateTax(amount: number): number {',
        '  return amount * 0.2 + 0.01;',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const proc = spawnMcp(['--root', proj, '--no-create-rule'], repoRoot);
    try {
      send(proc.child, initializeMsg());
      await waitForOutput(proc, ['serverInfo']);

      send(proc.child, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'expand_symbol',
          arguments: {
            filePath: path.join(proj, 'src', 'math.ts'),
            symbolName: 'calculateTax',
          },
        },
      });
      await waitForOutput(proc, ['"id":2', 'calculateTax']);

      // The un-pruned body must come back — not a skeleton placeholder.
      expect(proc.stdout).toContain('amount * 0.2');
      expect(proc.child.exitCode).toBeNull();

      await kill(proc);
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  it('git_diff_context reports changed files, their Ring-1 deps, and importers', async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-gitctx-'));
    try {
      const g = (args: string[]) =>
        execFileSync('git', args, { cwd: proj, stdio: 'pipe' }).toString();
      g(['init', '-b', 'main']);
      g(['config', 'user.email', 't@example.com']);
      g(['config', 'user.name', 'Test']);

      fs.mkdirSync(path.join(proj, 'src'));
      const util = path.join(proj, 'src', 'util.ts');
      const app = path.join(proj, 'src', 'app.ts');
      fs.writeFileSync(util, 'export function calc(n: number): number { return n * 2; }\n');
      fs.writeFileSync(app, "import { calc } from './util';\nexport const x = calc(2);\n");
      g(['add', '-A']);
      g(['commit', '-m', 'init']);
      // Unstaged change to util.ts — the diff under test.
      fs.writeFileSync(util, 'export function calc(n: number): number { return n * 3; }\n');

      const proc = spawnMcp(['--root', proj, '--no-create-rule'], repoRoot);
      try {
        send(proc.child, initializeMsg());
        // Wait for the background index to finish so import edges are warm.
        await waitForOutput(proc, ['serverInfo', 'Indexed']);

        send(proc.child, {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'git_diff_context', arguments: { scope: 'worktree' } },
        });
        await waitForOutput(proc, ['"id":2', 'Git Impact Context']);

        expect(proc.stdout).toContain('src/util.ts'); // changed file listed
        expect(proc.stdout).toContain('return n * 3;'); // full new Ring-0 code
        expect(proc.stdout).toContain('src/app.ts'); // importer surfaced
        expect(proc.child.exitCode).toBeNull();

        await kill(proc);
      } finally {
        if (proc.child.exitCode === null) proc.child.kill();
      }
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  it('search_symbol_signatures finds repo symbols after indexing', async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sym-'));
    try {
      fs.mkdirSync(path.join(proj, '.git'));
      fs.writeFileSync(path.join(proj, 'package.json'), '{}\n', 'utf8');
      fs.mkdirSync(path.join(proj, 'src'));
      fs.writeFileSync(
        path.join(proj, 'src', 'pay.ts'),
        [
          'export function processPayment(amount: number): string {',
          '  return `$${amount}`;',
          '}',
          '',
          'export class PaymentService {',
          '  processRefund(id: string): void {}',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );

      const proc = spawnMcp(['--root', proj, '--no-create-rule'], repoRoot);
      try {
        send(proc.child, initializeMsg());
        await waitForOutput(proc, ['serverInfo', 'Indexed']);

        send(proc.child, {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'search_symbol_signatures',
            arguments: { query: 'process', maxResults: 10 },
          },
        });
        await waitForOutput(proc, ['"id":2', 'processPayment']);

        expect(proc.stdout).toContain('src/pay.ts');
        expect(proc.stdout).toContain('processRefund'); // class methods indexed too
        expect(proc.child.exitCode).toBeNull();

        await kill(proc);
      } finally {
        if (proc.child.exitCode === null) proc.child.kill();
      }
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});
