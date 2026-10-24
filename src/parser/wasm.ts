/**
 * WASM grammar acquisition. Lazily downloads a language's `.wasm` grammar
 * from its upstream GitHub release on first use and caches it on disk in a
 * `wasm/` directory at the project root (mirrored to `dist/wasm` by tsup).
 *
 * `Language.load` on Node expects either a Uint8Array of the real parser
 * bytes or a filesystem path; we hand it the raw bytes via `getGrammar`,
 * which returns a `Uint8Array` for the pruner to load directly.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LanguageSpec } from './registry.js';

// `__dirname` is shimmed automatically by tsup so it works in both ESM and
// CJS output: in ESM it derives from import.meta.url, in CJS it is native.
// This avoids calling fileURLToPath(import.meta.url), which is empty in the
// CJS bundle and would crash the packaged CLI (`dist/cli.cjs`, `dist/mcp.cjs`).
/**
 * Resolve the `wasm/` cache directory, preferring the packaged copy.
 * Candidates are searched in order: project `wasm/`, `dist/wasm/`.
 */
function resolveWasmDir(): string {
  const candidates = [
    path.resolve(__dirname, '../../wasm'),
    path.resolve(__dirname, '../wasm'),
    path.resolve(process.cwd(), 'wasm'),
  ];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      /* try next */
    }
  }
  const dir = path.resolve(process.cwd(), 'wasm');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let wasmDir: string | null = null;
function cacheDir(): string {
  if (!wasmDir) wasmDir = resolveWasmDir();
  return wasmDir;
}

/**
 * On-disk cache file for a grammar. The name carries a hash of the pinned
 * download URL, so changing a pin fetches the new release instead of reusing
 * an older cached build.
 */
export function cachePath(spec: LanguageSpec): string {
  const tag = createHash('sha1').update(spec.url).digest('hex').slice(0, 8);
  return path.join(cacheDir(), spec.wasm.replace(/\.wasm$/, `.${tag}.wasm`));
}

/** True if the head bytes are the wasm magic `\0asm`. */
function looksLikeWasm(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0 &&
    bytes[1] === 97 &&
    bytes[2] === 115 &&
    bytes[3] === 109
  );
}

/** In-flight downloads keyed by cache path, so concurrent callers share one. */
const inflight = new Map<string, Promise<Uint8Array>>();

function download(spec: LanguageSpec): Promise<Uint8Array> {
  const pending = inflight.get(cachePath(spec));
  if (pending) return pending;
  const job = (async () => {
    const res = await fetch(spec.url, { redirect: 'follow' });
    if (!res.ok) {
      throw new Error(
        `Failed to download grammar "${spec.wasm}" from ${spec.url} (HTTP ${res.status})`,
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!looksLikeWasm(bytes)) {
      throw new Error(
        `Downloaded grammar "${spec.wasm}" is not valid WebAssembly (got HTML/redirect).`,
      );
    }
    // Write atomically (tmp file + rename) so a concurrent reader never
    // observes a partially-written grammar.
    const target = cachePath(spec);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, target);
    inflight.delete(cachePath(spec));
    return bytes;
  })().catch((err) => {
    inflight.delete(cachePath(spec));
    throw err;
  });
  inflight.set(cachePath(spec), job);
  return job;
}

/**
 * Return the raw grammar bytes for a language, downloading them if needed.
 * `force` bypasses the local disk cache (used by tests / `--warm`).
 */
export async function getGrammar(
  spec: LanguageSpec,
  force = false,
): Promise<Uint8Array> {
  if (!force && fs.existsSync(cachePath(spec))) {
    const cached = fs.readFileSync(cachePath(spec));
    if (looksLikeWasm(cached)) return cached;
  }
  return download(spec);
}

/**
 * Pre-download every supported grammar (used on cold boot / `prune --warm`).
 * Returns the number of grammars that are ready on disk afterward.
 */
export async function warmGrammars(specs: LanguageSpec[] = []): Promise<number> {
  const registryModule = await import('./registry.js');
  const list =
    specs.length > 0 ? specs : (Object.values(registryModule.registry) as LanguageSpec[]);
  const unique = new Map<string, LanguageSpec>();
  for (const spec of list) unique.set(cachePath(spec), spec);
  const results = await Promise.allSettled(
    [...unique.values()].map((spec) => getGrammar(spec)),
  );
  return results.filter((r) => r.status === 'fulfilled').length;
}

