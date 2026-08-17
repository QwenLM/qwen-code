/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  patchAgentViewSessionState,
  readAgentViewSessionState,
} from '../agent-view/supervisor-store.js';
import {
  isAgentViewWorkerEnv,
  QWEN_AGENT_VIEW_SESSION_ID,
  readAgentViewWorkerSidebandEnv,
} from '../agent-view/worker-sideband.js';

export const MANAGED_AGENT_VIEW_RESUME_MESSAGE =
  'That session is still running as a background agent. Open `qwen agents` to attach to it, or remove it from Agent View first to resume here.';

export const AGENT_VIEW_WORKER_RESUME_MESSAGE =
  'Resume is disabled inside an attached background agent. Detach to `qwen agents` and use `/resume` there.';

export const MANAGED_AGENT_VIEW_ONE_SHOT_RESUME_MESSAGE =
  'Cannot use one-shot input (-p/--prompt, -i, --input-file, --fork-session, or piped stdin) with --resume of a session that is still running as a background agent. Use `qwen agents attach <id>` to interact with it instead.';

// The worker-env bypass is load-bearing (respawned workers resume their own
// session), so require the sideband session id to match — a lone forged
// QWEN_AGENT_VIEW_WORKER=1 no longer defeats the guard.
function isSessionWorker(sessionId: string, env: NodeJS.ProcessEnv): boolean {
  return (
    isAgentViewWorkerEnv(env) && env[QWEN_AGENT_VIEW_SESSION_ID] === sessionId
  );
}

export async function isManagedAgentViewResumeBlocked(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (isSessionWorker(sessionId, env)) return false;
  const state = await readAgentViewSessionState(sessionId);
  return state?.ownership === 'managed';
}

/**
 * `--continue` has no supervisor routing to revive exited sessions (unlike
 * `--resume`, which attaches through the supervisor), so block only while
 * the managed worker is still alive; an exited managed session is safe to
 * resume directly in the foreground.
 */
export async function isManagedAgentViewContinueBlocked(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (isSessionWorker(sessionId, env)) return false;
  const state = await readAgentViewSessionState(sessionId);
  return state?.ownership === 'managed' && state.processState !== 'exited';
}

/**
 * When the foreground `--continue` path takes over an exited managed
 * session, drop the roster ownership so a later `qwen agents attach` cannot
 * respawn a second worker underneath the live foreground runtime.
 */
export async function releaseExitedManagedSessionForContinue(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // Same strict predicate as the /resume block: a lone marker must not
  // suppress the release in an ordinary foreground session.
  if (readAgentViewWorkerSidebandEnv(env) !== undefined) return;
  const state = await readAgentViewSessionState(sessionId);
  if (state?.ownership !== 'managed' || state.processState !== 'exited') {
    return;
  }
  await patchAgentViewSessionState(sessionId, {
    ownership: 'unmanaged',
    updatedAt: new Date().toISOString(),
  });
}

export function isAgentViewWorkerResumeCommandBlocked(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Require the full sideband env, not a lone QWEN_AGENT_VIEW_WORKER=1: a
  // stray marker (shell-profile export, leftover experiment) must not
  // disable /resume in an ordinary foreground session.
  return readAgentViewWorkerSidebandEnv(env) !== undefined;
}
