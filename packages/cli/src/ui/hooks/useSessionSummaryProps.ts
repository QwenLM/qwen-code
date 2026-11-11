/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useSessionStats } from '../contexts/SessionContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import {
  escapeShellArg,
  getShellConfiguration,
  BRAND_CLI_BIN,
  hasResumableTranscriptMessages,
  isValidSessionIdUuid,
  ownsWorktreeLifecycle,
} from '@qwen-code/core';

export function useSessionSummaryProps(duration: string) {
  const { stats } = useSessionStats();
  const config = useConfig();
  const { shell } = getShellConfiguration();

  const worktreeSettings = config.getWorktreeSettings();
  const currentPermissionMode = config.getPermissionMode();
  const resumeModeFlag = currentPermissionMode === 'yolo' ? ' --yolo' : '';

  // UUIDs need no quoting in any shell. The tool shell may differ from the
  // terminal where users paste this command (e.g. PowerShell versus CMD).
  const escapedSessionId = isValidSessionIdUuid(stats.sessionId)
    ? stats.sessionId
    : escapeShellArg(stats.sessionId, shell);
  const resumeCommand = `${BRAND_CLI_BIN} --resume ${escapedSessionId}${resumeModeFlag}`;
  // A fresh session (including after /clear) has an ID before it has any
  // resumable history. Use the same content check as session discovery, not
  // promptCount: restored sessions can have history without any new prompts.
  const hasResumableHistory = hasResumableTranscriptMessages(
    config.getConversationMessages(),
  );
  let footer = hasResumableHistory
    ? `To resume this session: ${resumeCommand}`
    : undefined;

  if (worktreeSettings && ownsWorktreeLifecycle(worktreeSettings)) {
    const resumeCwd = worktreeSettings.originalCwd ?? worktreeSettings.path;
    const cleanupHint = `To remove manually: git worktree remove ${escapeShellArg(worktreeSettings.path, shell)}`;
    footer = hasResumableHistory
      ? `To resume work in this worktree: cd ${escapeShellArg(resumeCwd, shell)} && ${resumeCommand}\n${cleanupHint}`
      : cleanupHint;
  }

  return { title: 'Agent powering down. Goodbye!', duration, footer };
}
