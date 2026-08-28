import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/mcp.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  publicDir: 'wasm',
  sourcemap: true,
  target: 'node18',
  // Prepend a shebang to every generated JS file so the `bin` targets
  // (dist/cli.cjs, dist/mcp.cjs) are valid executable entry points. A hashbang
  // is a legal leading comment, so this is harmless on library/chunk output.
  banner: { js: '#!/usr/bin/env node' },
});
