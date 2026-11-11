/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const inkSourceEntry = path.resolve(__dirname, './src/ink/index.ts');
const coreSourceEntry = path.resolve(__dirname, '../core/index.ts');
const resourcesSourceEntry = path.resolve(__dirname, '../resource/index.ts');
const pluginManagementAlias = {
  '@qwen-code/core/plugin-management': path.resolve(
    __dirname,
    '../core/plugin-management.ts',
  ),
};

// Tests whose cost is intrinsic to what they verify (cold starts of the built
// CLI). They are left out of default runs and included by test:ci, CI=true,
// or QWEN_RUN_SLOW_TESTS=1.
const runSlowTests =
  process.env['QWEN_RUN_SLOW_TESTS'] === '1' || process.env['CI'] === 'true';
const slowTests = [
  'src/ui/components/InputPrompt.fileCompletion.integration.test.tsx',
  'src/utils/exitOrKill.integration.test.ts',
  'src/ui/utils/gitDiff.integration.test.ts',
];

export default defineConfig({
  resolve: {
    conditions: ['test'],
    alias: {
      '@qwen-code/qwen-code/release-notes': path.resolve(
        __dirname,
        'release-notes.ts',
      ),
      '@qwen-code/qwen-code/installation-host': path.resolve(
        __dirname,
        'installation-host.ts',
      ),
      '@qwen-code/qwen-code/installation': path.resolve(
        __dirname,
        'installation.ts',
      ),
      '@qwen-code/qwen-code/framework': path.resolve(__dirname, 'framework.ts'),
      '@qwen-code/qwen-code/command-runtime': path.resolve(
        __dirname,
        'command-runtime.ts',
      ),
      '@qwen-code/qwen-code/acp': path.resolve(__dirname, 'acp.ts'),
      '@alcalzone/ansi-tokenize': path.resolve(
        __dirname,
        './test-support/ansi-tokenize.ts',
      ),
      'lodash-es/noop.js': path.resolve(
        __dirname,
        './test-support/lodash-noop.ts',
      ),
      'lodash-es/throttle.js': path.resolve(
        __dirname,
        './test-support/lodash-throttle.ts',
      ),
      ink: inkSourceEntry,
      ...pluginManagementAlias,
      '@qwen-code/core/sessions': path.resolve(
        __dirname,
        '../core/sessions.ts',
      ),
      '@qwen-code/core/test-utils': path.resolve(
        __dirname,
        '../core/src/test-utils/index.ts',
      ),
      '@qwen-code/core': coreSourceEntry,
      '@qwen-code/qwen-code/ui': path.resolve(__dirname, 'ui.ts'),
      '@qwen-code/qwen-code/thread-manager': path.resolve(
        __dirname,
        'thread-manager.ts',
      ),
      '@qwen-code/resource': resourcesSourceEntry,
      '@qwen-code/qwen-code': path.resolve(__dirname, 'index.ts'),
    },
  },
  test: {
    include: ['**/*.{test,spec}.{js,ts,jsx,tsx}', 'config.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.qwen*/**',
      // skip: 现存失败 (fail at module load, so it.skip cannot apply)
      'src/ui/hooks/useFeedbackEvents.test.tsx',
      'src/ui/hooks/useShellHistory.test.ts',
      ...(runSlowTests ? [] : slowTests),
    ],
    environment: 'node',
    globals: true,
    reporters: ['default', 'junit'],

    outputFile: {
      junit: 'junit.xml',
    },
    alias: {
      '@qwen-code/qwen-code/installation-host': path.resolve(
        __dirname,
        'installation-host.ts',
      ),
      '@qwen-code/qwen-code/installation': path.resolve(
        __dirname,
        'installation.ts',
      ),
      '@qwen-code/qwen-code/framework': path.resolve(__dirname, 'framework.ts'),
      '@qwen-code/qwen-code/command-runtime': path.resolve(
        __dirname,
        'command-runtime.ts',
      ),
      '@qwen-code/qwen-code/acp': path.resolve(__dirname, 'acp.ts'),
      '@alcalzone/ansi-tokenize': path.resolve(
        __dirname,
        './test-support/ansi-tokenize.ts',
      ),
      'lodash-es/noop.js': path.resolve(
        __dirname,
        './test-support/lodash-noop.ts',
      ),
      'lodash-es/throttle.js': path.resolve(
        __dirname,
        './test-support/lodash-throttle.ts',
      ),
      react: path.resolve(__dirname, '../../node_modules/react'),
      ink: inkSourceEntry,
      ...pluginManagementAlias,
      '@qwen-code/core/sessions': path.resolve(
        __dirname,
        '../core/sessions.ts',
      ),
      '@qwen-code/core/test-utils': path.resolve(
        __dirname,
        '../core/src/test-utils/index.ts',
      ),
      '@qwen-code/core': coreSourceEntry,
      '@qwen-code/qwen-code/ui': path.resolve(__dirname, 'ui.ts'),
      '@qwen-code/qwen-code/thread-manager': path.resolve(
        __dirname,
        'thread-manager.ts',
      ),
      '@qwen-code/resource': resourcesSourceEntry,
      '@qwen-code/qwen-code': path.resolve(__dirname, 'index.ts'),
    },
    globalSetup: './vitest.global-setup.ts',
    setupFiles: ['./test-setup.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',
    coverage: {
      // Off by default for fast local runs. Opt in with COVERAGE=1 or in CI.
      enabled: process.env['COVERAGE'] === '1' || process.env['CI'] === 'true',
      all: false,
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
      forks: {
        singleFork: false,
        minForks: 1,
        maxForks: 4,
      },
    },
    server: {
      deps: {
        inline: [
          /@qwen-code\/core/,
          /^ink$/,
          /ink-shim/,
          /ink-gradient/,
          /ink-spinner/,
        ],
      },
    },
  },
});
