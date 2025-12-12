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
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
