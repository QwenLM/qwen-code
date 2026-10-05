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
 * `sessionSendServer` is not used either.
 * TODO(multi-agent): offer `session_send` to qwen agents. Two things block
 * passing it as an ACP `mcpServers` entry: the bridge sends `mcpServers: []`
 * on every newSession / loadSession (acp-bridge session-control-plane.ts, and
 * `BridgeSpawnRequest` has no field for it), and the hidden session outlives
 * a run while the server's token is per run, so an entry fixed at session
 * creation would carry a dead token on the next run. Options: a built-in
 * tool in the ACP child for `sourceType: 'agent'` sessions that posts
 * through an ext method, or a per-prompt MCP override on the bridge.
 *
 * Hidden sessions are closed after {@link QWEN_AGENT_SESSION_IDLE_CLOSE_MS}
 * idle so they do not exhaust the bridge's `maxSessions`.
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import { getErrorMessage } from '@qwen-code/qwen-code-core/utils/errors.js';
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
const MAX_INPUT_PREVIEW_CHARS = 2_000;
const MAX_STEP_TITLE_CHARS = 200;

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
  /** Test seam. */
  sessionExists?: (sessionId: string) => Promise<boolean>;
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

const PERMISSION_KINDS = new Set([
  'allow_once',
  'allow_always',
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
    title: data.toolCall?.title ?? '',
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

  /** Attaches to, resumes or creates this agent's hidden session. */
  const ensureSession = async (sessionId: string): Promise<void> => {
    const live = findSession(sessionId);
    if (
      live &&
      live.sourceType === AGENT_SESSION_SOURCE_TYPE &&
      live.sourceId === agentId
    ) {
      return;
    }
    // Opened by a person as an ordinary session (no persona, no agent
    // surface): close it and reload it as the agent's, as the thread-era
    // port does.
    if (live) await bridge.closeSession(sessionId);
    const request = {
      workspaceCwd,
      sessionId,
      sourceType: AGENT_SESSION_SOURCE_TYPE,
      sourceId: agentId,
    };
    if (await sessionExists(sessionId)) {
      await bridge.resumeSession(request);
    } else {
      await bridge.spawnOrAttach({ ...request, sessionScope: 'thread' });
    }
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
      try {
        await ensureSession(sessionId);
      } catch (error) {
        scheduleIdleClose(sessionId);
        return {
          status: 'failed',
          outputText: '',
          error: getErrorMessage(error),
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
            input.onEvent({ type: 'permission_request', prompt });
            void (async () => {
              // Until the bridge accepts a vote: a refused one (policy,
              // unknown option) re-arms `awaitPermission` so the person can
              // answer again instead of the run hanging on a dead prompt.
              // `awaitPermission` rejects when the run ends, which exits.
              for (;;) {
                const optionId = await input.awaitPermission(prompt);
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
                if (input.signal.aborted) return;
              }
            })().catch(() => {});
            continue;
          }
          if (event.type === 'permission_resolved') {
            const requestId = (event.data as { requestId?: string }).requestId;
            if (requestId) {
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

      const cancel = async (): Promise<AgentAdapterTurnResult> => {
        await bridge.cancelSession(sessionId).catch(() => {});
        return {
          status: 'cancelled',
          outputText: segmentText.trim() ? segmentText : fullText,
          nativeSessionId: sessionId,
        };
      };

      let result: AgentAdapterTurnResult;
      try {
        if (input.signal.aborted) {
          result = await cancel();
        } else {
          await bridge.sendPrompt(
            sessionId,
            {
              sessionId,
              prompt: [{ type: 'text', text: input.prompt }],
            } as Parameters<QwenAcpAdapterBridge['sendPrompt']>[1],
            undefined,
            { promptId },
          );
          result = await (async (): Promise<AgentAdapterTurnResult> => {
            for (;;) {
              if (input.signal.aborted) return cancel();
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
        result = {
          status: 'failed',
          outputText: fullText,
          error: getErrorMessage(error),
          nativeSessionId: sessionId,
        };
      } finally {
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
