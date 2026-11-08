/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { SessionApprovalModeRecordPayload } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import type { SessionRestoreProjection } from '@qwen-code/qwen-code-core/services/session-transcript-reader.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/debugLogger';

const debugLogger = createDebugLogger('SESSION_APPROVAL_MODE');

export async function recordDaemonSessionApprovalMode(
  config: Config,
  payload: SessionApprovalModeRecordPayload,
): Promise<void> {
  const recording = config.getChatRecordingService?.();
  if (!recording?.recordSessionApprovalMode) return;
  try {
    if (!(await recording.recordSessionApprovalMode(payload))) {
      debugLogger.warn(
        `[session_approval_mode] session=${config.getSessionId()} action=record_failed mode=${payload.mode}`,
      );
    }
  } catch (error) {
    debugLogger.warn(
      `[session_approval_mode] session=${config.getSessionId()} action=record_failed mode=${payload.mode} error=${JSON.stringify(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
  }
}

export async function recordDaemonSessionApprovalModeFromConfig(
  config: Config,
): Promise<void> {
  if (!config.getChatRecordingService?.()?.recordSessionApprovalMode) return;
  const mode = config.getApprovalMode();
  await recordDaemonSessionApprovalMode(config, {
    mode,
    ...(mode === ApprovalMode.PLAN
      ? {
          prePlanMode: config.getPrePlanMode?.() ?? ApprovalMode.DEFAULT,
          ...(config.getPlanExecutionMode?.()
            ? { planExecutionMode: config.getPlanExecutionMode() }
            : {}),
        }
      : {}),
  });
}

function warnRestoreFailure(
  config: Config,
  payload: SessionApprovalModeRecordPayload,
  error: unknown,
): void {
  debugLogger.warn(
    `[session_approval_mode] session=${config.getSessionId()} action=restore_failed mode=${payload.mode} error=${JSON.stringify(
      error instanceof Error ? error.message : String(error),
    )}`,
  );
}

export function applyRestoredSessionApprovalMode(
  config: Config,
  projection: SessionRestoreProjection | undefined,
): void {
  const recorded = projection?.runtime.recording.sessionApprovalMode;
  if (!recorded || config.getBareMode() || config.isSafeMode()) return;

  if (recorded.mode !== ApprovalMode.PLAN) {
    try {
      config.setApprovalMode(recorded.mode, { fromSessionRestore: true });
    } catch (error) {
      warnRestoreFailure(config, recorded, error);
    }
    return;
  }

  try {
    if (config.getApprovalMode() === ApprovalMode.PLAN) {
      config.setApprovalMode(ApprovalMode.DEFAULT, {
        fromSessionRestore: true,
      });
    }
  } catch (error) {
    warnRestoreFailure(config, recorded, error);
    return;
  }

  const prePlanMode = recorded.prePlanMode ?? ApprovalMode.DEFAULT;
  try {
    config.setApprovalMode(prePlanMode, { fromSessionRestore: true });
  } catch (error) {
    warnRestoreFailure(config, recorded, error);
  }

  try {
    if (recorded.planExecutionMode) {
      config.setPlanMode(true, recorded.planExecutionMode);
    } else {
      config.setApprovalMode(ApprovalMode.PLAN);
    }
  } catch (error) {
    warnRestoreFailure(config, recorded, error);
    try {
      config.setApprovalMode(ApprovalMode.PLAN);
    } catch (fallbackError) {
      warnRestoreFailure(config, recorded, fallbackError);
    }
  }
}
