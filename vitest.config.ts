import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    // Integration tests download grammars on first run; allow network via an
    // opt-in env var so local unit tests stay fast and offline-safe.
    env: { VITEST_RUN_NETWORK: process.env.NETWORK ? '1' : '0' },
  },
});
