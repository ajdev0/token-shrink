/**
 * Project-root auto-detection for zero-config (no `--root`) mode.
 *
 * The MCP server cannot always know its project at startup: clients spawn
 * stdio servers from directories they choose, and shared/global configs have no
 * project at all. When no explicit root is supplied, these helpers locate the
 * repository by walking up from a known path (the process cwd, or the active
 * file of a tool call) until a VCS directory or a project manifest is found.
 */

import fs from 'node:fs';
import path from 'node:path';

/** VCS dirs mark the true repository boundary — the strongest signal. */
export const VCS_MARKER_DIRS = ['.git', '.hg', '.svn'] as const;

/** Manifest files that mark a project boundary when no VCS dir exists. */
export const PROJECT_MANIFEST_FILES = [
  // JavaScript / TypeScript
  'package.json',
  'tsconfig.json',
  // Python
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'requirements.txt',
  // Go / Rust / Dart / Swift
  'go.mod',
  'Cargo.toml',
  'pubspec.yaml',
  'Package.swift',
  // Java / Kotlin
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  // PHP / Ruby / Elixir
  'composer.json',
  'Gemfile',
  'mix.exs',
] as const;

const MANIFEST_FILE_SET: ReadonlySet<string> = new Set(PROJECT_MANIFEST_FILES);

/** Ceiling on upward directory walks (fs roots are deep but bounded). */
const MAX_WALK_DEPTH = 64;

/**
 * Find the project root that `fromPath` belongs to, or `null` when none can be
 * determined. `fromPath` may be a file or directory (existing or not).
 *
 * Walk-up rules:
 *  - the first ancestor containing a VCS dir (`.git`/`.hg`/`.svn`) wins — it is
 *    the true repository boundary, even inside a monorepo sub-package;
 *  - otherwise the deepest ancestor containing a project manifest
 *    (`package.json`, `pyproject.toml`, `go.mod`, …) is returned;
 *  - otherwise `null`, meaning the tree holds no recognizable project markers.
 */
export function detectProjectRoot(fromPath: string): string | null {
  const resolved = path.resolve(fromPath);
  let dir = isDirectory(resolved) ? resolved : path.dirname(resolved);
  let nearestManifest: string | null = null;

  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    const names = readDirNames(dir);
    if (names) {
      if (VCS_MARKER_DIRS.some((vcs) => names.has(vcs))) return dir;
      if (nearestManifest === null && hasManifest(names)) nearestManifest = dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return nearestManifest;
}

/** Is `p` an existing directory (ENOENT-safe)? */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Read a directory's entry names, or `null` when unreadable. */
function readDirNames(dir: string): ReadonlySet<string> | null {
  try {
    return new Set(fs.readdirSync(dir));
  } catch {
    return null; // permission errors / vanished dirs mid-walk
  }
}

function hasManifest(names: ReadonlySet<string>): boolean {
  for (const name of names) {
    if (MANIFEST_FILE_SET.has(name)) return true;
  }
  return false;
}
