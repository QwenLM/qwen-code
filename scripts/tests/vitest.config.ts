/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['scripts/tests/**/*.test.{js,ts}'],
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
    poolOptions: {
      threads: {
        minThreads: 8,
        maxThreads: 16,
      },
    },
  },
});
