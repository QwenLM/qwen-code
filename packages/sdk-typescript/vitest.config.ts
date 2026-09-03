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
      // retaining vitest v1 defaults until reviewed for v3 changes
      ignoreEmptyLines: false,
    },
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/', 'dist/'],
    retry: 2,
    fileParallelism: true,
    // retaining vitest v1 default usage until reviewed for v3 changes
    pool: 'threads',
    poolOptions: {
      threads: {
        minThreads: 2,
        maxThreads: 4,
      },
    },
    testTimeout: testTimeoutMs,
    hookTimeout: 10000,
    // RPC-timeout exemption; see scripts/tests/unit-vitest-configs.test.ts.
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
