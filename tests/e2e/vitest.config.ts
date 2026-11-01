import { defineConfig } from 'vitest/config';

/**
 * End-to-end browser tests: the real web app (Vite, emulator mode) driven in a real Chrome by
 * playwright-core, against the auth / Firestore / Storage / Functions / Tasks emulators. Run through
 * `npm run test:e2e`, which starts the emulators. Nothing here calls a billable model.
 */
export default defineConfig({
  test: {
    name: 'e2e',
    root: import.meta.dirname,
    include: ['**/*.e2e.test.ts'],
    environment: 'node',
    globalSetup: './global-setup.ts',
    // A test can wait on real local renders; on a busy workstation a draft alone can take three minutes.
    testTimeout: 900_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
