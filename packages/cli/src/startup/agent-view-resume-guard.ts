/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  readAgentViewSessionState,
  sanitizeSessionId,
} from '../agent-view/supervisor-store.js';
import { requireValidWorkerToken } from '../agent-view/supervisor-process.js';
import { ensureAgentViewSupervisor } from '../agent-view/supervisor-runner.js';
import { readAgentViewWorkerSidebandEnv } from '../agent-view/worker-sideband.js';

export const MANAGED_AGENT_VIEW_RESUME_MESSAGE =
  'That session is still running as a background agent. Open `qwen agents` to attach to it, or remove it from Agent View first to resume here.';

export const AGENT_VIEW_WORKER_RESUME_MESSAGE =
  'Resume is disabled inside an attached background agent. Detach to `qwen agents` and use `/resume` there.';

export const MANAGED_AGENT_VIEW_ONE_SHOT_RESUME_MESSAGE =
  'Cannot use one-shot input (-p/--prompt, -i, --input-file, --fork-session, or piped stdin) with --resume of a session that is still running as a background agent. Use `qwen agents attach <id>` to interact with it instead.';

async function isSessionWorker(
  sessionId: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const sideband = readAgentViewWorkerSidebandEnv(env);
  if (
    !sideband ||
    sanitizeSessionId(sideband.sessionId) !== sanitizeSessionId(sessionId)
  ) {
    return false;
  }
  try {
    await requireValidWorkerToken(sessionId, { token: sideband.token }, {});
    return true;
  } catch {
    return false;
  }
}

export async function isManagedAgentViewResumeBlocked(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (await isSessionWorker(sessionId, env)) return false;
  const state = await readAgentViewSessionState(sessionId);
  // Block during ownership transitions too: /background adopt writes
  // 'adopting', spawns the --resume worker, and only patches 'managed'
  // afterwards; 'removing' may still have a live host or durable cleanup to
  // finish. A concurrent foreground resume would race either transition.
  return (
    state?.ownership === 'managed' ||
    state?.ownership === 'adopting' ||
    state?.ownership === 'removing'
  );
}

/**
 * `--continue` releases an exited managed session through the supervisor
 * before resuming it in the foreground. Block live sessions and ownership
 * transitions; callers may explicitly retry an interrupted removal through
 * the release RPC below.
 */
export async function isManagedAgentViewContinueBlocked(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (await isSessionWorker(sessionId, env)) return false;
  const state = await readAgentViewSessionState(sessionId);
  return (
    (state?.ownership === 'managed' &&
      state.processState !== 'exited' &&
      state.processState !== 'hibernated') ||
    state?.ownership === 'adopting' ||
    state?.ownership === 'removing'
  );
}

/**
 * When the foreground `--continue` path takes over an exited managed
 * session, drop the roster ownership so a later `qwen agents attach` cannot
 * respawn a second worker underneath the live foreground runtime.
 */
export async function releaseExitedManagedSessionForContinue(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  agentViewEnabled = true,
): Promise<boolean> {
  // Same strict predicate as the /resume block: a lone marker must not
  // suppress the release in an ordinary foreground session.
  if (await isSessionWorker(sessionId, env)) return true;
  const state = await readAgentViewSessionState(sessionId);
  if (state?.ownership === 'adopting') return false;
  if (state?.ownership !== 'managed' && state?.ownership !== 'removing') {
    return true;
  }
  if (
    state.ownership === 'managed' &&
    state.processState !== 'exited' &&
    state.processState !== 'hibernated'
  ) {
    return false;
  }
  if (!agentViewEnabled) return false;
  try {
    const result = await (await ensureAgentViewSupervisor()).release(sessionId);
    return (
      typeof result === 'object' &&
      result !== null &&
      'released' in result &&
      result.released === true
    );
  } catch (error) {
    if (isRetryableReleaseError(error)) {
      throw error;
    }
    return false;
  }
}

function isRetryableReleaseError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes('temporarily unreadable')
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
