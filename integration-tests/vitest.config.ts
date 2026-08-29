/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const timeoutMinutes = Number(process.env['TB_TIMEOUT_MINUTES'] || '5');
const testTimeoutMs = timeoutMinutes * 60 * 1000;

export default defineConfig({
  test: {
    testTimeout: testTimeoutMs,
    globalSetup: './globalSetup.ts',
    reporters: ['default'],
    include: ['**/*.test.ts'],
    exclude: [
      '**/terminal-bench/*.test.ts',
      '**/hook-integration/**',
      '**/qwen-daemon-loadtest*',
      '**/qwen-daemon-first-output-benchmark*',
      '**/node_modules/**',
    ],
    retry: 2,
    fileParallelism: true,
    pool: 'forks',
    poolOptions: {
      forks: {
        minForks: 2,
        maxForks: 4,
      },
    },
    // The worker->main `onTaskUpdate` RPC runs on a 60s budget; under
    // resource pressure a stall longer than that surfaces as an unhandled
    // error and exits an all-green run red (the same failure class the
    // core, cli, and scripts suites hit on the macOS lane). Since #10085
    // the Linux shards run on the shared self-hosted pool instead of
    // ubuntu-hosted VMs and hit the same pressure class there (#10325), so
    // self-hosted runners are exempted as well. Test failures still fail
    // the run; only unhandled errors stop being fatal — github-hosted Linux
    // (the nightly isolated legs) and local Linux runs keep the signal.
    dangerouslyIgnoreUnhandledErrors:
      process.platform !== 'linux' ||
      process.env['RUNNER_ENVIRONMENT'] === 'self-hosted',
  },
  resolve: {
    alias: {
      // Use built SDK bundle for e2e tests
      '@qwen-code/sdk/daemon/transports': resolve(
        __dirname,
        '../packages/sdk-typescript/dist/daemon/transports.js',
      ),
      '@qwen-code/sdk/daemon/transcript': resolve(
        __dirname,
        '../packages/sdk-typescript/dist/daemon/transcript.js',
      ),
      '@qwen-code/sdk/daemon': resolve(
        __dirname,
        '../packages/sdk-typescript/dist/daemon/index.js',
      ),
      '@qwen-code/sdk': resolve(
        __dirname,
        '../packages/sdk-typescript/dist/index.mjs',
      ),
    },
  },
});
