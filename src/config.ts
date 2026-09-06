/**
 * `.tokenshrinkrc.json` support — developer-level customization.
 *
 * Supported keys (all optional arrays of strings):
 *   - ignorePatterns: glob patterns of paths that are never indexed/watched;
 *   - keepUnpruned:   glob patterns of files to index but never prune;
 *   - preserveAnnotations: markers (e.g. `@keepContext`, `@api`) that exempt a
 *     definition (and everything nested in it) from pruning.
 *
 * The config file lives at the repository root (the auto-detected root when no
 * `--root` is given). Invalid JSON never crashes the server — it logs a warning
 * and falls back to empty defaults.
 */

import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE_NAME = '.tokenshrinkrc.json';

export interface TokenShrinkConfig {
  /** Glob patterns of paths that should never be indexed or watched. */
  ignorePatterns: string[];
  /** Glob patterns of files to index but never prune (full Ring-1 text). */
  keepUnpruned: string[];
  /** Annotation markers (e.g. `@keepContext`) that exempt a definition from pruning. */
  preserveAnnotations: string[];
  /**
   * When false, the generated agent rule carries only lightweight guidance and
   * the model decides when to call the auxiliary tools on its own. Default
   * (true / unset): rules choreograph the tools automatically each task.
   */
  autoWorkflow?: boolean;
}

export const EMPTY_CONFIG: TokenShrinkConfig = {
  ignorePatterns: [],
  keepUnpruned: [],
  preserveAnnotations: [],
};

export function configPathFor(root: string): string {
  return path.join(root, CONFIG_FILE_NAME);
}

/** Parse + validate the config at `root`, tolerating any JSON shape. */
export function loadConfig(
  root: string,
  warn?: (msg: string) => void,
): TokenShrinkConfig {
  const file = configPathFor(root);
  let raw: unknown;
  try {
    if (!fs.existsSync(file)) return { ...EMPTY_CONFIG };
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    warn?.(`Invalid ${CONFIG_FILE_NAME} at ${file}: ${(err as Error).message}`);
    return { ...EMPTY_CONFIG };
  }
  return normalizeConfig(raw, warn, file);
}

function normalizeConfig(
  raw: unknown,
  warn?: (msg: string) => void,
  file?: string,
): TokenShrinkConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warn?.(`Invalid ${CONFIG_FILE_NAME}${file ? ` at ${file}` : ''}: expected a JSON object.`);
    return { ...EMPTY_CONFIG };
  }
  const obj = raw as Record<string, unknown>;
  const asStrings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    ignorePatterns: asStrings(obj.ignorePatterns),
    keepUnpruned: asStrings(obj.keepUnpruned),
    preserveAnnotations: asStrings(obj.preserveAnnotations),
    ...(typeof obj.autoWorkflow === 'boolean' ? { autoWorkflow: obj.autoWorkflow } : {}),
  };
}

/** True when the (slash-normalized) `file` matches any `pattern`. */
export function matchesAny(file: string, patterns: string[]): boolean {
  const rel = normalizeSlashes(file);
  for (const raw of patterns) {
    if (!raw) continue;
    const pattern = normalizeSlashes(raw).replace(/^\.\//, '');
    if (matchesGlob(rel, pattern)) return true;
  }
  return false;
}

/**
 * Glob matcher with `**`, `*`, `?` and `[...]` support. Patterns that contain
 * no glob metacharacters also match as a path suffix (a bare filename like
 * `global.d.ts` matches any directory containing it).
 */
export function matchesGlob(file: string, pattern: string): boolean {
  if (file === pattern) return true;
  if (!/[?*[]/.test(pattern)) {
    // Plain path: exact, or trailing suffix (bare file name / deep dir).
    return file.endsWith(`/${pattern}`);
  }
  const re = globToRegExp(pattern);
  return re.test(file);
}

/** Compile `**`/`*`/`?`/`[...]` glob into a `/`-normalized regex. */
export function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        // `**/` may match zero or more segments; consume the slash too.
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const close = glob.indexOf(']', i);
      if (close === -1) {
        re += '\\[';
      } else {
        const inner = glob.slice(i + 1, close).replace(/\\/g, '\\\\');
        re += `[${inner}]`;
        i = close;
      }
    } else {
      re += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  re += '$';
  return new RegExp(re);
}

function normalizeSlashes(p: string): string {
  return p.split(path.sep).join('/').replace(/^\.\//, '');
}
