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

import { assembleMany } from './server/assembler.js';
import { createWatcher, type Matcher } from './watcher/sync.js';
import { warmGrammars } from './parser/wasm.js';
import {
  formatSavings,
  readStats,
  recordSavings,
  statsPathFor,
  VERSION,
  wantsColor,
} from './tokens.js';

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
  // Optional server-wide token budget: --max-tokens 4000.
  const maxTokensDefault = args['max-tokens']
    ? Number(args['max-tokens'])
    : undefined;

  const log = (msg: string) => {
    if (!silent) console.log(picocolors.dim(msg));
  };
  const sessionStartedAt = new Date().toISOString();

  // Warm grammars in the background so the first prune isn't slow.
  void warmGrammars().catch(() => {});

  const watcher = createWatcher({ root, ignored: opts.ignored });
  log(`Indexing ${root} in the background…`);
  void watcher.indexAll().then((n) => log(`Indexed ${n} files.`));

  const app = Fastify({ logger: !silent });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'token-shrink',
    version: VERSION,
    root,
    indexed: watcher.cache.entries.size,
  }));

  app.post('/v1/context', async (req, reply) => {
    const body = (req.body ?? {}) as {
      activeFilePath?: string;
      activeFiles?: string[];
      maxSkeletons?: number;
      maxTokens?: number;
      includeStats?: boolean;
    };
    const hasMany = Array.isArray(body.activeFiles) && body.activeFiles.length > 0;
    if (hasMany && body.activeFilePath) {
      return reply
        .status(400)
        .send({ error: 'Pass either `activeFilePath` or `activeFiles`, not both.' });
    }
    const paths = hasMany
      ? (body.activeFiles as string[])
      : body.activeFilePath
        ? [body.activeFilePath]
        : [];
    if (paths.length === 0) {
      return reply.status(400).send({ error: '`activeFilePath` or `activeFiles` is required' });
    }
    const maxTokens =
      body.maxTokens !== undefined ? body.maxTokens : maxTokensDefault;
    const result = assembleMany(paths, watcher.cache.entries, {
      maxSkeletons: body.maxSkeletons,
      maxTokens: Number.isFinite(maxTokens as number) ? (maxTokens as number) : undefined,
      includeStats: body.includeStats,
    });
    if (!silent) console.log(formatSavings(result.tokenStats, { color: wantsColor(process.stdout) }));
    recordSavings(root, 'v1/context', result.tokenStats, sessionStartedAt);
    return {
      markdown: result.markdown,
      activeFilePath: result.activeFilePath,
      activeFilePaths: result.activeFilePaths,
      dependencies: result.included.map((i) => i.filePath),
      unresolved: result.unresolved,
      tokenStats: result.tokenStats,
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
/**
 * `token-shrink stats [--root <dir>]`: print the last call, session and
 * all-time savings recorded in `<root>/.token-shrink/stats.json`.
 */
export function printStats(root: string, out: (line: string) => void = console.log): boolean {
  const stats = readStats(root);
  if (!stats) {
    out(picocolors.dim(`No token-shrink stats yet (${statsPathFor(root)}).`));
    return false;
  }
  const color = wantsColor(process.stdout);
  out(formatSavings(stats.last, { color, label: `last call (${stats.last.tool})` }));
  out(formatSavings(stats.session, { color, label: `session · ${stats.session.calls} calls` }));
  out(formatSavings(stats.allTime, { color, label: `all time · ${stats.allTime.calls} calls` }));
  return true;
}

if (
  argv1 === 'cli.js' || argv1 === 'cli.mjs' ||
  argv1 === 'cli.cjs' || argv1 === 'cli.ts' ||
  argv1Real === 'cli.js' || argv1Real === 'cli.mjs' ||
  argv1Real === 'cli.cjs' || argv1Real === 'cli.ts'
) {
  if (process.argv[2] === 'stats') {
    const args = parseArgv();
    printStats(path.resolve(args.root ?? process.env.ROOT ?? process.cwd()));
  } else {
    startServer().catch((err) => {
      console.error(picocolors.red(`[token-shrink] ${err.message}`));
      process.exitCode = 1;
    });
  }
}
