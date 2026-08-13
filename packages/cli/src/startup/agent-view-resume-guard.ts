/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readAgentViewSessionState } from '../agent-view/supervisor-store.js';
import { isAgentViewWorkerEnv } from '../agent-view/worker-sideband.js';

export const MANAGED_AGENT_VIEW_RESUME_MESSAGE =
  'That session is still running as a background agent. Open `qwen agents` to attach to it, or remove it from Agent View first to resume here.';

export const AGENT_VIEW_WORKER_RESUME_MESSAGE =
  'Resume is disabled inside an attached background agent. Detach to `qwen agents` and use `/resume` there.';

export const MANAGED_AGENT_VIEW_ONE_SHOT_RESUME_MESSAGE =
  'Cannot use one-shot input (-p/--prompt, -i, or piped stdin) with --resume of a session that is still running as a background agent. Use `qwen agents attach <id>` to interact with it instead.';

export async function isManagedAgentViewResumeBlocked(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (isAgentViewWorkerEnv(env)) return false;
  const state = await readAgentViewSessionState(sessionId);
  return state?.ownership === 'managed';
}

export function isAgentViewWorkerResumeCommandBlocked(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isAgentViewWorkerEnv(env);
}
