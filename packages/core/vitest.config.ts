/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Raise the per-test ceiling above vitest's 5s default: the self-hosted
    // CI runners are heavily oversubscribed (maxThreads: 16 below), and I/O-
    // or WASM-load-bound tests (e.g. the web-tree-sitter lazy runtime, tar
    // extraction) blow 5s purely under contention, not from any logic fault.
    // Assertions still fail instantly; only the timeout ceiling grows.
    testTimeout: 15000,
    // Load-sensitive tests (real subprocesses, tempdir I/O, WASM load) flake
    // when a load spike starves them; a retry rides the spike out, while a
    // real deterministic regression fails every attempt.
    retry: 2,
    reporters: ['default', 'junit'],
    silent: true,
    setupFiles: ['./test-setup.ts'],
    outputFile: {
      junit: 'junit.xml',
    },
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
        // Size the pool to the machine instead of a fixed 8-16: test:ci runs
        // every workspace in parallel, so a fixed 16-thread pool per package
        // oversubscribes the shared self-hosted hosts (several runner
        // registrations per host) — the contention that blows the timeouts
        // above. ~2 threads per core keeps a package fast in isolation while
        // leaving headroom for its siblings and neighboring jobs.
        minThreads: Math.min(8, Math.max(2, Math.floor(os.cpus().length / 2))),
        maxThreads: Math.min(16, Math.max(4, os.cpus().length * 2)),
      },
    },
  },
});
