/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['scripts/tests/**/*.test.{js,ts}'],
    // Script tests that drive Linux-only CI (ubuntu-latest workflow jobs, or
    // bash/shell fixtures Windows cannot express) fail on a Windows runner.
    // Linux CI remains their authoritative coverage.
    exclude:
      process.platform === 'win32'
        ? [
            ...configDefaults.exclude,
            'scripts/tests/e2e-shard-retry.test.js',
            'scripts/tests/pr-self-report-label.test.js',
            // Bash-driven workflow suites cannot run on Windows; pure
            // YAML-parse workflow suites still do.
            'scripts/tests/qwen-*-workflow.test.js',
            'scripts/tests/serve-ab-workflow.test.js',
          ]
        : [...configDefaults.exclude],
    setupFiles: ['scripts/tests/test-setup.ts'],
    // Several tests in install-script.test.js shell out to `node` to run
    // create-standalone-package.js, which on Windows runs a full
    // tar+gzip pass under antivirus inspection. Real runtimes observed on
    // Windows CI: 4780ms / 1666ms / 1079ms — the 4.8s one is right at
    // vitest's 5s default and flakes. Bump the suite timeout so a single
    // slow subprocess startup doesn't fail an otherwise-healthy test run.
    //
    // 30s then proved to be the quiet-host figure. On the shared pool the
    // same work runs about 5x slower, and release run 33725742855 lost its
    // Quality Checks (Scripts) job to two files at once —
    // qwen-autofix-workflow.test.js, whose heaviest case measures ~14s idle,
    // and acp-serve-boundary-guard.test.js — neither of them slow, both past
    // 30s under contention. Per-test `vi.setConfig` does not help: these
    // cases register their timeout at collection, before it runs.
    // `||`, not `??`: `??` only catches `undefined`, and the value this repo
    // actually plants is `''` — that is what `${{ cond && 'x' || '' }}` renders
    // when the condition is false. `Number('')` is 0, and vitest reads 0 as
    // "no timeout at all", so the empty spelling would silently disarm every
    // ceiling in this suite. `NaN` from a typo falls back the same way.
    testTimeout: Number(process.env['QWEN_SCRIPTS_TEST_TIMEOUT_MS']) || 90_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
    // No poolOptions override: the fixed 8-16 worker floor it used to carry
    // oversubscribes the 3-core macOS runners. Vitest's default scales with
    // the host cores, which is what every other suite in this repository
    // uses.
    //
    // RPC-timeout exemption; see scripts/tests/unit-vitest-configs.test.ts.
    dangerouslyIgnoreUnhandledErrors: process.platform !== 'linux',
  },
});
