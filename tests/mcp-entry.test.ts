import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The dist bundle is rebuilt on `npm run build` (prepublishOnly / CI). If it is
// missing, skip the entry-point regression test instead of failing.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distMcp = path.join(repoRoot, 'dist', 'mcp.cjs');

const distExists = fs.existsSync(distMcp);

interface McpProc {
  child: ChildProcess;
  stdout: string;
  stderr: string;
}

/** Spawn `dist/mcp.cjs` and accumulate its stdout/stderr. */
function spawnMcp(root: string): McpProc {
  const child = spawn(process.execPath, [distMcp, '--root', root, '--no-create-rule'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: repoRoot,
  });
  const proc = { child, stdout: '', stderr: '' };
  child.stdout.on('data', (d) => { proc.stdout += d; });
  child.stderr.on('data', (d) => { proc.stderr += d; });
  return proc;
}

/** Wait up to `timeoutMs` for the initialize response to arrive on stdout. */
function waitForInitialize(proc: McpProc, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (proc.stdout.includes('"id":1') && proc.stdout.includes('serverInfo')) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for initialize response. stdout=${proc.stdout}`));
      }
    }, 50);
  });
}

describe.skipIf(!distExists)('MCP binary entry point (dist/mcp.cjs)', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mcp-entry-'));
  });

  it('stays alive and answers initialize when invoked directly', async () => {
    const proc = spawnMcp(dir);
    proc.child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        },
      }) + '\n',
    );

    await waitForInitialize(proc);

    expect(proc.stdout).toContain('"name":"token-shrink"');
    // The process must not have exited on its own (the old guard bug did).
    expect(proc.child.exitCode).toBeNull();
    expect(proc.stderr).toContain('MCP server connected');

    proc.child.kill();
    await new Promise((r) => proc.child.once('exit', r));
  });
});
