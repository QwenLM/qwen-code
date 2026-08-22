/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  uiTelemetryService,
  type Config,
  type UiTelemetryReplaySnapshot,
} from '@qwen-code/qwen-code-core';

/**
 * Restores the pre-replay telemetry snapshot after an abandoned session
 * swap. Restore failures are logged, not rethrown — compensation must never
 * block the rollback itself. Ordering relative to the rollback is the call
 * site's decision (see useResumeCommand / useBranchCommand).
 */
export function restoreTelemetryReplay(
  snapshot: UiTelemetryReplaySnapshot,
  config: Config,
  commandLabel: string,
): void {
  try {
    uiTelemetryService.restoreFromReplaySnapshot(snapshot);
  } catch (restoreErr) {
    config
      .getDebugLogger()
      .warn(
        `Telemetry rollback after failed ${commandLabel} init failed: ${restoreErr}`,
      );
  }
}
