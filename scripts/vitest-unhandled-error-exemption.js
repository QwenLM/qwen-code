/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The RPC-timeout unhandled-error exemption shared by every vitest config.
 *
 * Vitest's worker->main `onTaskUpdate` RPC runs on a fixed 60s budget, and
 * under runner resource pressure a stall longer than that surfaces as an
 * unhandled error that exits an all-green run red with no `FAIL` line
 * anywhere in the log — the failure class behind #10438 (the Windows/macOS
 * lanes) and #10488 (the post-merge unit lane on the shared self-hosted
 * pool). The exemption keeps that infrastructure class from masking the
 * lane: it covers every platform on self-hosted runners and every non-Linux
 * platform elsewhere, while github-hosted Linux and local runs keep the
 * unhandled-error signal (the same split integration-tests draws). Real test
 * failures stay fatal everywhere.
 *
 * The value is computed at import time: ci.yml's unit test step exports
 * RUNNER_ENVIRONMENT from `${{ runner.environment }}`, and the config
 * witnesses re-import each config under a controlled value after
 * vi.resetModules(). Keep it a module-level read — a cached or build-time
 * constant would break the re-import pin in
 * scripts/tests/unit-vitest-configs.test.ts.
 */
export const unhandledErrorExemption =
  process.platform !== 'linux' ||
  process.env['RUNNER_ENVIRONMENT'] === 'self-hosted';
