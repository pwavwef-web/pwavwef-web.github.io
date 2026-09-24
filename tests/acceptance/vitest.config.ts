import { defineConfig } from 'vitest/config';

/**
 * Acceptance tests against the LIVE deployment (project az-learner). They create real, billable
 * generations with the published models and wait for the deployed worker, so they only run with
 * `AZS_ACCEPTANCE=1 npm run test:acceptance` and the developer's Application Default Credentials.
 */
export default defineConfig({
  test: {
    name: 'acceptance',
    root: import.meta.dirname,
    include: ['**/*.acc.test.ts'],
    environment: 'node',
    setupFiles: ['./setup.ts'],
    testTimeout: 90 * 60_000,
    hookTimeout: 10 * 60_000,
    fileParallelism: true,
    maxWorkers: 4,
  },
});
