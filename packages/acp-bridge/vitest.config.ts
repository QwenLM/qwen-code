/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@qwen-code/qwen-code-core/subSessionConstants': path.resolve(
        __dirname,
        '../core/src/tools/sub-session-constants.ts',
      ),
      '@qwen-code/qwen-code-core/goalWire': path.resolve(
        __dirname,
        '../core/src/goals/goal-wire.ts',
      ),
      '@qwen-code/qwen-code-core/transcriptRecords': path.resolve(
        __dirname,
        '../core/src/utils/transcript-records.ts',
      ),
      '@qwen-code/qwen-code-core/userPromptSubmitContext': path.resolve(
        __dirname,
        '../core/src/hooks/user-prompt-submit-context.ts',
      ),
    },
  },
  test: {
    reporters: ['default'],
    silent: true,
    // The worker->main `onTaskUpdate` RPC runs on a 60s budget; under the
    // resource pressure of the Windows/macOS runners a stall longer than
    // that surfaces as an unhandled error and exits an all-green run red
    // (the same failure class the core, cli, and scripts suites hit on
    // these lanes). Test failures still fail the run; only unhandled
    // errors stop being fatal, and only off Linux — the ubuntu lane and
    // Linux local runs keep the unhandled-error signal.
    dangerouslyIgnoreUnhandledErrors: process.platform !== 'linux',
    coverage: {
      enabled: false,
      provider: 'v8',
      include: ['src/**/*'],
    },
  },
});
