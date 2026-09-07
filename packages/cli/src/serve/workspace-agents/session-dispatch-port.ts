/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The dispatcher's port, backed by one session process per agent.
 *
 * This is the whole of the execution-model change. The dispatcher's rules, its
 * twelve admission outcomes and every state it records are unchanged, because
 * the port was always the only thing that knew what a body is. What changes is
 * the answer: a body used to be a background subagent inside one shared host
 * process, and is now a session of its own.
 *
 * Why that matters beyond tidiness: N agents sharing one process share one
 * crash, one memory ceiling and one model client. Multica's agents are
 * separate runtimes for the same reason, and the roster in the UI only tells
 * the truth if the isolation behind it is real.
 *
 * The port lives in the daemon rather than in core because only the daemon
 * holds the session bridge. It carries no rules of its own: everything it
 * returns is one of the outcomes the dispatcher already knows.
 */

import type {
  AgentBodyState,
  AgentDispatchPort,
  AgentStartResult,
  WorkspaceAgent,
} from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import {
  AGENT_SESSION_SOURCE_TYPE,
  agentSessionId,
} from '../../runtime/agent-session-source.js';

/** What the port needs from the bridge, so a test can supply four functions. */
export type AgentSessionBridge = Pick<
  AcpSessionBridge,
  | 'spawnOrAttach'
  | 'sendPrompt'
  | 'listWorkspaceSessions'
  | 'cancelSession'
  | 'getSessionStatsStatus'
>;

export interface CreateSessionDispatchPortInput {
  bridge: AgentSessionBridge;
  workspaceCwd: string;
}

/**
 * Finds this agent's session, if the bridge is holding one.
 *
 * Matched on `sourceId` rather than on the session id, because the id is a
 * convention and the source is the record. A session the bridge lost is simply
 * absent, which is the same answer the dispatcher wants for an agent that has
 * never run.
 */
function sessionFor(
  bridge: AgentSessionBridge,
  workspaceCwd: string,
  agent: WorkspaceAgent,
) {
  return bridge
    .listWorkspaceSessions(workspaceCwd)
    .find(
      (session) =>
        session.sourceType === AGENT_SESSION_SOURCE_TYPE &&
        session.sourceId === agent.id,
    );
}

export function createSessionDispatchPort(
  input: CreateSessionDispatchPortInput,
): AgentDispatchPort {
  const { bridge, workspaceCwd } = input;

  const send = async (
    sessionId: string,
    prompt: string,
    deliveryId: string,
  ): Promise<void> => {
    await bridge.sendPrompt(
      sessionId,
      {
        sessionId,
        prompt: [{ type: 'text', text: prompt }],
      } as Parameters<AgentSessionBridge['sendPrompt']>[1],
      undefined,
      { promptId: deliveryId },
    );
  };

  return {
    async inspect(agent): Promise<AgentBodyState> {
      const session = sessionFor(bridge, workspaceCwd, agent);
      if (!session) return { kind: 'absent' };
      // A session with a prompt in flight is working. One that is idle is
      // ready for the next turn — which is what `completed` means to the
      // dispatcher, and why there is no `paused` here: a session process is
      // either alive or gone, with nothing in between for the bridge to hold.
      return session.hasActivePrompt
        ? { kind: 'running' }
        : { kind: 'completed' };
    },

    async start({ agent, prompt, runId }): Promise<AgentStartResult> {
      try {
        // Spawn-or-attach is idempotent on the deterministic id, so `launch`,
        // `resume` and `continue_completed` collapse into one call: the three
        // were only ever distinct because a background registry held three
        // different kinds of remains. A process is there or it is not.
        const session = await bridge.spawnOrAttach({
          workspaceCwd,
          sessionId: agentSessionId(agent.id),
          sourceType: AGENT_SESSION_SOURCE_TYPE,
          sourceId: agent.id,
          sessionScope: 'thread',
        });
        await send(session.sessionId, prompt, runId);
        return {
          status: 'started',
          sessionId: session.sessionId,
          // The turn's opening prompt is in the session's own history the
          // moment `sendPrompt` accepts it, so the delivery is consumed here
          // rather than waiting for an event that will not come.
          consumedOnStart: true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A persona that will not resolve fails the spawn by design — the
        // child refuses rather than booting a generic assistant under this
        // agent's name — and that is a configuration error, not a crash.
        const unavailable =
          message.includes('roster') ||
          message.includes('definition') ||
          message.includes('disabled');
        return unavailable
          ? { status: 'agent_unavailable', error: message }
          : { status: 'launch_failed', error: message, failureStage: 'launch' };
      }
    },

    async deliver({ agent, prompt, deliveryId }): Promise<boolean> {
      const session = sessionFor(bridge, workspaceCwd, agent);
      if (!session) return false;
      try {
        await send(session.sessionId, prompt, deliveryId);
        return true;
      } catch {
        // A refused delivery is a miss, not a failure: the run's terminal
        // write rebooks whatever it never read, so this costs latency and
        // never a message.
        return false;
      }
    },

    async totalTokens(agent): Promise<number | undefined> {
      const session = sessionFor(bridge, workspaceCwd, agent);
      if (!session) return undefined;
      try {
        const stats = await bridge.getSessionStatsStatus(session.sessionId);
        // Summed across models: an agent may switch model mid-life, and the
        // budget is money rather than a per-model quota.
        return Object.values(stats.models).reduce(
          (total, model) => total + (model.tokens?.total ?? 0),
          0,
        );
      } catch {
        // A body that cannot be read has not spent anything this pass. The
        // gate under-counts rather than blocking work on a failed probe.
        return undefined;
      }
    },

    async cancel({ agent }): Promise<boolean> {
      const session = sessionFor(bridge, workspaceCwd, agent);
      if (!session) return false;
      try {
        await bridge.cancelSession(session.sessionId);
        return true;
      } catch {
        return false;
      }
    },
  };
}
