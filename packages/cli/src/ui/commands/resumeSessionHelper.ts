/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SessionStartSource,
  type PermissionMode,
  type ResumedSessionData,
  type Config,
} from '@qwen-code/qwen-code-core';
import { buildResumedHistoryItems } from '../utils/resumeHistoryUtils.js';
import type { CommandContext } from './types.js';

/**
 * Shared logic for resuming into a session (used by both /branch and /resume).
 *
 * Ordering follows the existing useResumeCommand pattern:
 * 1. Reset UI session stats
 * 2. Build UI history (before config.startNewSession mutates state)
 * 3. Clear + load UI history
 * 4. Update core config
 * 5. Re-initialize Gemini client
 * 6. Fire SessionStart hook
 */
export async function resumeIntoSession(
  context: CommandContext,
  config: Config,
  sessionId: string,
  sessionData: ResumedSessionData,
): Promise<void> {
  // 1. Reset UI session stats
  if (context.session.startNewSession) {
    context.session.startNewSession(sessionId);
  }

  // 2. Build UI history BEFORE config.startNewSession (which resets internal state)
  const uiHistoryItems = buildResumedHistoryItems(sessionData, config);

  // 3. Clear and load UI history
  context.ui.clear();
  context.ui.loadHistory(uiHistoryItems);

  // 4. Update core config with session data
  config.startNewSession(sessionId, sessionData);

  // 5. Re-initialize Gemini client with the session history
  await config.getGeminiClient()?.initialize?.();

  // 6. Fire SessionStart event (non-blocking)
  config
    .getHookSystem()
    ?.fireSessionStartEvent(
      SessionStartSource.Resume,
      config.getModel() ?? '',
      String(config.getApprovalMode()) as PermissionMode,
    )
    .catch((err) => {
      config.getDebugLogger().warn(`SessionStart hook failed: ${err}`);
    });
}
