/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The `qwen` program adapter: one hidden ACP session per
 * (chat session, agent) on this daemon's own bridge.
 *
 * Reuses the patterns of the thread-era `session-dispatch-port.ts` and
 * `stream-agent-turn.ts`: create or resume a hidden `sourceType: 'agent'`
 * session under a deterministic id, send the turn with `sendPrompt`, follow
 * it on `subscribeEvents`, and wait for the bridge's turn terminal. The child
 * resolves the agent's persona itself (from `sourceId`) and authorizes the
 * session against the session-agents binding the orchestrator persisted
 * before calling this adapter, so `instructions` / `model` on the turn input
 * are not used here.
 *
 * `session_send`: the hidden session outlives a run, and an ACP session's
 * MCP servers are fixed when it is created (`mcpServers` on the bridge's
 * spawn / resume request), so the tool's bearer token belongs to the
 * (chat session, agent) binding, not the run. The orchestrator hands
 * {@link QwenAcpAdapterOptions.sessionSend}: `rotate()` mints a fresh token
 * whenever this adapter (re)creates the session, and `isCurrent()` reports
 * whether the orchestrator still holds the binding's token; a live session
 * whose token is gone (the orchestrator was rebuilt on the same bridge) is
 * closed and reloaded so its server carries a valid one. The send route
 * then resolves the post to the agent's CURRENT live run. The turn input's
 * per-run `sessionSendServer` is not used here.
 *
 * Stop: `sendPrompt` resolves only when the turn ends, so the run's signal
 * is handed to it (the bridge then forwards the cancel to the child) and
 * raced against it. On abort the adapter cancels the session, refuses every
 * permission request still open or arriving later (an unanswered request
 * would keep the native turn from winding down), and waits a bounded time
 * for the turn's terminal before it reports `cancelled`.
 *
 * Hidden sessions are closed after {@link QWEN_AGENT_SESSION_IDLE_CLOSE_MS}
 * idle so they do not exhaust the bridge's `maxSessions`.
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import { extractErrorMessage } from '@qwen-code/acp-bridge/bridge';
import type {
  AgentAdapter,
  AgentAdapterTurnInput,
  AgentAdapterTurnResult,
  SessionAgentPermissionPrompt,
  SessionAgentStep,
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import type {
  AcpSessionBridge,
  BridgeClientRequestContext,
} from '../../acp-session-bridge.js';
import { AGENT_SESSION_SOURCE_TYPE } from '../../../runtime/agent-session-source.js';

/** Idle time after which a hidden agent session is closed. */
export const QWEN_AGENT_SESSION_IDLE_CLOSE_MS = 10 * 60_000;
const TURN_POLL_MS = 250;
/** How long a stopped turn is given to reach its terminal. */
export const QWEN_AGENT_CANCEL_SETTLE_MS = 5_000;
const MAX_INPUT_PREVIEW_CHARS = 2_000;
const MAX_STEP_TITLE_CHARS = 200;
/** A permission prompt's title, as the other adapters clip theirs. */
const MAX_PERMISSION_TITLE_CHARS = 200;

export type QwenAcpAdapterBridge = Pick<
  AcpSessionBridge,
  | 'spawnOrAttach'
  | 'resumeSession'
  | 'sendPrompt'
  | 'listWorkspaceSessions'
  | 'cancelSession'
  | 'closeSession'
  | 'subscribeEvents'
  | 'getSessionTurnStatus'
  | 'respondToSessionPermission'
  | 'getSessionStatsStatus'
>;

export interface QwenAcpAdapterOptions {
  bridge: QwenAcpAdapterBridge;
  workspaceCwd: string;
  /** `WorkspaceAgent.id`; the hidden session's `sourceId`. */
  agentId: string;
  /**
   * Context for the vote the adapter casts on the user's behalf, so a
   * `local-only` permission policy sees the real voter's loopback bit rather
   * than a spoofed one. Returns undefined when unknown (the vote is then cast
   * without context, which `local-only` refuses).
   */
  permissionVoteContext?: (
    requestId: string,
  ) => BridgeClientRequestContext | undefined;
  idleCloseMs?: number;
  /** See {@link QWEN_AGENT_CANCEL_SETTLE_MS}. */
  cancelSettleMs?: number;
  /** See the file header. Absent means the session gets no `session_send`. */
  sessionSend?: QwenSessionSendBinding;
  /** Test seam. */
  sessionExists?: (sessionId: string) => Promise<boolean>;
}

/** The `session_send` token of one (chat session, agent) binding. */
export interface QwenSessionSendBinding {
  /** False when a live session may carry a token the daemon no longer holds. */
  isCurrent(): boolean;
  /**
   * Mints the binding's next token and returns the stdio server that carries
   * it, or undefined when this daemon cannot offer the tool.
   */
  rotate(): AgentAdapterTurnInput['sessionSendServer'];
}

/**
 * ACP `mcpServers[].name` of the `session_send` server (the tool prefix).
 * TODO(multi-agent): model-facing — offering `session_send` to qwen agents
 * (tool name and description) needs eval before release.
 */
export const SESSION_SEND_MCP_SERVER_NAME = 'qwen_session';

/** The contract's stdio server as an ACP `McpServerStdio` (env is required). */
export function toAcpStdioServer(
  server: NonNullable<AgentAdapterTurnInput['sessionSendServer']>,
): {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
} {
  return {
    name: SESSION_SEND_MCP_SERVER_NAME,
    command: server.command,
    args: [...server.args],
    env: Object.entries(server.env ?? {}).map(([name, value]) => ({
      name,
      value,
    })),
  };
}

/** Idle-close timers, shared by every adapter instance on one bridge. */
const idleTimers = new WeakMap<
  QwenAcpAdapterBridge,
  Map<string, ReturnType<typeof setTimeout>>
>();

function timersFor(
  bridge: QwenAcpAdapterBridge,
): Map<string, ReturnType<typeof setTimeout>> {
  let timers = idleTimers.get(bridge);
  if (!timers) {
    timers = new Map();
    idleTimers.set(bridge, timers);
  }
  return timers;
}

function sumTokens(stats: {
  models: Record<string, { tokens?: { total?: number } }>;
}): number {
  return Object.values(stats.models).reduce(
    (total, model) => total + (model.tokens?.total ?? 0),
    0,
  );
}

function stepStatus(
  status: string | null | undefined,
  previous: SessionAgentStep['status'] | undefined,
): SessionAgentStep['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'pending' || status === 'in_progress') return 'running';
  return previous ?? 'running';
}

/**
 * The options put to the person. `allow_always` is left out: a session
 * agent's hidden session is pinned to the default approval mode
 * (`Config.markSessionAgentSession`), so an "always" grant cannot take
 * effect there and the tool call it answers fails instead of running.
 */
const PERMISSION_KINDS = new Set([
  'allow_once',
  'reject_once',
  'reject_always',
]);

function toPermissionPrompt(data: {
  requestId?: string;
  toolCall?: {
    title?: string | null;
    kind?: string | null;
    rawInput?: unknown;
  };
  options?: Array<{ optionId?: string; name?: string; kind?: string }>;
}): SessionAgentPermissionPrompt | undefined {
  if (!data.requestId) return undefined;
  let inputPreview: string | undefined;
  if (data.toolCall?.rawInput !== undefined) {
    try {
      inputPreview = JSON.stringify(data.toolCall.rawInput).slice(
        0,
        MAX_INPUT_PREVIEW_CHARS,
      );
    } catch {
      inputPreview = undefined;
    }
  }
  return {
    requestId: data.requestId,
    title: (data.toolCall?.title ?? '').slice(0, MAX_PERMISSION_TITLE_CHARS),
    ...(data.toolCall?.kind ? { toolName: data.toolCall.kind } : {}),
    ...(inputPreview ? { inputPreview } : {}),
    options: (data.options ?? [])
      .filter(
        (option) =>
          typeof option.optionId === 'string' &&
          typeof option.kind === 'string' &&
          PERMISSION_KINDS.has(option.kind),
      )
      .map((option) => ({
        optionId: option.optionId!,
        name: option.name ?? option.optionId!,
        kind: option.kind as SessionAgentPermissionPrompt['options'][number]['kind'],
      })),
  };
}

export function createQwenAcpAdapter(
  options: QwenAcpAdapterOptions,
): AgentAdapter {
  const { bridge, workspaceCwd, agentId } = options;
  const idleCloseMs = options.idleCloseMs ?? QWEN_AGENT_SESSION_IDLE_CLOSE_MS;
  const cancelSettleMs = options.cancelSettleMs ?? QWEN_AGENT_CANCEL_SETTLE_MS;
  const sessions = new SessionService(workspaceCwd);
  const sessionExists =
    options.sessionExists ??
    ((sessionId: string) => sessions.sessionExists(sessionId));

  const findSession = (sessionId: string) =>
    bridge
      .listWorkspaceSessions(workspaceCwd)
      .find((session) => session.sessionId === sessionId);

  const scheduleIdleClose = (sessionId: string) => {
    const timers = timersFor(bridge);
    const previous = timers.get(sessionId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      const session = findSession(sessionId);
      if (!session || session.hasActivePrompt) return;
      void bridge.closeSession(sessionId).catch(() => {});
    }, idleCloseMs);
    timer.unref?.();
    timers.set(sessionId, timer);
  };

  const cancelIdleClose = (sessionId: string) => {
    const timers = timersFor(bridge);
    const timer = timers.get(sessionId);
    if (timer) clearTimeout(timer);
    timers.delete(sessionId);
  };

  /**
   * Attaches to, resumes or creates this agent's hidden session. True when
   * it was created, so it holds none of the earlier conversation.
   */
  const ensureSession = async (sessionId: string): Promise<boolean> => {
    const live = findSession(sessionId);
    if (
      live &&
      live.sourceType === AGENT_SESSION_SOURCE_TYPE &&
      live.sourceId === agentId &&
      options.sessionSend?.isCurrent() !== false
    ) {
      return false;
    }
    // Opened by a person as an ordinary session (no persona, no agent
    // surface), or carrying a dead `session_send` token: close it and reload
    // it as the agent's, as the thread-era port does.
    if (live) await bridge.closeSession(sessionId);
    const sendServer = options.sessionSend?.rotate();
    const request = {
      workspaceCwd,
      sessionId,
      sourceType: AGENT_SESSION_SOURCE_TYPE,
      sourceId: agentId,
      ...(sendServer ? { mcpServers: [toAcpStdioServer(sendServer)] } : {}),
    };
    if (await sessionExists(sessionId)) {
      await bridge.resumeSession(request);
      return false;
    }
    await bridge.spawnOrAttach({ ...request, sessionScope: 'thread' });
    return true;
  };

  return {
    program: 'qwen',
    async runTurn(
      input: AgentAdapterTurnInput,
    ): Promise<AgentAdapterTurnResult> {
      const sessionId = input.nativeSessionId;
      if (!sessionId) {
        return {
          status: 'failed',
          outputText: '',
          error:
            'The qwen adapter needs the planned native session id (sessionAgentNativeSessionId).',
        };
      }
      cancelIdleClose(sessionId);
      let created: boolean;
      try {
        created = await ensureSession(sessionId);
      } catch (error) {
        scheduleIdleClose(sessionId);
        return {
          status: 'failed',
          outputText: '',
          error: extractErrorMessage(error),
          nativeSessionId: sessionId,
        };
      }
      input.onEvent({ type: 'native_session', nativeSessionId: sessionId });

      const tokensBefore = await bridge
        .getSessionStatsStatus(sessionId)
        .then(sumTokens)
        .catch(() => undefined);

      const promptId = `session-agent:${randomUUID()}`;
      const streamController = new AbortController();
      let fullText = '';
      // Text after the last tool call: the deliverable when the turn
      // narrated its way through tools before answering.
      // TODO(multi-agent): confirm against real transcripts that the last
      // segment is the answer and not, e.g., a trailing status line.
      let segmentText = '';
      const steps = new Map<string, SessionAgentStep>();

      /**
       * Answers a permission request the run no longer waits on (stopped, or
       * ended) with ACP's `cancelled` outcome, which the bridge accepts
       * whatever the permission policy.
       */
      const withdrawPermission = (requestId: string) => {
        try {
          bridge.respondToSessionPermission(
            sessionId,
            requestId,
            { outcome: { outcome: 'cancelled' } },
            options.permissionVoteContext?.(requestId),
          );
        } catch {
          // Already resolved, or the session is gone.
        }
      };

      // The orchestrator shows one permission at a time (a run's frame has
      // one slot), so overlapping requests are put to the person in turn;
      // one resolved elsewhere while queued is skipped.
      let permissionChain: Promise<void> = Promise.resolve();
      const settledElsewhere = new Set<string>();

      const follow = (async () => {
        for await (const event of bridge.subscribeEvents(sessionId, {
          signal: streamController.signal,
        })) {
          if (event.promptId !== promptId) continue;
          if (event.type === 'permission_request') {
            const prompt = toPermissionPrompt(
              event.data as Parameters<typeof toPermissionPrompt>[0],
            );
            if (!prompt) continue;
            // The turn is winding down after a stop: refuse it unannounced.
            if (input.signal.aborted) {
              withdrawPermission(prompt.requestId);
              continue;
            }
            permissionChain = permissionChain
              .then(async () => {
                if (settledElsewhere.delete(prompt.requestId)) return;
                if (input.signal.aborted) {
                  withdrawPermission(prompt.requestId);
                  return;
                }
                input.onEvent({ type: 'permission_request', prompt });
                // Until the bridge accepts a vote: a refused one (policy,
                // unknown option) re-arms `awaitPermission` so the person can
                // answer again instead of the run hanging on a dead prompt.
                // `awaitPermission` rejects when the run is stopped or ends:
                // the request is then refused, so the turn can wind down.
                for (;;) {
                  let optionId: string;
                  try {
                    optionId = await input.awaitPermission(prompt);
                  } catch {
                    withdrawPermission(prompt.requestId);
                    return;
                  }
                  let accepted = false;
                  try {
                    accepted = bridge.respondToSessionPermission(
                      sessionId,
                      prompt.requestId,
                      { outcome: { outcome: 'selected', optionId } },
                      options.permissionVoteContext?.(prompt.requestId),
                    );
                  } catch {
                    accepted = false;
                  }
                  if (accepted) return;
                  if (input.signal.aborted) {
                    withdrawPermission(prompt.requestId);
                    return;
                  }
                }
              })
              .catch(() => {});
            continue;
          }
          if (event.type === 'permission_resolved') {
            const requestId = (event.data as { requestId?: string }).requestId;
            if (requestId) {
              settledElsewhere.add(requestId);
              input.onEvent({ type: 'permission_resolved', requestId });
            }
            continue;
          }
          if (event.type !== 'session_update') continue;
          const data = event.data as {
            update?: SessionUpdateLike;
          } & SessionUpdateLike;
          const update = data.update ?? data;
          if (
            update.sessionUpdate === 'agent_message_chunk' &&
            update.content?.type === 'text'
          ) {
            const text = update.content.text ?? '';
            fullText += text;
            segmentText += text;
            if (text) input.onEvent({ type: 'text_delta', text });
          } else if (
            update.sessionUpdate === 'agent_thought_chunk' &&
            update.content?.type === 'text'
          ) {
            const text = update.content.text ?? '';
            if (text) input.onEvent({ type: 'thought_delta', text });
          } else if (
            (update.sessionUpdate === 'tool_call' ||
              update.sessionUpdate === 'tool_call_update') &&
            update.toolCallId
          ) {
            if (update.sessionUpdate === 'tool_call') segmentText = '';
            const previous = steps.get(update.toolCallId);
            const step: SessionAgentStep = {
              id: update.toolCallId,
              title: (update.title || previous?.title || '').slice(
                0,
                MAX_STEP_TITLE_CHARS,
              ),
              status: stepStatus(update.status, previous?.status),
            };
            steps.set(update.toolCallId, step);
            input.onEvent({ type: 'step', step });
          }
        }
      })().catch(() => {
        // Stream loss is not a turn failure: the turn terminal comes from
        // getSessionTurnStatus below.
      });

      const isTurnOver = (
        status: Awaited<
          ReturnType<QwenAcpAdapterBridge['getSessionTurnStatus']>
        >,
      ) =>
        !status ||
        status.promptId !== promptId ||
        status.state === 'completed' ||
        status.state === 'cancelled' ||
        status.state === 'error';

      const cancel = async (): Promise<AgentAdapterTurnResult> => {
        // Bounded: a child that never acknowledges must not hold the run.
        const deadline = Date.now() + cancelSettleMs;
        await Promise.race([
          bridge.cancelSession(sessionId).catch(() => {}),
          delay(cancelSettleMs, undefined, { ref: false }),
        ]);
        // Wait for the turn's terminal, so nothing it emits on the way down
        // (a late permission request is refused above) outlives the run.
        while (Date.now() < deadline) {
          const status = await bridge
            .getSessionTurnStatus(sessionId, undefined, promptId)
            .catch(() => undefined);
          if (isTurnOver(status)) break;
          await delay(TURN_POLL_MS);
        }
        return {
          status: 'cancelled',
          outputText: segmentText.trim() ? segmentText : fullText,
          nativeSessionId: sessionId,
        };
      };

      let result: AgentAdapterTurnResult;
      // Removed when the turn ends: the run's signal outlives it.
      let onStop: (() => void) | undefined;
      try {
        if (input.signal.aborted) {
          result = await cancel();
        } else {
          // The bridge settles `sendPrompt` only when the turn ends: hand it
          // the stop signal (it forwards the cancel to the child) and stop
          // waiting on it as soon as the run is stopped.
          const stopped = new Promise<'stopped'>((resolve) => {
            onStop = () => resolve('stopped');
            input.signal.addEventListener('abort', onStop, { once: true });
          });
          const sent = bridge.sendPrompt(
            sessionId,
            {
              sessionId,
              prompt: [
                {
                  type: 'text',
                  // The id is planned, so "resume" means it is on disk. A
                  // session created now (the transcript is gone) gets the
                  // conversation from the start, not the delta. Not reported
                  // as `resumeRejected`: this prompt covers the history, so
                  // the read cursor may advance past it.
                  text: created
                    ? (input.freshPrompt ?? input.prompt)
                    : input.prompt,
                },
              ],
            } as Parameters<QwenAcpAdapterBridge['sendPrompt']>[1],
            input.signal,
            { promptId },
          );
          const first = await Promise.race([
            sent.then(() => 'sent' as const),
            stopped,
          ]);
          result = await (async (): Promise<AgentAdapterTurnResult> => {
            for (;;) {
              if (first === 'stopped' || input.signal.aborted) return cancel();
              const status = await bridge.getSessionTurnStatus(
                sessionId,
                undefined,
                promptId,
              );
              if (status?.promptId === promptId) {
                if (status.state === 'completed') {
                  // TODO(multi-agent): `resultText` is assumed to be the
                  // turn's final assistant text; verify, else keep the
                  // streamed segment.
                  const streamed = segmentText.trim() ? segmentText : fullText;
                  return {
                    status: 'completed',
                    outputText:
                      status.resultText && !status.resultTruncated
                        ? status.resultText
                        : streamed,
                    nativeSessionId: sessionId,
                  };
                }
                if (status.state === 'cancelled') {
                  return {
                    status: 'cancelled',
                    outputText: segmentText.trim() ? segmentText : fullText,
                    nativeSessionId: sessionId,
                  };
                }
                if (status.state === 'error') {
                  return {
                    status: 'failed',
                    outputText: fullText,
                    error: status.error?.message ?? 'Agent turn failed.',
                    nativeSessionId: sessionId,
                  };
                }
              }
              await delay(TURN_POLL_MS);
            }
          })();
        }
      } catch (error) {
        // A stopped turn's `sendPrompt` rejects (AbortError): still cancel.
        result = input.signal.aborted
          ? await cancel()
          : {
              status: 'failed',
              outputText: fullText,
              error: extractErrorMessage(error),
              nativeSessionId: sessionId,
            };
      } finally {
        if (onStop) input.signal.removeEventListener('abort', onStop);
        streamController.abort();
        await follow;
        scheduleIdleClose(sessionId);
      }

      if (tokensBefore !== undefined) {
        const tokensAfter = await bridge
          .getSessionStatsStatus(sessionId)
          .then(sumTokens)
          .catch(() => undefined);
        if (tokensAfter !== undefined && tokensAfter >= tokensBefore) {
          const totalTokens = tokensAfter - tokensBefore;
          input.onEvent({ type: 'usage', totalTokens });
          result = { ...result, totalTokens };
        }
      }
      return result;
    },
  };
}

interface SessionUpdateLike {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
  title?: string | null;
  toolCallId?: string;
  status?: string | null;
}
