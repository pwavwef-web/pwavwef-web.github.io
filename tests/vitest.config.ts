import { defineConfig } from 'vitest/config';

/** Integration tests. Run through `npm run test:integration`, which starts the Firebase emulators. */
export default defineConfig({
  test: {
    name: 'integration',
    root: import.meta.dirname,
    include: ['**/*.int.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
