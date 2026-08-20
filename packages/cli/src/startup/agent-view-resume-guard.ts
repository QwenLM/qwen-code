/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  patchAgentViewSessionStateIf,
  readAgentViewSessionState,
  readAgentViewSessionStateStrict,
  sanitizeSessionId,
} from '../agent-view/supervisor-store.js';
import { readAgentViewWorkerSidebandEnv } from '../agent-view/worker-sideband.js';

export const MANAGED_AGENT_VIEW_RESUME_MESSAGE =
  'That session is still running as a background agent. Open `qwen agents` to attach to it, or remove it from Agent View first to resume here.';

export const AGENT_VIEW_WORKER_RESUME_MESSAGE =
  'Resume is disabled inside an attached background agent. Detach to `qwen agents` and use `/resume` there.';

export const MANAGED_AGENT_VIEW_ONE_SHOT_RESUME_MESSAGE =
  'Cannot use one-shot input (-p/--prompt, -i, --input-file, --fork-session, or piped stdin) with --resume of a session that is still running as a background agent. Use `qwen agents attach <id>` to interact with it instead.';

export const MANAGED_AGENT_VIEW_DELETE_MESSAGE =
  'That session is still running as a background agent. Stop or remove it from `qwen agents` before deleting it here.';

// The worker-env bypass is load-bearing (respawned workers resume their own
// session), so require the full sideband env plus a matching session id —
// both production spawn paths build env via createAgentViewWorkerSidebandEnv,
// while a pasted/stray marker+id pair must not defeat the guard.
function isSessionWorker(sessionId: string, env: NodeJS.ProcessEnv): boolean {
  const workerSessionId = readAgentViewWorkerSidebandEnv(env)?.sessionId;
  return (
    workerSessionId !== undefined &&
    sanitizeSessionId(workerSessionId) === sanitizeSessionId(sessionId)
  );
}

export async function isManagedAgentViewResumeBlocked(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (isSessionWorker(sessionId, env)) return false;
  const state = await readAgentViewSessionState(sessionId);
  // Block during the 'adopting' window too: /background adopt writes
  // 'adopting', spawns the --resume worker, and only patches 'managed'
  // afterwards — a concurrent foreground resume would double-run the session.
  return state?.ownership === 'managed' || state?.ownership === 'adopting';
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
  return (
    (state?.ownership === 'managed' &&
      state.processState !== 'exited' &&
      state.processState !== 'hibernated') ||
    state?.ownership === 'adopting'
  );
}

/**
 * `/delete` removes transcripts, archives and file-history backups, so a
 * managed session that is still alive must not be deletable mid-run. An
 * exited managed session has no live writer and is safe to delete.
 */
export async function isManagedAgentViewDeleteBlocked(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (isSessionWorker(sessionId, env)) return false;
  try {
    const state = await readAgentViewSessionStateStrict(sessionId);
    return (
      (state?.ownership === 'managed' && state.processState !== 'exited') ||
      state?.ownership === 'adopting'
    );
  } catch {
    return true;
  }
}

/**
 * When the foreground `--continue` path takes over an exited managed
 * session, drop the roster ownership so a later `qwen agents attach` cannot
 * respawn a second worker underneath the live foreground runtime.
 */
export async function releaseExitedManagedSessionForContinue(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  // Same strict predicate as the /resume block: a lone marker must not
  // suppress the release in an ordinary foreground session.
  if (isSessionWorker(sessionId, env)) return true;
  const state = await readAgentViewSessionState(sessionId);
  if (state?.ownership === 'adopting') return false;
  if (state?.ownership !== 'managed') {
    return true;
  }
  if (state.processState !== 'exited' && state.processState !== 'hibernated') {
    return false;
  }
  return patchAgentViewSessionStateIf(sessionId, (current) =>
    current.ownership === 'managed' &&
    (current.processState === 'exited' || current.processState === 'hibernated')
      ? {
          ownership: 'unmanaged',
          updatedAt: new Date().toISOString(),
        }
      : undefined,
  );
}

export function isAgentViewWorkerResumeCommandBlocked(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Require the full sideband env, not a lone QWEN_AGENT_VIEW_WORKER=1: a
  // stray marker (shell-profile export, leftover experiment) must not
  // disable /resume in an ordinary foreground session.
  return readAgentViewWorkerSidebandEnv(env) !== undefined;
}
