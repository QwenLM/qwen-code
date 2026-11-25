/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Dedicated config for the release login-path gate. The regular integration
// suites exclude release-login-gate/ (see vitest.config.ts); only the release
// workflow's login_e2e_gate job runs this config, and only that job receives
// the test-account secrets. No globalSetup: the gate job supplies the built
// CLI via TEST_CLI_PATH / the unpacked release build, and the case isolates
// its own QWEN_HOME.

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['release-login-gate/**/*.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 120_000,
    reporters: ['default'],
    retry: 1,
    fileParallelism: false,
    pool: 'forks',
  },
});
