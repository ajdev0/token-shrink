import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWatcher, resolveImport } from '../src/watcher/sync.js';

const dirs: string[] = [];
const watchers: ReturnType<typeof createWatcher>[] = [];
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-watch-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(watchers.splice(0).map(w => w.close()));
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('watcher safety', () => {
  it('rejects filesystem roots, including symlink aliases', () => {
    const root = path.parse(process.cwd()).root;
    expect(() => createWatcher({ root })).toThrow('Pass --root');
    const alias = path.join(temp(), 'alias');
    fs.symlinkSync(root, alias, 'dir');
    expect(() => createWatcher({ root: alias })).toThrow('Pass --root');
  });

  it('handles permission and resource errors without an unhandled error event', () => {
    const onError = vi.fn();
    const w = createWatcher({ root: temp(), onError });
    watchers.push(w);
    for (const code of ['EACCES', 'EPERM', 'ENOSPC']) {
      const error = Object.assign(new Error(code), { code });
      expect(() => w.watcher.emit('error', error)).not.toThrow();
      expect(onError).toHaveBeenCalledWith(error);
    }
  });

  it('does not traverse a symlink outside the project', async () => {
    const root = temp();
    const outside = temp();
    fs.writeFileSync(path.join(outside, 'secret.ts'), 'export const secret = 1;');
    fs.symlinkSync(outside, path.join(root, 'external'), 'dir');
    const w = createWatcher({ root });
    watchers.push(w);
    await new Promise<void>(resolve => w.watcher.on('ready', resolve));
    expect(Object.keys(w.watcher.getWatched()).some(p => p.includes('external'))).toBe(false);
    expect(await w.indexAll()).toBe(0);
  });

  it.each(['EACCES', 'EPERM', 'ENOENT'])('continues cold indexing after %s in a subdirectory', async code => {
    const root = temp();
    const blocked = path.join(root, 'blocked');
    fs.mkdirSync(blocked);
    const w = createWatcher({ root });
    watchers.push(w);
    await new Promise<void>(resolve => w.watcher.on('ready', resolve));
    const original = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: any, options: any) => {
      if (String(p) === blocked) throw Object.assign(new Error(code), { code });
      return original(p, options);
    }) as typeof fs.promises.readdir);
    await expect(w.indexAll()).resolves.toBe(0);
  });
});

describe('TypeScript ESM .js specifiers', () => {
  it('resolves ./x.js to x.ts and ./x.mjs to x.mts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-esm-'));
    fs.writeFileSync(path.join(dir, 'util.ts'), 'export const u = 1;\n');
    fs.writeFileSync(path.join(dir, 'mod.mts'), 'export const m = 1;\n');
    const importer = path.join(dir, 'main.ts');
    expect(resolveImport(importer, './util.js', dir)).toBe(path.join(dir, 'util.ts'));
    expect(resolveImport(importer, './mod.mjs', dir)).toBe(path.join(dir, 'mod.mts'));
  });
});
