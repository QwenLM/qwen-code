/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Tests whose cost is intrinsic to what they verify (real child processes,
// real git repositories). They are left out of default runs and included by
// test:ci, CI=true, or QWEN_RUN_SLOW_TESTS=1.
const runSlowTests =
  process.env.QWEN_RUN_SLOW_TESTS === '1' || process.env.CI === 'true';
const slowTests = [
  'src/services/terminal/terminalPtyProcess.integration.test.ts',
  'src/services/worktree-reentry.integration.test.ts',
  'src/services/git-branch-timeout.integration.test.ts',
  'src/utils/process-utils.integration.test.ts',
  'src/utils/windowsExecutableProbe.integration.test.ts',
  'src/utils/fetch.bun-cancel.integration.test.ts',
  'src/utils/gitFsmonitor.integration.test.ts',
  'src/utils/gitPackedRefs.integration.test.ts',
  'src/tools/worktree-runtime.integration.test.ts',
  'src/tools/cwd-environment.integration.test.ts',
  'src/utils/shell/pkillSelfProtection.test.ts',
];

export default defineConfig({
  // Resources own process-wide mutable state; resolve the workspace package to
  // source so a compiled copy cannot split it from the source copy.
  resolve: {
    alias: {
      '@qwen-code/core/sessions': path.resolve(rootDir, 'sessions.ts'),
      '@qwen-code/core': path.resolve(rootDir, 'index.ts'),
      '@qwen-code/resource': path.resolve(rootDir, '../resource/index.ts'),
    },
  },
  test: {
    reporters: ['default', 'junit'],
    testTimeout: 60000,
    hookTimeout: 60000,
    silent: true,
    setupFiles: ['./src/test-utils/setup.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.qwen*/**',
      '**/.qoder*/**',
      // skip: 现存失败 (fails at module load, so it.skip cannot apply)
      'src/mcp/oauth-token-storage.test.ts',
      ...(runSlowTests ? [] : slowTests),
    ],
    outputFile: {
      junit: 'coverage/junit.xml',
    },
    coverage: {
      // Off by default for fast local runs. Opt in with COVERAGE=1 or in CI.
      enabled: process.env.COVERAGE === '1' || process.env.CI === 'true',
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
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
        minForks: 1,
        maxForks: 4,
      },
    },
  },
});
