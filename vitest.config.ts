import { defineConfig } from 'vitest/config';

// Tests run against a real MongoDB (mongodb-memory-server, started once in
// test/globalSetup.ts); each test file gets its own database (test/setup.ts).
// IPFS, tusd, encoders, the gate and webhooks are stubbed per test.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    setupFiles: ['test/setup.ts'],
    pool: 'forks',
    // Route handlers log a lot; show it only for failing tests.
    silent: 'passed-only',
    testTimeout: 20_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'text', 'json-summary'],
      thresholds: { lines: 75, statements: 75 },
    },
  },
});
