/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeStderrLineSafe } from '../utils/stdioHelpers.js';
import { ensureAgentViewSupervisor } from '../agent-view/supervisor-runner.js';
import { isManagedAgentViewResumeBlocked } from './agent-view-resume-guard.js';

export async function routeManagedAgentViewResume(
  sessionId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!sessionId) return false;
  if (!(await isManagedAgentViewResumeBlocked(sessionId, env))) {
    return false;
  }
  try {
    writeStderrLineSafe(
      `Session ${sessionId} is managed by Agent View; attaching via supervisor...`,
    );
    const supervisor = await ensureAgentViewSupervisor();
    await supervisor.attach(sessionId);
  } catch (error) {
    writeStderrLineSafe(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  return true;
}
