/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    // Raise the per-test ceiling above vitest's 5s default: the self-hosted
    // CI runners are heavily oversubscribed, and I/O-
    // or WASM-load-bound tests (e.g. the web-tree-sitter lazy runtime, tar
    // extraction) blow 5s purely under contention, not from any logic fault.
    // Assertions still fail instantly; only the timeout ceiling grows.
    testTimeout: process.env['RUNNER_NAME']?.startsWith('ecs-qwen-')
      ? 60_000
      : 15_000,
    hookTimeout: process.env['RUNNER_NAME']?.startsWith('ecs-qwen-')
      ? 60_000
      : undefined,
    // ECS hosts run several jobs at once; leave capacity for neighboring jobs.
    maxWorkers: process.env['RUNNER_NAME']?.startsWith('ecs-qwen-')
      ? '25%'
      : undefined,
    reporters: ['default', 'junit'],
    silent: true,
    // Fail fast with an actionable message when the workspace dist/ output
    // core tests import through the package entry is missing (fresh clone,
    // new worktree, deep clean). See scripts/vitest-global-setup.js and
    // issue #9149.
    // Resolved against this config file (not vitest's root/cwd) so the guard
    // also loads when vitest is launched from elsewhere with --config.
    globalSetup: path.resolve(
      __dirname,
      '../../scripts/vitest-global-setup.js',
    ),
    setupFiles: ['./test-setup.ts'],
    outputFile: {
      junit: 'junit.xml',
    },
    // RPC-timeout exemption; see scripts/tests/unit-vitest-configs.test.ts.
    dangerouslyIgnoreUnhandledErrors:
      process.platform !== 'linux' ||
      process.env['RUNNER_ENVIRONMENT'] === 'self-hosted',
    coverage: {
      // CI consumes coverage only from the ubuntu lane (the upload and the
      // coverage comment both pin coverage-reports-*-ubuntu-latest), and the
      // report generation adds end-of-run main-thread work on the smaller
      // Windows/macOS runners; skip it there. Local runs keep coverage.
      enabled: !process.env.CI || process.platform === 'linux',
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
  },
});
