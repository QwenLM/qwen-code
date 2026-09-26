/**
 * Copied beside the package config by measurement/replay.mjs.
 * Stryker uses worker threads, which cannot run process.chdir(); the five
 * excluded files still run in normal tests and historical fault replay.
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

const include = process.env['STRYKER_TEST_INCLUDE']
  ? process.env['STRYKER_TEST_INCLUDE']
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
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
