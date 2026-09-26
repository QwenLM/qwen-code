/**
 * Vitest config used only by Stryker (metric C2) for packages/core.
 *
 * Two departures from the package config:
 *
 * 1. Stryker's Vitest runner forces `pool: 'threads'`, and worker threads
 *    cannot `process.chdir()`. The five core test files that change the
 *    working directory therefore fail Stryker's initial dry run, so they are
 *    excluded here. They still run in the normal suite and in the C1 replay.
 * 2. Core's import graph is dense enough that Vitest's "related" filter still
 *    selects most of the suite, and the dry run times out. Per experiment the
 *    test set is given explicitly through STRYKER_TEST_INCLUDE, a
 *    comma-separated list of globs relative to packages/core: the sibling
 *    test file of each mutated module plus the test files that import it
 *    directly (the same depth-1 rule fault-replay.mjs uses). Unset, the whole
 *    suite minus the exclusions runs.
 *
 * Copy this file next to packages/core/vitest.config.ts in the measurement
 * worktree (it is not checked into the repository).
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

const include = process.env['STRYKER_TEST_INCLUDE']
  ? process.env['STRYKER_TEST_INCLUDE'].split(',').map((s) => s.trim()).filter(Boolean)
  : undefined;

export default mergeConfig(
  base,
  defineConfig({
    test: {
      ...(include ? { include } : {}),
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        'src/tools/ripGrep.test.ts',
        'src/extension/github.test.ts',
        'src/utils/projectSummary.test.ts',
        'src/utils/openaiLogger.test.ts',
        'src/ipc/peer-controllers.test.ts',
      ],
      reporters: ['default'],
      coverage: { enabled: false },
    },
  }),
);
