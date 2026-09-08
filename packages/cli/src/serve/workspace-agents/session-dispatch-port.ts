/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The dispatcher's port, backed by one ACP session per agent.
 *
 * This is the whole of the execution-model change. The dispatcher's rules, its
 * twelve admission outcomes and every state it records are unchanged, because
 * the port was always the only thing that knew what a body is. What changes is
 * the answer: a body used to be a background subagent inside one shared host
 * process, and is now a session of its own.
 *
 * Sessions currently share the bridge's ACP process. Separate session identity
 * is not process isolation.
 *
 * The port lives in the daemon rather than in core because only the daemon
 * holds the session bridge. It carries no rules of its own: everything it
 * returns is one of the outcomes the dispatcher already knows.
 */

import { getErrorMessage, SessionService } from '@qwen-code/qwen-code-core';
import type {
  AgentBodyState,
  AgentDispatchPort,
  AgentStartResult,
  AgentRunContext,
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
  | 'resumeSession'
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
  const executions = new Map<string, AgentBodyState>();
  const sessions = new SessionService(workspaceCwd);

  /**
   * Sends one turn to an agent's session, saying which run it is a turn of.
   *
   * `agentRun` is the whole reason the child can act. The envelope names the
   * thread in prose, but prose is not something the thread tools can trust or
   * parse; this is the structured half, and the bridge treats it as trusted
   * daemon metadata, stripping the same key from every other caller. Without
   * it the child boots with the right persona and then cannot post, because
   * every thread tool requires a run frame this is the only source of.
   */
  const send = async (
    sessionId: string,
    prompt: string,
    deliveryId: string,
    agentRun: AgentRunContext,
  ): Promise<void> => {
    await bridge.sendPrompt(
      sessionId,
      {
        sessionId,
        prompt: [{ type: 'text', text: prompt }],
      } as Parameters<AgentSessionBridge['sendPrompt']>[1],
      undefined,
      {
        promptId: deliveryId,
        agentRun: {
          workspaceId: agentRun.workspaceId,
          agentId: agentRun.agentId,
          runId: agentRun.runId,
          threadId: agentRun.threadId,
          rootThreadId: agentRun.rootThreadId,
          attempt: agentRun.attempt,
          ...(agentRun.contextThroughSequence !== undefined
            ? { contextThroughSequence: agentRun.contextThroughSequence }
            : {}),
        },
      },
    );
  };

  return {
    async inspect(agent): Promise<AgentBodyState> {
      const execution = executions.get(agent.id);
      if (execution) return execution;
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

    async start({
      agent,
      prompt,
      runId,
      workspaceId,
      threadId,
      rootThreadId,
      attempt,
      contextThroughSequence,
    }): Promise<AgentStartResult> {
      try {
        let session: { sessionId: string } | undefined = sessionFor(
          bridge,
          workspaceCwd,
          agent,
        );
        if (!session) {
          const request = {
            workspaceCwd,
            sessionId: agentSessionId(agent.id),
            sourceType: AGENT_SESSION_SOURCE_TYPE,
            sourceId: agent.id,
          };
          session = (await sessions.sessionExists(request.sessionId))
            ? await bridge.resumeSession(request)
            : await bridge.spawnOrAttach({ ...request, sessionScope: 'thread' });
        }
        const context: AgentRunContext = {
          workspaceId,
          agentId: agent.id,
          runId,
          threadId,
          rootThreadId,
          attempt,
          contextThroughSequence,
        };
        const sessionId = session.sessionId;
        return {
          status: 'started',
          sessionId,
          consumedOnStart: true,
          activate() {
            const execution: AgentBodyState = {
              kind: 'running',
              threadId,
              runId,
              attempt,
            };
            executions.set(agent.id, execution);
            // sendPrompt resolves at turn completion, not queue acceptance.
            // Keep dispatch free to start peers and service cancellation.
            void send(sessionId, prompt, runId, context).then(
              () => {
                if (executions.get(agent.id) === execution) {
                  executions.delete(agent.id);
                }
              },
              (error: unknown) => {
                if (executions.get(agent.id) !== execution) return;
                executions.set(agent.id, {
                  kind: 'failed',
                  runId,
                  attempt,
                  error: getErrorMessage(error),
                });
              },
            );
          },
        };
      } catch (error) {
        const message = getErrorMessage(error);
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

    async deliver(): Promise<boolean> {
      // sendPrompt queues another whole turn, not an input to the active one.
      // Let the dispatcher durably rebook the reply until mid-turn drain
      // acknowledgements are connected to the run's delivery watermark.
      return false;
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
