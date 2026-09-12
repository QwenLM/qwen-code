/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ThreadRun } from './types.js';
import { listThreads } from './store.js';

/**
 * Run statuses that mean the dispatcher still owns this session.
 *
 * A run that reached a terminal status released its session: resuming it as an
 * agent would hand an agent's persona and tool surface to a session nothing is
 * currently dispatching. `finishing` and `cancelling` stay live because the
 * two-write close leaves a window where the thread tool has marked the run but
 * the dispatcher has not yet written the terminal status.
 *
 * `queued` is deliberately absent. A queued run has not been claimed, so no
 * session should exist for it — and `reserveRunSession` only ever names a
 * session on a run already claimed into `running`. Admitting `queued` would
 * turn a run that was started and then released back into the queue, with its
 * reserved id still on it, into a standing authorization.
 */
const LIVE_RUN_STATUSES: ReadonlySet<ThreadRun['status']> = new Set([
  'running',
  'finishing',
  'cancelling',
]);

export interface AgentSessionBinding {
  agentId: string;
  threadId: string;
  runId: string;
  status: ThreadRun['status'];
}

/**
 * Answer "is this session genuinely one the dispatcher started for this agent?"
 * by reading the store, not by trusting the caller.
 *
 * `sourceType: 'agent'` arrives on the session-creation request, so any client
 * with daemon access can set it. Attribution is not authorization: what makes a
 * session an agent's is that a live run in this workspace names it as its
 * `sessionId`. This is the "server binding" the architecture relies on, and it
 * holds whether or not the collaboration opt-in is on — the opt-in decides
 * whether the feature exists at all, this decides who may speak as an agent.
 *
 * Returns the binding when one exists, `undefined` otherwise. A caller that
 * gets `undefined` must refuse, not downgrade to an ordinary session: a
 * downgrade would leave the client believing it holds an agent session.
 */
export async function findAgentSessionBinding(
  projectRoot: string,
  // Accepts `undefined` on purpose: a session with no id cannot be named by any
  // run, so the caller's "no binding, refuse" path is the right answer for it
  // too, and callers do not need a second check for the same conclusion.
  sessionId: string | undefined,
  agentId: string,
): Promise<AgentSessionBinding | undefined> {
  if (!sessionId || !agentId) return undefined;
  const { threads } = await listThreads(projectRoot);
  for (const thread of threads) {
    for (const run of thread.runs) {
      if (run.sessionId !== sessionId) continue;
      if (run.agentId !== agentId) continue;
      if (!LIVE_RUN_STATUSES.has(run.status)) continue;
      return {
        agentId: run.agentId,
        threadId: thread.id,
        runId: run.id,
        status: run.status,
      };
    }
  }
  return undefined;
}
