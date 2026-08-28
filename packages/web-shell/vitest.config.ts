import { configDefaults, defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'client',
  resolve: {
    alias: {
      '@': resolve(__dirname, './client'),
    },
  },
  test: {
    setupFiles: ['./test/setup.ts'],
    exclude: [...configDefaults.exclude, 'e2e/**'],
    reporters: ['default', ['junit', { suiteName: '@qwen-code/web-shell' }]],
    outputFile: {
      junit: '../junit.xml',
    },
    // The worker->main `onTaskUpdate` RPC runs on a 60s budget; under the
    // resource pressure of the Windows/macOS runners a stall longer than
    // that surfaces as an unhandled error and exits an all-green run red
    // (the same failure class the core, cli, and scripts suites hit on
    // these lanes). Test failures still fail the run; only unhandled
    // errors stop being fatal, and only off Linux — the ubuntu lane and
    // Linux local runs keep the unhandled-error signal.
    dangerouslyIgnoreUnhandledErrors: process.platform !== 'linux',
    coverage: {
      provider: 'v8',
      reportsDirectory: '../coverage',
      reporter: ['text-summary', 'json-summary', 'html'],
      include: ['**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/test/**',
        '**/e2e/**',
        '**/*.d.ts',
        'vite-env.d.ts',
      ],
    },
  },
});
