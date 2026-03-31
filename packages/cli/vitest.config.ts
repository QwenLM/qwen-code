/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@qwen-code/qwen-code-core': path.resolve(__dirname, '../core/index.ts'),
    },
  },
  test: {
    include: ['**/*.{test,spec}.?(c|m)ts?(x)', 'config.test.ts'],
    // Exclude compiled .js outputs — .ts sources are canonical
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/*.test.js',
      '**/*.spec.js',
    ],
    environment: 'jsdom',
    globals: true,
    reporters: ['default', 'junit'],
    silent: true,
    outputFile: {
      junit: 'junit.xml',
    },
    setupFiles: ['./test-setup.ts'],
    coverage: {
      enabled: true,
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*'],
      reporter: [
        ['text', { file: 'full-text-summary.txt' }],
        'html',
        'json',
        'lcov',
        'cobertura',
        ['json-summary', { outputFile: 'coverage-summary.json' }],
      ],
    },
    poolOptions: {
      threads: {
        minThreads: 8,
        maxThreads: 16,
      },
    },
    server: {
      deps: {
        inline: [/@qwen-code\/qwen-code-core/],
      },
    },
  },
});
