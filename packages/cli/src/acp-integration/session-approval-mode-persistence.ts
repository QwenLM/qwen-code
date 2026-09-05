/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApprovalMode,
  createDebugLogger,
  type Config,
  type SessionRestoreProjection,
} from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('SESSION_APPROVAL_MODE');

export function applyRestoredSessionApprovalMode(
  config: Config,
  projection: SessionRestoreProjection | undefined,
): void {
  const restored = projection?.runtime.recording.sessionApprovalMode;
  if (!restored) return;

  if (config.isSafeMode() || config.getBareMode()) {
    debugLogger.warn(
      'Ignoring restored approval mode because this session is restricted.',
    );
    return;
  }

  if (restored.kind === 'invalid') {
    config.restoreApprovalModeState({ mode: ApprovalMode.DEFAULT });
    debugLogger.warn(
      'Ignoring invalid session approval mode record; using default mode.',
    );
    return;
  }

  try {
    config.restoreApprovalModeState(restored.payload);
  } catch (error) {
    config.restoreApprovalModeState({ mode: ApprovalMode.DEFAULT });
    debugLogger.warn(
      `Restored approval mode was rejected by current policy; using default mode: ${error}`,
    );
  }
}
