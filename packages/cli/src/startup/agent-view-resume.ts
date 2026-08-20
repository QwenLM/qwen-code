/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeStderrLineSafe } from '../utils/stdioHelpers.js';
import { ensureAgentViewSupervisor } from '../agent-view/supervisor-runner.js';
import {
  isManagedAgentViewResumeBlocked,
  MANAGED_AGENT_VIEW_ONE_SHOT_RESUME_MESSAGE,
} from './agent-view-resume-guard.js';
import { AGENT_VIEW_DISABLED_MESSAGE } from '../agent-view/feature.js';

export async function routeManagedAgentViewResume(
  sessionId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  hasOneShotInput = false,
  agentViewEnabled = true,
): Promise<boolean> {
  if (!sessionId) return false;
  if (!(await isManagedAgentViewResumeBlocked(sessionId, env))) {
    return false;
  }
  if (!agentViewEnabled) {
    writeStderrLineSafe(AGENT_VIEW_DISABLED_MESSAGE);
    process.exitCode = 1;
    return true;
  }
  // Attach is an interactive bridge; one-shot input would be silently
  // dropped, so reject the combination instead of swallowing it.
  if (hasOneShotInput) {
    writeStderrLineSafe(MANAGED_AGENT_VIEW_ONE_SHOT_RESUME_MESSAGE);
    process.exitCode = 1;
    return true;
  }
  try {
    writeStderrLineSafe(
      `Session ${sessionId} is managed by Agent View; attaching via supervisor...`,
    );
    const supervisor = await ensureAgentViewSupervisor();
    await supervisor.attach(sessionId);
    process.exitCode = 0;
  } catch (error) {
    writeStderrLineSafe(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  return true;
}
