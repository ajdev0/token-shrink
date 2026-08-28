/**
 * HTTP/CLI server. Exposes the context assembler as a small Fastify service:
 *
 *   GET  /health      -> liveness
 *   POST /v1/context  -> { activeFilePath, maxSkeletons?, includeStats? } => markdown
 *
 * Run as `token-shrink` or `node dist/cli.js`. The server watches `--root`
 * (defaults to cwd) and keeps the import graph + skeletons warm.
 */

import Fastify from 'fastify';
import picocolors from 'picocolors';
import fs from 'node:fs';
import path from 'node:path';

import { assemble } from './server/assembler.js';
import { createWatcher, type Matcher } from './watcher/sync.js';
import { warmGrammars } from './parser/wasm.js';

export interface CliOptions {
  port?: number;
  host?: string;
  root?: string;
  ignored?: Matcher[];
  silent?: boolean;
}

function parseArgv(argv = process.argv): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (cur?.startsWith('--')) {
      const key = cur.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

/** Start the Fastify server; returns the running instance + watcher handle. */
export async function startServer(opts: CliOptions = {}) {
  const args = parseArgv();
  const port = opts.port ?? Number(args.port ?? process.env.PORT ?? 3000);
  const host = opts.host ?? args.host ?? '0.0.0.0';
  const root = path.resolve(opts.root ?? args.root ?? process.cwd());
  const silent = opts.silent ?? args.silent === 'true';

  const log = (msg: string) => {
    if (!silent) console.log(picocolors.dim(msg));
  };

  // Warm grammars in the background so the first prune isn't slow.
  void warmGrammars().catch(() => {});

  const watcher = createWatcher({ root, ignored: opts.ignored });
  log(`Indexing ${root} in the background…`);
  void watcher.indexAll().then((n) => log(`Indexed ${n} files.`));

  const app = Fastify({ logger: !silent });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'token-shrink',
    version: '2.0.0',
    root,
    indexed: watcher.cache.entries.size,
  }));

  app.post('/v1/context', async (req, reply) => {
    const body = (req.body ?? {}) as {
      activeFilePath?: string;
      maxSkeletons?: number;
      includeStats?: boolean;
    };
    if (!body.activeFilePath) {
      return reply.status(400).send({ error: '`activeFilePath` is required' });
    }
    const result = assemble(body.activeFilePath, watcher.cache.entries, {
      maxSkeletons: body.maxSkeletons,
      includeStats: body.includeStats,
    });
    return {
      markdown: result.markdown,
      activeFilePath: result.activeFilePath,
      dependencies: result.included.map((i) => i.filePath),
      unresolved: result.unresolved,
    };
  });

  app.setNotFoundHandler(async (req, reply) => {
    void req;
    return reply.status(404).send({ error: 'Not found' });
  });

  await app.listen({ port, host });
  log(`Listening on http://${host}:${port}`);

  return { app, watcher };
}

// Start when invoked directly (`node dist/cli.cjs` / the `token-shrink` bin),
// not when imported as a library. `realpathSync` resolves the npm bin symlink,
// so `token-shrink` -> `dist/cli.cjs` is detected as `cli.cjs`.
const argv1 = process.argv[1] ? path.basename(process.argv[1]) : '';
let argv1Real = '';
try {
  argv1Real = process.argv[1]
    ? path.basename(fs.realpathSync(process.argv[1]))
    : '';
} catch {
  /* path may not exist yet (tsx/dev runners) — fall back to argv basename */
}
if (
  argv1 === 'cli.js' || argv1 === 'cli.mjs' ||
  argv1 === 'cli.cjs' || argv1 === 'cli.ts' ||
  argv1Real === 'cli.js' || argv1Real === 'cli.mjs' ||
  argv1Real === 'cli.cjs' || argv1Real === 'cli.ts'
) {
  startServer().catch((err) => {
    console.error(picocolors.red(`[token-shrink] ${err.message}`));
    process.exitCode = 1;
  });
}
