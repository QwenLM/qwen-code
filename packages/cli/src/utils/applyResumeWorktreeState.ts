/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  coreEvents,
  toTranscriptWorktreeSession,
  type Config,
  type TranscriptWorktreeSession,
} from '@qwen-code/core';

export type WorktreeResumeOutcome =
  | {
      status: 'ordinary';
      worktreeSession: null;
      acceptLegacyFileHistorySnapshots: true;
    }
  | {
      status: 'restored';
      worktreeSession: TranscriptWorktreeSession;
      acceptLegacyFileHistorySnapshots: false;
    }
  | {
      status: 'fallback';
      worktreeSession: null;
      acceptLegacyFileHistorySnapshots: false;
      pendingCleanup?: string;
    };

/** 三个 CLI Resume 入口共享的 Worktree 状态分派。 */
export async function applyResumeWorktreeState(
  config: Config,
  state: TranscriptWorktreeSession | null | undefined,
  record: Config['recordWorktreeState'],
): Promise<WorktreeResumeOutcome> {
  if (!state) {
    // undefined 尚未确认 legacy 来源，不能覆盖 sidecar 的后续恢复依据。
    if (state === null) await record(null);
    return {
      status: 'ordinary',
      worktreeSession: null,
      acceptLegacyFileHistorySnapshots: true,
    };
  }

  const result = await config.restoreWorktree(state, record);
  if (result.status === 'failed') {
    throw new Error(result.message);
  }
  if (result.status === 'fallback') {
    if (result.pendingCleanup) {
      coreEvents.emitFeedback('warning', result.pendingCleanup);
    } else if (state.pendingExit) {
      coreEvents.emitFeedback(
        'warning',
        'Recovered an interrupted worktree exit. Returned to the original project without retrying deletion.',
      );
    }
    return {
      status: 'fallback',
      worktreeSession: null,
      acceptLegacyFileHistorySnapshots: false,
      ...(result.pendingCleanup
        ? { pendingCleanup: result.pendingCleanup }
        : {}),
    };
  }
  return {
    status: 'restored',
    acceptLegacyFileHistorySnapshots: false,
    worktreeSession: toTranscriptWorktreeSession(
      result.settings,
      config.getSessionId(),
    ),
  };
}
