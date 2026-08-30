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
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
    // No poolOptions override: the fixed 8-16 worker floor it used to carry
    // oversubscribes the 3-core macOS runners. Vitest's default scales with
    // the host cores, which is what every other suite in this repository
    // uses.
    //
    // The long fake-timer suites here stall a worker's event loop long
    // enough for vitest's worker->main `onTaskUpdate` RPC to hit its 60s
    // timeout and surface as an unhandled error — with every test in the
    // suite green, yet the run exiting 1 (observed deterministic on the
    // macOS runners). Test failures still fail the run; only unhandled
    // errors stop being fatal, and only off Linux — the ubuntu lane and
    // Linux local runs keep the unhandled-error signal.
    dangerouslyIgnoreUnhandledErrors: process.platform !== 'linux',
  },
});
