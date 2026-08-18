import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Entry point: only wires config and server to the stdio transport and
      // exits the process; not reachable from unit tests.
      exclude: ['src/index.ts'],
      // Just below the measured values (93.7/87.2/97.8/95.1 at the time of
      // writing) so a regression fails the run. Never lowered to go green.
      thresholds: {
        statements: 92,
        branches: 86,
        functions: 93,
        lines: 94,
      },
    },
  },
});
