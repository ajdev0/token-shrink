import { defineConfig } from 'tsup';

import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/mcp.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  publicDir: 'wasm',
  sourcemap: true,
  target: 'node18',
  // Provide `__filename`/`__dirname` in the ESM build (and `import.meta.url` in
  // CJS): the parser and grammar cache resolve wasm files relative to them.
  shims: true,
  // Prepend a shebang to every generated JS file so the `bin` targets
  // (dist/cli.cjs, dist/mcp.cjs) are valid executable entry points. A hashbang
  // is a legal leading comment, so this is harmless on library/chunk output.
  banner: { js: '#!/usr/bin/env node' },
  // Inline package.json's version so `/health`, the MCP handshake and the
  // library export never drift from the published version.
  define: { __TOKEN_SHRINK_VERSION__: JSON.stringify(pkg.version) },
});
