import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The integration suite has its own config and its own command, because it
    // needs a Rustpad in Docker. Excluding it here keeps `npm test` runnable
    // with nothing installed, and keeps the coverage numbers below comparable
    // to what they measured before it existed.
    exclude: [...configDefaults.exclude, 'test/integration/**'],
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
