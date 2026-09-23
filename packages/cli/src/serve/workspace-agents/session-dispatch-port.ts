/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The dispatcher's port, backed by one ACP session per agent and thread.
 *
 * Agent identity is workspace-scoped; conversation state is task-scoped. Runs
 * by the same agent on the same thread resume one session, while another thread
 * gets another session and may execute concurrently.
 *
 * Sessions currently share the bridge's ACP process. Separate session identity
 * is not process isolation.
 *
 * The port lives in the daemon rather than in core because only the daemon
 * holds the session bridge. It carries no rules of its own: everything it
 * returns is one of the outcomes the dispatcher already knows.
 */

import { getErrorMessage } from '@qwen-code/qwen-code-core/utils/errors.js';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import { withAgentStoreTransaction } from '@qwen-code/qwen-code-core/agents/workspace-agents/store.js';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  AgentBodyState,
  AgentDispatchPort,
  AgentStartResult,
  AgentRunContext,
  WorkspaceAgent,
} from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { streamAgentTurn } from './stream-agent-turn.js';
import {
  publishAgentEvent,
  type AgentPermissionPrompt,
} from './agent-events.js';
import {
  AGENT_SESSION_SOURCE_TYPE,
  agentThreadSessionId,
} from '../../runtime/agent-session-source.js';

/** How often a running agent's snapshot is saved for page reloads. */
const PROGRESS_SAVE_MS = 3_000;
/** Streamed text is coalesced to at most one browser frame per this long. */
const PROGRESS_PUBLISH_MS = 100;
/**
 * A run with no agent activity for this long (and no person to wait on) is
 * cancelled. The client warns much earlier, from `activityAt`.
 * ponytail: one deadline for model and tools alike, so a single tool that is
 * silent for 15 minutes (a very long build) is stopped too; give tools their
 * own deadline if that bites.
 */
export const AGENT_RUN_STALL_TIMEOUT_MS = 15 * 60_000;
/** Error recorded on a run the stall timeout stopped; the client localizes it. */
export const AGENT_RUN_STALLED_ERROR = 'agent_run_stalled';

/** What the port needs from the bridge, so a test can supply four functions. */
export type AgentSessionBridge = Pick<
  AcpSessionBridge,
  | 'spawnOrAttach'
  | 'resumeSession'
  | 'sendPrompt'
  | 'enqueueMidTurnMessage'
  | 'listWorkspaceSessions'
  | 'cancelSession'
  | 'getSessionStatsStatus'
> &
  Partial<
    Pick<
      AcpSessionBridge,
      'updateSessionMetadata' | 'getSessionTurnStatus' | 'subscribeEvents'
    >
  >;

export interface CreateSessionDispatchPortInput {
  bridge: AgentSessionBridge;
  workspaceCwd: string;
}

/**
 * Finds this agent's session for one thread, if the bridge is holding it.
 *
 * Both source attribution and the task session id must match. Source attribution
 * identifies the persona; the id prevents another thread for that persona from
 * being mistaken for this one.
 */
function sessionFor(
  bridge: AgentSessionBridge,
  workspaceCwd: string,
  agent: WorkspaceAgent,
  threadId: string,
  sessionId?: string,
) {
  const expected = sessionId ?? agentThreadSessionId(agent.id, threadId);
  return bridge
    .listWorkspaceSessions(workspaceCwd)
    .find(
      (session) =>
        session.sourceType === AGENT_SESSION_SOURCE_TYPE &&
        session.sourceId === agent.id &&
        session.sessionId === expected,
    );
}

export function createSessionDispatchPort(
  input: CreateSessionDispatchPortInput,
): AgentDispatchPort {
  const { bridge, workspaceCwd } = input;
  const executions = new Map<string, AgentBodyState>();
  const sessions = new SessionService(workspaceCwd);

  async function waitForTurn(
    sessionId: string,
    promptId: string,
    liveness?: { activityAt(): number; waitingOnPerson(): boolean },
  ): Promise<void> {
    const getSessionTurnStatus = bridge.getSessionTurnStatus;
    if (!getSessionTurnStatus) return;
    // ACP sendPrompt acknowledges admission; the turn terminal arrives on the
    // bridge afterwards. Keep the dispatcher claim alive until that terminal
    // is visible, otherwise a live body can be closed while calling a thread
    // tool.
    for (;;) {
      const status = await getSessionTurnStatus(sessionId, undefined, promptId);
      if (
        status?.promptId === promptId &&
        (status.state === 'completed' ||
          status.state === 'cancelled' ||
          status.state === 'error')
      ) {
        if (status.state === 'error') {
          throw new Error(status.error?.message ?? 'Agent turn failed.');
        }
        return;
      }
      // An agent waiting on a person is not stuck; everything else that goes
      // quiet this long is, and holding its slot forever blocks the thread.
      if (
        liveness &&
        !liveness.waitingOnPerson() &&
        Date.now() - liveness.activityAt() >= AGENT_RUN_STALL_TIMEOUT_MS
      ) {
        await bridge.cancelSession(sessionId).catch(() => {});
        throw new Error(AGENT_RUN_STALLED_ERROR);
      }
      await delay(250);
    }
  }

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
    const controller = new AbortController();
    let progress: {
      attempt: number;
      sequence: number;
      stage: string;
      detail: string;
      outputText: string;
      thoughtText: string;
      permission?: AgentPermissionPrompt;
    } = {
      attempt: agentRun.attempt,
      sequence: 1,
      stage: 'starting',
      detail: '',
      outputText: '',
      thoughtText: '',
    };
    let activityAt = Date.now();
    // Streamed text goes to the browser as it arrives (throttled to one frame
    // per PROGRESS_PUBLISH_MS). Disk only keeps a slower snapshot so a page
    // that reloads mid-run can show where the agent got to.
    let publishTimer: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      publishTimer ??= setTimeout(() => {
        publishTimer = undefined;
        publishAgentEvent(workspaceCwd, {
          type: 'progress',
          threadId: agentRun.threadId,
          runId: agentRun.runId,
          attempt: agentRun.attempt,
          sessionId,
          stage: progress.stage,
          detail: progress.detail,
          outputText: progress.outputText,
          thoughtText: progress.thoughtText,
          activityAt,
          ...(progress.permission ? { permission: progress.permission } : {}),
        });
      }, PROGRESS_PUBLISH_MS);
    };
    let saving: Promise<unknown> | undefined;
    const flush = () => {
      if (!bridge.subscribeEvents) return Promise.resolve();
      if (saving) return saving;
      const snapshot = { ...progress };
      saving = withAgentStoreTransaction(workspaceCwd, async (transaction) => {
        const thread = await transaction.readThread(agentRun.threadId);
        const run = thread?.runs.find((r) => r.id === agentRun.runId);
        if (
          !thread ||
          !run ||
          run.status !== 'running' ||
          run.attempts !== agentRun.attempt ||
          run.agentId !== agentRun.agentId ||
          run.sessionId !== sessionId
        )
          return;
        if (run.progress?.sequence === snapshot.sequence) return;
        run.progress = {
          ...snapshot,
          receivedAt: Date.now(),
          activityAt,
        };
        await transaction.writeThread(thread);
      }).finally(() => {
        saving = undefined;
      });
      return saving;
    };
    const stream = bridge.subscribeEvents
      ? streamAgentTurn(
          { subscribeEvents: bridge.subscribeEvents },
          sessionId,
          deliveryId,
          controller.signal,
          (
            stage,
            detail,
            outputText = progress.outputText,
            thoughtText = progress.thoughtText,
            permission,
          ) => {
            activityAt = Date.now();
            const { permission: previousPermission, ...rest } = progress;
            const nextPermission =
              permission === null
                ? undefined
                : (permission ?? previousPermission);
            progress = {
              ...rest,
              sequence: progress.sequence + 1,
              stage,
              // Tool updates often carry no title; keep the one that did.
              detail: (
                detail || (stage === rest.stage ? rest.detail : '')
              ).slice(0, 1200),
              outputText: outputText.slice(0, 262144),
              thoughtText: thoughtText.slice(0, 65536),
              ...(nextPermission ? { permission: nextPermission } : {}),
            };
            publish();
            // An approval is the one update a person is waiting to act on.
            if (permission !== undefined) void flush().catch(() => {});
          },
        ).catch(() => {
          progress = {
            ...progress,
            sequence: progress.sequence + 1,
            stage: 'stream_lost',
          };
          publish();
        })
      : undefined;
    const timer = setInterval(() => {
      void flush().catch(() => {});
    }, PROGRESS_SAVE_MS);
    try {
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
      await waitForTurn(
        sessionId,
        deliveryId,
        stream
          ? {
              activityAt: () => activityAt,
              waitingOnPerson: () => progress.permission !== undefined,
            }
          : undefined,
      );
    } finally {
      clearInterval(timer);
      if (publishTimer) clearTimeout(publishTimer);
      controller.abort();
      await stream;
      await saving?.catch(() => {});
      await flush().catch(() => {});
    }
  };

  return {
    // Same rule `start` applies below, asked ahead of time so the dispatcher
    // can name the session on the run before the runtime creates it.
    plannedSessionId({ agent, threadId, sessionId }): string | undefined {
      return sessionId ?? agentThreadSessionId(agent.id, threadId);
    },

    async inspect({ agent, threadId, sessionId }): Promise<AgentBodyState> {
      const expected = sessionId ?? agentThreadSessionId(agent.id, threadId);
      const execution = executions.get(expected);
      if (execution) return execution;
      const session = sessionFor(
        bridge,
        workspaceCwd,
        agent,
        threadId,
        sessionId,
      );
      if (!session) return { kind: 'absent' };
      // A session with a prompt in flight is working. One that is idle is
      // ready for the next turn — which is what `completed` means to the
      // dispatcher.
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
      threadTitle,
      rootThreadId,
      attempt,
      contextThroughSequence,
      sessionId: priorSessionId,
    }): Promise<AgentStartResult> {
      try {
        let session: { sessionId: string } | undefined = sessionFor(
          bridge,
          workspaceCwd,
          agent,
          threadId,
          priorSessionId,
        );
        if (!session) {
          const request = {
            workspaceCwd,
            sessionId:
              priorSessionId ?? agentThreadSessionId(agent.id, threadId),
            sourceType: AGENT_SESSION_SOURCE_TYPE,
            sourceId: agent.id,
          };
          session = (await sessions.sessionExists(request.sessionId))
            ? await bridge.resumeSession(request)
            : await bridge.spawnOrAttach({
                ...request,
                sessionScope: 'thread',
              });
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
        const summary = sessionFor(
          bridge,
          workspaceCwd,
          agent,
          threadId,
          sessionId,
        );
        if (summary?.titleSource !== 'manual') {
          bridge.updateSessionMetadata?.(sessionId, {
            displayName: `${agent.name} · ${threadTitle}`.slice(0, 256),
            titleSource: 'auto',
          });
        }
        return {
          status: 'started',
          sessionId,
          activate() {
            const execution: AgentBodyState = {
              kind: 'running',
              threadId,
              runId,
              attempt,
            };
            executions.set(sessionId, execution);
            // Wait for this attempt's terminal while dispatch services peers.
            void send(sessionId, prompt, `${runId}:${attempt}`, context).then(
              () => {
                if (executions.get(sessionId) === execution) {
                  executions.delete(sessionId);
                }
              },
              (error: unknown) => {
                if (executions.get(sessionId) !== execution) return;
                executions.set(sessionId, {
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

    async deliver({
      agent,
      prompt,
      deliveryId,
      sessionId,
      ...context
    }): Promise<boolean> {
      const expected =
        sessionId ?? agentThreadSessionId(agent.id, context.threadId);
      const execution = executions.get(expected);
      const session = sessionFor(
        bridge,
        workspaceCwd,
        agent,
        context.threadId,
        sessionId,
      );
      if (
        !session ||
        execution?.kind !== 'running' ||
        execution.threadId !== context.threadId ||
        execution.runId !== context.runId ||
        execution.attempt !== context.attempt
      ) {
        return false;
      }
      return bridge.enqueueMidTurnMessage(
        session.sessionId,
        prompt,
        { agentRun: { ...context, agentId: agent.id } },
        deliveryId,
        { queueOnly: true },
      ).accepted;
    },

    async totalTokens({
      agent,
      threadId,
      sessionId,
    }): Promise<number | undefined> {
      const session = sessionFor(
        bridge,
        workspaceCwd,
        agent,
        threadId,
        sessionId,
      );
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

    async cancel({
      agent,
      threadId,
      runId,
      attempt,
      sessionId,
    }): Promise<boolean> {
      const expected = sessionId ?? agentThreadSessionId(agent.id, threadId);
      const execution = executions.get(expected);
      if (
        execution?.kind !== 'running' ||
        execution.threadId !== threadId ||
        execution.runId !== runId ||
        execution.attempt !== attempt
      ) {
        return false;
      }
      const session = sessionFor(
        bridge,
        workspaceCwd,
        agent,
        threadId,
        sessionId,
      );
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
