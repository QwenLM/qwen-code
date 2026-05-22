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
      // #4175 F1 test split — daemonStatusProvider.test.ts imports the
      // shared FakeAgent / makeChannel fixtures that live in
      // acp-bridge's package-private `internal/testUtils` module. We
      // route through this alias rather than declaring a package
      // subpath export so `internal/*` stays out of the published npm
      // surface (matches the `internal/stderrLine.ts` convention) and
      // cli tests read source directly instead of the
      // build-then-stale `dist/` copy.
      '@qwen-code/acp-bridge/internal/testUtils': path.resolve(
        __dirname,
        '../acp-bridge/src/internal/testUtils.ts',
      ),
    },
  },
  test: {
    include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)', 'config.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/cypress/**'],
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
