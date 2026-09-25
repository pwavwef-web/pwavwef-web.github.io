import { defineConfig } from 'vitest/config';

/** Unit tests for every workspace. Integration tests (emulators) use tests/vitest.config.ts. */
export default defineConfig({
  test: {
    // Keep worker startup within the memory available on the development and deploy hosts.
    maxWorkers: 2,
    projects: [
      { test: { name: 'shared', root: './packages/shared', include: ['test/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'functions', root: './functions', include: ['test/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'renderer', root: './services/renderer', include: ['test/**/*.test.ts'], environment: 'node' } },
      './apps/web/vitest.config.ts',
    ],
  },
});
