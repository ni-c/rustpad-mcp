import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Entry point: only wires config and server to the stdio transport and
      // exits the process; not reachable from unit tests.
      exclude: ['src/index.ts'],
      // Just below the measured values (92.2/84.3/96.5/92.8 at the time of
      // writing) so a regression fails the run. Never lowered to go green.
      thresholds: {
        statements: 91,
        branches: 83,
        functions: 92,
        lines: 91,
      },
    },
  },
});
