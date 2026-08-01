/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AcpSessionBridge,
  BridgePendingInteraction,
} from '@qwen-code/acp-bridge/bridgeTypes';
import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import type { SessionListItem } from '@qwen-code/qwen-code-core';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  LIVE_SESSION_SOURCE_PREFIX,
  LiveSessionCoordinator,
  type LiveSessionHostControl,
} from './live-session-coordinator.js';
import {
  QwenRealtimeError,
  type QwenRealtimeCallbacks,
  type QwenRealtimeSession,
  type RealtimeTranscriptEntry,
} from './qwen-realtime-session.js';

const readPersistedParentSessionId = vi.hoisted(() => vi.fn());
const buildRealtimeStartupContext = vi.hoisted(() =>
  vi.fn(async () => '<startup_context>test context</startup_context>'),
);

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    SessionService: class {
      async listSessions() {
        return { items: [], hasMore: false };
      }

      async removeSession() {
        return true;
      }

      readParentSessionId(sessionId: string) {
        return readPersistedParentSessionId(sessionId);
      }
    },
  };
});

vi.mock('./realtime-startup-context.js', () => ({
  buildRealtimeStartupContext,
}));

interface Subscriber {
  queue: BridgeEvent[];
  wake?: () => void;
}

interface PendingTurn {
  promptId: string;
  resolve: () => void;
}

type FakeRealtimeSession = QwenRealtimeSession & {
  pushAudio: ReturnType<typeof vi.fn>;
  commitInputAudio: ReturnType<typeof vi.fn>;
  clearInputAudio: ReturnType<typeof vi.fn>;
  cancelResponse: ReturnType<typeof vi.fn>;
  sendHandoffUpdate: ReturnType<typeof vi.fn>;
  completeHandoff: ReturnType<typeof vi.fn>;
  sendBackendUpdate: ReturnType<typeof vi.fn>;
  takeTranscriptTail: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function waitFor(assertion: () => void): Promise<void> {
  return vi.waitFor(assertion, { timeout: 2_000 });
}

function makeHarness(
  options: {
    recent?: SessionListItem[];
    enqueueAccepted?: boolean;
    providerError?: QwenRealtimeError;
    transcriptTail?: RealtimeTranscriptEntry[];
    pendingInteractions?: BridgePendingInteraction[];
  } = {},
) {
  const subscribers = new Set<Subscriber>();
  const pendingTurns: PendingTurn[] = [];
  const promptRequests: Array<{
    sessionId: string;
    prompt: string;
    modelPrompt?: string;
  }> = [];
  const publish = (event: Omit<BridgeEvent, 'v'>) => {
    for (const subscriber of subscribers) {
      subscriber.queue.push({ v: 1, ...event });
      subscriber.wake?.();
      subscriber.wake = undefined;
    }
  };

  const bridge = {
    spawnOrAttach: vi.fn(async () => ({
      sessionId: 'live-new',
      attached: false,
      sourcePersisted: true,
    })),
    resumeSession: vi.fn(async () => ({
      sessionId: 'live-old',
      attached: false,
    })),
    updateSessionMetadata: vi.fn(),
    setSessionLiveConversationActive: vi.fn(async () => undefined),
    changeSessionCwd: vi.fn(
      async (sessionId: string, request: { path: string }) => ({
        sessionId,
        previousCwd: '/conversations',
        newCwd: request.path,
        warnings: [],
      }),
    ),
    killSession: vi.fn(async () => true),
    detachClient: vi.fn(async () => undefined),
    getSessionLastEventId: vi.fn(() => 0),
    getSessionSummary: vi.fn(() => ({
      pendingInteractions: options.pendingInteractions ?? [],
    })),
    enqueueMidTurnMessage: vi.fn(() => ({
      accepted: options.enqueueAccepted ?? true,
      queued: options.enqueueAccepted ?? true,
    })),
    async *subscribeEvents(
      _sessionId: string,
      request?: { signal?: AbortSignal },
    ) {
      const subscriber: Subscriber = { queue: [] };
      subscribers.add(subscriber);
      const onAbort = () => {
        subscriber.wake?.();
        subscriber.wake = undefined;
      };
      request?.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        while (!request?.signal?.aborted) {
          const next = subscriber.queue.shift();
          if (next) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => {
            subscriber.wake = resolve;
          });
        }
      } finally {
        request?.signal?.removeEventListener('abort', onAbort);
        subscribers.delete(subscriber);
      }
    },
    sendPrompt: vi.fn(
      async (
        sessionId: string,
        request: { prompt: Array<{ text?: string }> },
        _signal: AbortSignal,
        context: {
          promptId: string;
          modelPrompt?: string;
          onPromptAdmitted?: () => void;
        },
      ) => {
        promptRequests.push({
          sessionId,
          prompt: request.prompt.map((part) => part.text ?? '').join(''),
          modelPrompt: context.modelPrompt,
        });
        context.onPromptAdmitted?.();
        await new Promise<void>((resolve) => {
          pendingTurns.push({ promptId: context.promptId, resolve });
        });
        return { stopReason: 'end_turn' };
      },
    ),
  } as unknown as AcpSessionBridge;

  const runtime = {
    workspaceId: 'conversations-workspace',
    workspaceCwd: '/conversations',
    bridge,
  } as WorkspaceRuntime;
  const workspaceRegistry = {
    list: () => [runtime],
  } as unknown as WorkspaceRegistry;
  const host = {
    setCallState: vi.fn(() => true),
    setCoordinator: vi.fn(() => true),
    setPendingPermission: vi.fn(() => true),
    setWorkers: vi.fn(() => true),
    sendOutputAudio: vi.fn(() => true),
    clearOutput: vi.fn(),
    failCall: vi.fn(() => true),
    setProviderReachability: vi.fn(),
    setTranscript: vi.fn(() => true),
    setCaption: vi.fn(() => true),
    setStatusText: vi.fn(() => true),
  } satisfies LiveSessionHostControl;
  let callbacks: QwenRealtimeCallbacks | undefined;
  let resolveClosed!: (value: { reason: 'client' }) => void;
  const realtime = {
    callEpoch: 1,
    closed: new Promise<{ reason: 'client' }>((resolve) => {
      resolveClosed = resolve;
    }),
    pushAudio: vi.fn(() => true),
    commitInputAudio: vi.fn(() => true),
    clearInputAudio: vi.fn(() => true),
    cancelResponse: vi.fn(() => true),
    sendHandoffUpdate: vi.fn(() => true),
    completeHandoff: vi.fn(() => true),
    sendBackendUpdate: vi.fn(() => true),
    takeTranscriptTail: vi.fn(() => options.transcriptTail ?? []),
    close: vi.fn(() => resolveClosed({ reason: 'client' })),
  } satisfies FakeRealtimeSession;
  const openRealtimeSession = vi.fn(
    async (
      _config: unknown,
      nextCallbacks: QwenRealtimeCallbacks,
    ): Promise<QwenRealtimeSession> => {
      if (options.providerError) throw options.providerError;
      callbacks = nextCallbacks;
      nextCallbacks.onReady?.({ callEpoch: 1, sessionId: 'realtime-1' });
      return realtime;
    },
  );
  const coordinator = new LiveSessionCoordinator({
    host,
    ensureConversationRuntime: vi.fn(async () => runtime),
    workspaceRegistry,
    getProviderCredential: vi.fn(
      () =>
        ({
          endpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
          apiKey: 'secret',
          realtimeModel: 'qwen3.5-omni-plus-realtime',
          voice: 'Tina',
        }) as never,
    ),
    openRealtimeSession: openRealtimeSession as never,
    materializeConversationDirectory: vi.fn(
      async (sessionId: string) => '/conversations/conversation-' + sessionId,
    ),
    discardEmptyConversationDirectory: vi.fn(async () => true),
    listRecentSessions: vi.fn(async () => options.recent ?? []),
  });

  const finishTurn = async (
    index: number,
    events: Array<
      | { type: 'message'; text: string }
      | { type: 'tool'; title: string }
      | {
          type: 'tool_update';
          rawOutput: string;
          toolName: string;
          taskId?: string;
        }
    >,
  ) => {
    const turn = pendingTurns[index];
    if (!turn) throw new Error('No pending turn at index ' + index);
    for (const event of events) {
      if (event.type === 'message') {
        publish({
          type: 'session_update',
          promptId: turn.promptId,
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { text: event.text },
            },
          },
        });
      } else if (event.type === 'tool') {
        publish({
          type: 'session_update',
          promptId: turn.promptId,
          data: {
            update: { sessionUpdate: 'tool_call', title: event.title },
          },
        });
      } else {
        publish({
          type: 'session_update',
          promptId: turn.promptId,
          data: {
            update: {
              sessionUpdate: 'tool_call_update',
              status: 'completed',
              rawOutput: event.rawOutput,
              _meta: {
                source: 'builtin',
                toolName: event.toolName,
                ...(event.taskId
                  ? { backgroundTask: { taskId: event.taskId } }
                  : {}),
                provenance: 'builtin',
              },
            },
          },
        });
      }
    }
    publish({
      type: 'turn_complete',
      promptId: turn.promptId,
      data: { promptId: turn.promptId, stopReason: 'end_turn' },
    });
    turn.resolve();
    await Promise.resolve();
  };

  return {
    coordinator,
    bridge,
    host,
    realtime,
    openRealtimeSession,
    promptRequests,
    pendingTurns,
    publish,
    get callbacks() {
      if (!callbacks) throw new Error('Realtime callbacks are unavailable.');
      return callbacks;
    },
    finishTurn,
  };
}

afterEach(() => {
  readPersistedParentSessionId.mockReset();
});

describe('LiveSessionCoordinator', () => {
  it('attaches Realtime to a persistent projectless Live session before direct conversation', async () => {
    const harness = makeHarness();
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
    });

    expect(harness.openRealtimeSession).toHaveBeenCalledOnce();
    expect(harness.bridge.spawnOrAttach).toHaveBeenCalledOnce();
    expect(harness.host.setCoordinator).toHaveBeenCalledWith(1, {
      workspaceCwd: '/conversations',
      workspaceId: 'conversations-workspace',
      sessionId: 'live-new',
    });
    expect(harness.bridge.updateSessionMetadata).toHaveBeenCalledWith(
      'live-new',
      { displayName: 'Voice chat' },
    );
    expect(harness.host.setCallState).toHaveBeenLastCalledWith(1, 'listening');

    harness.callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'direct-1',
      authority: 'direct',
    });
    harness.callbacks.onOutputTextDone?.({
      callEpoch: 1,
      responseId: 'direct-1',
      text: '直接回答',
      source: 'audio_transcript',
    });
    harness.callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'direct-1',
      audio: new Uint8Array([1, 0]),
    });

    expect(harness.host.setCaption).toHaveBeenLastCalledWith(1, '直接回答');
    expect(harness.host.sendOutputAudio).toHaveBeenCalledWith(
      1,
      new Uint8Array([1, 0]),
    );
    expect(harness.bridge.sendPrompt).not.toHaveBeenCalled();
  });

  it('ignores completion from an interrupted response after its replacement starts', async () => {
    const harness = makeHarness();
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
    });

    harness.callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'response-first',
      authority: 'direct',
    });
    harness.callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'response-second',
      authority: 'direct',
    });
    const stateUpdatesBeforeStaleCompletion =
      harness.host.setCallState.mock.calls.length;

    harness.callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'response-first',
      status: 'cancelled',
    });

    expect(harness.host.setCallState).toHaveBeenCalledTimes(
      stateUpdatesBeforeStaleCompletion,
    );
    harness.callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'response-second',
      audio: new Uint8Array([2, 0]),
    });
    expect(harness.host.setCallState).toHaveBeenLastCalledWith(1, 'speaking');

    harness.callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'response-second',
      status: 'completed',
    });
    expect(harness.host.setCallState).toHaveBeenLastCalledWith(1, 'listening');
  });

  it('uses the attached Live session and sends the exact delegation envelope', async () => {
    const harness = makeHarness();
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
    });
    harness.callbacks.onDelegateCall?.({
      callEpoch: 1,
      responseId: 'response-1',
      callId: 'handoff-1',
      request: '检查 <repo> & tests',
      activeTranscript: [
        { role: 'user', text: '先聊一下' },
        { role: 'assistant', text: '好的。' },
        { role: 'user', text: '检查 <repo> & tests' },
      ],
    });

    await waitFor(() => expect(harness.pendingTurns).toHaveLength(1));
    expect(harness.bridge.spawnOrAttach).toHaveBeenCalledWith({
      workspaceCwd: '/conversations',
      sessionScope: 'thread',
      sourceType: 'default',
      sourceId: LIVE_SESSION_SOURCE_PREFIX + 'call-1',
    });
    expect(harness.promptRequests[0]).toEqual({
      sessionId: 'live-new',
      prompt: '检查 <repo> & tests',
      modelPrompt:
        '<realtime_delegation>\n  <input>检查 &lt;repo&gt; &amp; tests</input>\n  <transcript_delta>user: 先聊一下\nassistant: 好的。\nuser: 检查 &lt;repo&gt; &amp; tests</transcript_delta>\n</realtime_delegation>',
    });
    expect(harness.bridge.changeSessionCwd).toHaveBeenCalledWith('live-new', {
      path: '/conversations/conversation-live-new',
      allowedRoots: ['/conversations'],
      managedRelocation: 'live-conversation',
    });

    await harness.finishTurn(0, [{ type: 'message', text: '检查完成。' }]);
    await waitFor(() =>
      expect(harness.realtime.completeHandoff).toHaveBeenCalledOnce(),
    );
    expect(harness.realtime.sendHandoffUpdate).toHaveBeenCalledWith({
      callEpoch: 1,
      callId: 'handoff-1',
      output: '检查完成。',
    });
    expect(harness.realtime.completeHandoff).toHaveBeenCalledWith({
      callEpoch: 1,
      callId: 'handoff-1',
    });
  });

  it('returns completed Agent messages at message boundaries before completing the handoff', async () => {
    const harness = makeHarness();
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
    });
    harness.callbacks.onDelegateCall?.({
      callEpoch: 1,
      responseId: 'response-1',
      callId: 'handoff-1',
      request: '执行任务',
      activeTranscript: [{ role: 'user', text: '执行任务' }],
    });
    await waitFor(() => expect(harness.pendingTurns).toHaveLength(1));

    await harness.finishTurn(0, [
      { type: 'message', text: '正在检查。' },
      { type: 'tool', title: '运行测试' },
      { type: 'message', text: '测试通过。' },
    ]);
    await waitFor(() =>
      expect(harness.realtime.sendHandoffUpdate).toHaveBeenCalledTimes(2),
    );

    expect(harness.realtime.sendHandoffUpdate.mock.calls).toEqual([
      [
        {
          callEpoch: 1,
          callId: 'handoff-1',
          output: '正在检查。',
        },
      ],
      [
        {
          callEpoch: 1,
          callId: 'handoff-1',
          output: '测试通过。',
        },
      ],
    ]);
    expect(
      harness.realtime.sendHandoffUpdate.mock.invocationCallOrder[1],
    ).toBeLessThan(
      harness.realtime.completeHandoff.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('routes a second handoff into the active backend turn', async () => {
    const harness = makeHarness({ enqueueAccepted: true });
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
    });
    harness.callbacks.onDelegateCall?.({
      callEpoch: 1,
      responseId: 'response-1',
      callId: 'handoff-1',
      request: '开始检查',
      activeTranscript: [{ role: 'user', text: '开始检查' }],
    });
    await waitFor(() => expect(harness.pendingTurns).toHaveLength(1));

    harness.callbacks.onDelegateCall?.({
      callEpoch: 1,
      responseId: 'response-2',
      callId: 'handoff-steer',
      request: '只检查测试目录',
      activeTranscript: [{ role: 'user', text: '只检查测试目录' }],
    });
    await waitFor(() =>
      expect(harness.bridge.enqueueMidTurnMessage).toHaveBeenCalledWith(
        'live-new',
        '<realtime_delegation>\n  <input>只检查测试目录</input>\n  <transcript_delta>user: 只检查测试目录</transcript_delta>\n</realtime_delegation>',
      ),
    );
    expect(harness.bridge.sendPrompt).toHaveBeenCalledTimes(1);

    await harness.finishTurn(0, [{ type: 'message', text: '已完成。' }]);
    await waitFor(() =>
      expect(harness.realtime.completeHandoff).toHaveBeenCalledWith({
        callEpoch: 1,
        callId: 'handoff-1',
      }),
    );
  });

  it('starts the steering request as the next turn on the same session if the first turn just settled', async () => {
    const harness = makeHarness({ enqueueAccepted: false });
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
    });
    harness.callbacks.onDelegateCall?.({
      callEpoch: 1,
      responseId: 'response-1',
      callId: 'handoff-1',
      request: '第一步',
      activeTranscript: [{ role: 'user', text: '第一步' }],
    });
    await waitFor(() => expect(harness.pendingTurns).toHaveLength(1));
    harness.callbacks.onDelegateCall?.({
      callEpoch: 1,
      responseId: 'response-2',
      callId: 'handoff-steer',
      request: '第二步',
      activeTranscript: [{ role: 'user', text: '第二步' }],
    });

    await harness.finishTurn(0, [{ type: 'message', text: '第一步完成。' }]);
    await waitFor(() => expect(harness.pendingTurns).toHaveLength(2));
    expect(harness.promptRequests[1]).toMatchObject({
      sessionId: 'live-new',
      prompt: '第二步',
    });
    expect(harness.bridge.spawnOrAttach).toHaveBeenCalledTimes(1);

    await harness.finishTurn(1, [{ type: 'message', text: '第二步完成。' }]);
    await waitFor(() =>
      expect(harness.realtime.sendBackendUpdate).toHaveBeenCalledWith(
        '第二步完成。',
      ),
    );
  });

  it('resumes only a compatible projectless Live session', async () => {
    const harness = makeHarness({
      recent: [
        {
          sessionId: 'ordinary',
          sourceType: 'default',
          sourceId: 'web-shell',
        } as SessionListItem,
        {
          sessionId: 'live-old',
          sourceType: 'default',
          sourceId: LIVE_SESSION_SOURCE_PREFIX + 'previous',
        } as SessionListItem,
      ],
    });
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'resume',
    });
    harness.callbacks.onDelegateCall?.({
      callEpoch: 1,
      responseId: 'response-1',
      callId: 'handoff-1',
      request: '继续',
      activeTranscript: [{ role: 'user', text: '继续' }],
    });

    await waitFor(() => expect(harness.pendingTurns).toHaveLength(1));
    expect(harness.bridge.resumeSession).toHaveBeenCalledWith({
      sessionId: 'live-old',
      workspaceCwd: '/conversations',
      sourceType: 'default',
      sourceId: LIVE_SESSION_SOURCE_PREFIX + 'previous',
    });
    expect(harness.bridge.spawnOrAttach).not.toHaveBeenCalled();
    await harness.finishTurn(0, [{ type: 'message', text: '继续完成。' }]);
  });

  it('tracks a task session only from a completed built-in create_sub_session result', async () => {
    readPersistedParentSessionId.mockResolvedValue('live-new');
    const harness = makeHarness();
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
    });
    harness.callbacks.onDelegateCall?.({
      callEpoch: 1,
      responseId: 'response-1',
      callId: 'handoff-1',
      request: '创建任务',
      activeTranscript: [{ role: 'user', text: '创建任务' }],
    });
    await waitFor(() => expect(harness.pendingTurns).toHaveLength(1));

    await harness.finishTurn(0, [
      {
        type: 'tool_update',
        toolName: 'create_sub_session',
        rawOutput: '[🧵 worker-1](qwen-session://worker-1) started',
      },
      { type: 'message', text: '任务已创建。' },
    ]);
    await waitFor(() =>
      expect(harness.host.setWorkers).toHaveBeenCalledWith(1, [
        {
          workspaceCwd: '/conversations',
          workspaceId: 'conversations-workspace',
          sessionId: 'worker-1',
        },
      ]),
    );
  });

  it('tracks only unresolved tool permissions for the Live coordinator', async () => {
    const harness = makeHarness();
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
    });

    harness.publish({
      type: 'permission_request',
      data: { requestId: 'permission-1', toolCall: { title: 'Run command' } },
    });
    harness.publish({
      type: 'permission_request',
      data: { requestId: 'permission-2', toolCall: { title: 'Write file' } },
    });
    await waitFor(() =>
      expect(harness.host.setPendingPermission).toHaveBeenLastCalledWith(
        1,
        true,
      ),
    );

    harness.publish({
      type: 'permission_resolved',
      data: { requestId: 'permission-1' },
    });
    await Promise.resolve();
    expect(harness.host.setPendingPermission).toHaveBeenLastCalledWith(1, true);

    harness.publish({
      type: 'permission_resolved',
      data: { requestId: 'permission-2' },
    });
    await waitFor(() =>
      expect(harness.host.setPendingPermission).toHaveBeenLastCalledWith(
        1,
        false,
      ),
    );

    harness.publish({
      type: 'permission_request',
      data: {
        requestId: 'question-1',
        toolCall: {
          _meta: { qwenInteractionKind: 'user_question' },
        },
      },
    });
    await Promise.resolve();
    expect(harness.host.setPendingPermission).toHaveBeenLastCalledWith(
      1,
      false,
    );
  });

  it('shows a permission already pending when a Live session resumes', async () => {
    const harness = makeHarness({
      pendingInteractions: [
        {
          requestId: 'permission-existing',
          kind: 'permission',
          createdAt: '2026-07-31T00:00:00.000Z',
          action: { title: 'Run command' },
          options: [],
        },
      ],
    });
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
    });

    expect(harness.host.setPendingPermission).toHaveBeenCalledWith(1, true);
  });

  it('flushes the remaining realtime transcript into the same Live session on stop', async () => {
    const harness = makeHarness({
      transcriptTail: [
        { role: 'user', text: '最后一个问题' },
        { role: 'assistant', text: '最后一个回答' },
      ],
    });
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
    });

    const stopped = harness.coordinator.stop({ epoch: 1, callId: 'call-1' });
    await waitFor(() => expect(harness.pendingTurns).toHaveLength(1));
    await expect(stopped).resolves.toBeUndefined();

    expect(harness.promptRequests[0]).toEqual({
      sessionId: 'live-new',
      prompt: 'user: 最后一个问题\nassistant: 最后一个回答',
      modelPrompt:
        '<realtime_delegation>\n  <source>transcript_tail_flush</source>\n  <input>The user just ended their realtime session. Here is the remaining handoff/transcript tail. You probably do not have to do anything; acknowledge the handoff unless the transcript itself asks for something.</input>\n  <transcript_delta>user: 最后一个问题\nassistant: 最后一个回答</transcript_delta>\n</realtime_delegation>',
    });
    expect(harness.bridge.spawnOrAttach).toHaveBeenCalledTimes(1);
    expect(harness.bridge.killSession).not.toHaveBeenCalled();

    await harness.finishTurn(0, [{ type: 'message', text: '已记录。' }]);
  });

  it('reports provider configuration failures without retrying', async () => {
    const harness = makeHarness({
      providerError: new QwenRealtimeError(
        'Invalid API key.',
        'invalid_api_key',
        true,
        { kind: 'configuration' },
      ),
    });
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
    });

    expect(harness.openRealtimeSession).toHaveBeenCalledOnce();
    expect(harness.host.failCall).toHaveBeenCalledWith(
      1,
      'Live Voice failed to start: Invalid API key.',
    );
    expect(harness.host.setProviderReachability).toHaveBeenLastCalledWith({
      state: 'unavailable',
      blocker: 'provider_config',
      message: 'Live Voice failed to start: Invalid API key.',
    });
  });
});
