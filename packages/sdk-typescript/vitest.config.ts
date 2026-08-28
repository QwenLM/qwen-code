import { defineConfig } from 'vitest/config';
import * as path from 'path';

const timeoutMinutes = Number(process.env['E2E_TIMEOUT_MINUTES'] || '3');
const testTimeoutMs = timeoutMinutes * 60 * 1000;

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'test/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/index.ts', // Export-only files
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/', 'dist/'],
    retry: 2,
    fileParallelism: true,
    poolOptions: {
      threads: {
        minThreads: 2,
        maxThreads: 4,
      },
    },
    testTimeout: testTimeoutMs,
    hookTimeout: 10000,
    // The worker->main `onTaskUpdate` RPC runs on a 60s budget; under the
    // resource pressure of the Windows/macOS runners a stall longer than
    // that surfaces as an unhandled error and exits an all-green run red
    // (the same failure class the core, cli, and scripts suites hit on
    // these lanes). Test failures still fail the run; only unhandled
    // errors stop being fatal, and only off Linux — the ubuntu lane and
    // Linux local runs keep the unhandled-error signal.
    dangerouslyIgnoreUnhandledErrors: process.platform !== 'linux',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@qwen-code/qwen-code-core/transcriptRecords': path.resolve(
        __dirname,
        '../core/src/utils/transcript-records.ts',
      ),
      '@qwen-code/acp-bridge/transcriptReplay': path.resolve(
        __dirname,
        '../acp-bridge/src/transcript-replay.ts',
      ),
    },
  },
});
