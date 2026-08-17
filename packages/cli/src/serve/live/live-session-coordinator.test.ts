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
  sendBackendContext: ReturnType<typeof vi.fn>;
  speakToUser: ReturnType<typeof vi.fn>;
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
    transcriptPersistenceError?: Error;
    pendingInteractions?: BridgePendingInteraction[];
    gracefulStopDrainMs?: number;
  } = {},
) {
  const subscribers = new Set<Subscriber>();
  const pendingTurns: PendingTurn[] = [];
  const promptRequests: Array<{
    sessionId: string;
    prompt: string;
    modelPrompt?: string;
    deadlineMs?: number;
  }> = [];
  let settleQueuedMidTurn: (() => void) | undefined;
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
    appendSessionLiveTranscript: vi.fn(async () => {
      if (options.transcriptPersistenceError) {
        throw options.transcriptPersistenceError;
      }
    }),
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
    enqueueMidTurnMessage: vi.fn(
      (
        _sessionId: string,
        _message: string,
        _context: unknown,
        _messageId: string | undefined,
        enqueueOptions?: { onSettledWithoutDrain?: () => void },
      ) => {
        settleQueuedMidTurn = enqueueOptions?.onSettledWithoutDrain;
        return {
          accepted: options.enqueueAccepted ?? true,
          queued: options.enqueueAccepted ?? true,
        };
      },
    ),
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
          deadlineMs?: number;
          onPromptAdmitted?: () => void;
        },
      ) => {
        promptRequests.push({
          sessionId,
          prompt: request.prompt.map((part) => part.text ?? '').join(''),
          modelPrompt: context.modelPrompt,
          deadlineMs: context.deadlineMs,
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
    sendBackendContext: vi.fn(() => true),
    speakToUser: vi.fn(() => true),
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
    gracefulStopDrainMs: options.gracefulStopDrainMs,
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
    settleQueuedMidTurn: () => settleQueuedMidTurn?.(),
    publish,
    get callbacks() {
      if (!callbacks) throw new Error('Realtime callbacks are unavailable.');
      return callbacks;
    },
    finishTurn,
  };
}

afterEach(() => {
  vi.useRealTimers();
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

  it('releases completed input and delegation tracking during a long call', async () => {
    const harness = makeHarness();
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
    });
    const active = (
      harness.coordinator as unknown as {
        active?: {
          completedInputTranscripts: Map<string, string>;
          delegateAdmissions: Map<string, unknown>;
        };
      }
    ).active;

    harness.callbacks.onInputTranscriptDone?.({
      callEpoch: 1,
      itemId: 'input-direct',
      text: '直接回答这个问题',
    });
    harness.callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'response-direct',
      inputItemId: 'input-direct',
      authority: 'direct',
    });
    harness.callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'response-direct',
      inputItemId: 'input-direct',
      status: 'completed',
    });

    expect(active?.completedInputTranscripts.size).toBe(0);

    harness.callbacks.onDelegateCall?.({
      callEpoch: 1,
      responseId: 'response-handoff',
      inputItemId: 'input-handoff',
      callId: 'handoff-1',
      request: '检查仓库',
      activeTranscript: [{ role: 'user', text: '检查仓库' }],
    });
    await waitFor(() => expect(harness.pendingTurns).toHaveLength(1));
    await harness.finishTurn(0, [{ type: 'message', text: '检查完成。' }]);
    await waitFor(() => expect(active?.delegateAdmissions.size).toBe(0));
  });

  it('ignores completion from an interrupted response after its replacement starts', async () => {
    const harness = makeHarness();
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
    });

    harness.callbacks.onInputCommitted?.({
      callEpoch: 1,
      itemId: 'input-first',
    });
    harness.callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'response-first',
      inputItemId: 'input-first',
      authority: 'direct',
    });
    harness.callbacks.onInputCommitted?.({
      callEpoch: 1,
      itemId: 'input-second',
    });
    harness.callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'response-second',
      inputItemId: 'input-second',
      authority: 'direct',
    });
    const stateUpdatesBeforeStaleCompletion =
      harness.host.setCallState.mock.calls.length;

    harness.callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'response-first',
      inputItemId: 'input-first',
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
      inputItemId: 'input-second',
      status: 'completed',
    });
    expect(harness.host.setCallState).toHaveBeenLastCalledWith(1, 'listening');
    await expect(
      harness.coordinator.stop({ epoch: 1, callId: 'call-1' }),
    ).resolves.toBeUndefined();
  });

  it('stops without waiting for response.done after a handoff is admitted', async () => {
    const harness = makeHarness({ gracefulStopDrainMs: 5 });
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
    });
    harness.callbacks.onInputCommitted?.({
      callEpoch: 1,
      itemId: 'input-handoff',
    });
    harness.callbacks.onInputTranscriptDone?.({
      callEpoch: 1,
      itemId: 'input-handoff',
      text: '创建一个新任务',
    });
    harness.callbacks.onDelegateCall?.({
      callEpoch: 1,
      responseId: 'response-handoff',
      inputItemId: 'input-handoff',
      callId: 'handoff-1',
      request: '创建一个新任务',
      activeTranscript: [{ role: 'user', text: '创建一个新任务' }],
    });
    await waitFor(() => expect(harness.pendingTurns).toHaveLength(1));

    await expect(
      harness.coordinator.stop({ epoch: 1, callId: 'call-1' }),
    ).resolves.toBeUndefined();
    expect(harness.realtime.close).toHaveBeenCalledWith();
    expect(harness.realtime.close).not.toHaveBeenCalledWith({
      discardPendingInput: true,
    });

    await harness.finishTurn(0, []);
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
      deadlineMs: 10 * 60_000,
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

  it('persists direct dialogue before admitting a following backend handoff', async () => {
    const harness = makeHarness();
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
    });

    harness.callbacks.onDirectTranscript?.({
      callEpoch: 1,
      entries: [
        { role: 'user', text: '先聊一下' },
        { role: 'assistant', text: '好的。' },
      ],
    });
    harness.callbacks.onDelegateCall?.({
      callEpoch: 1,
      responseId: 'response-1',
      callId: 'handoff-1',
      request: '现在检查仓库',
      activeTranscript: [{ role: 'user', text: '现在检查仓库' }],
    });

    await waitFor(() => expect(harness.pendingTurns).toHaveLength(1));
    expect(harness.bridge.appendSessionLiveTranscript).toHaveBeenCalledWith(
      'live-new',
      [
        { role: 'user', text: '先聊一下' },
        { role: 'assistant', text: '好的。' },
      ],
      'qwen3.5-omni-plus-realtime',
    );
    expect(
      vi.mocked(harness.bridge.appendSessionLiveTranscript).mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(harness.bridge.sendPrompt).mock.invocationCallOrder[0] ?? 0,
    );

    await harness.finishTurn(0, [{ type: 'message', text: '检查完成。' }]);
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

  it('completes the handoff when the backend turn ends without ordinary text', async () => {
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

    await harness.finishTurn(0, []);

    await waitFor(() =>
      expect(harness.realtime.completeHandoff).toHaveBeenCalledWith({
        callEpoch: 1,
        callId: 'handoff-1',
      }),
    );
    expect(harness.realtime.sendHandoffUpdate).not.toHaveBeenCalled();
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
        undefined,
        undefined,
        expect.objectContaining({
          queueOnly: true,
          onSettledWithoutDrain: expect.any(Function),
        }),
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
      deadlineMs: 10 * 60_000,
    });
    expect(harness.bridge.spawnOrAttach).toHaveBeenCalledTimes(1);
    // Steering opts out of idle promotion: a promoted steering prompt would
    // run without backend-context forwarding or a turn deadline, so the
    // bridge hands the idle case back to the coordinator.
    expect(harness.bridge.enqueueMidTurnMessage).toHaveBeenCalledWith(
      'live-new',
      expect.stringContaining('第二步'),
      undefined,
      undefined,
      expect.objectContaining({
        queueOnly: true,
        onSettledWithoutDrain: expect.any(Function),
      }),
    );

    await harness.finishTurn(1, [{ type: 'message', text: '第二步完成。' }]);
    await waitFor(() =>
      expect(harness.realtime.sendBackendContext).toHaveBeenCalledWith(
        '第二步完成。',
      ),
    );
  });

  it('starts an accepted steering request as the next turn when it misses the final drain', async () => {
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
    await waitFor(() =>
      expect(harness.bridge.enqueueMidTurnMessage).toHaveBeenCalledOnce(),
    );

    harness.settleQueuedMidTurn();
    await waitFor(() => expect(harness.pendingTurns).toHaveLength(2));
    expect(harness.promptRequests[1]).toMatchObject({
      sessionId: 'live-new',
      prompt: '第二步',
      deadlineMs: 10 * 60_000,
    });

    await harness.finishTurn(0, [{ type: 'message', text: '第一步完成。' }]);
    await harness.finishTurn(1, [{ type: 'message', text: '第二步完成。' }]);
    await waitFor(() =>
      expect(harness.realtime.sendBackendContext).toHaveBeenCalledWith(
        '第二步完成。',
      ),
    );
  });

  it('streams backend message deltas into silent context on the Codex cadence', async () => {
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
    const promptId = harness.pendingTurns[0]!.promptId;

    harness.publish({
      type: 'session_update',
      promptId,
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { text: '增量进度' },
        },
      },
    });

    await waitFor(() =>
      expect(harness.realtime.sendHandoffUpdate).toHaveBeenCalledWith({
        callEpoch: 1,
        callId: 'handoff-1',
        output: '增量进度',
      }),
    );
  });

  it('routes backend speak_to_user to the owning Realtime conversation', async () => {
    const harness = makeHarness();
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
    });

    await harness.coordinator.speakToUser('live-new', '正在检查，请稍等。');

    expect(harness.realtime.speakToUser).toHaveBeenCalledWith(
      '正在检查，请稍等。',
    );
    await expect(
      harness.coordinator.speakToUser('another-session', '错误路由'),
    ).rejects.toThrow(/No active Live conversation owns/u);
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

  it('keeps Live usable while approved and denied tool permissions resolve', async () => {
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
      data: {
        requestId: 'permission-1',
        outcome: { outcome: 'selected', optionId: 'allow' },
      },
    });
    await Promise.resolve();
    expect(harness.host.setPendingPermission).toHaveBeenLastCalledWith(1, true);

    harness.publish({
      type: 'permission_resolved',
      data: {
        requestId: 'permission-2',
        outcome: { outcome: 'cancelled' },
      },
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
    expect(harness.realtime.close).not.toHaveBeenCalled();
    expect(harness.host.failCall).not.toHaveBeenCalled();

    harness.callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'after-permission',
      authority: 'direct',
    });
    harness.callbacks.onOutputAudioDelta?.({
      callEpoch: 1,
      responseId: 'after-permission',
      audio: new Uint8Array([7, 0]),
    });
    expect(harness.host.sendOutputAudio).toHaveBeenLastCalledWith(
      1,
      new Uint8Array([7, 0]),
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

  it('persists the remaining realtime transcript without a backend turn on stop', async () => {
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
    await expect(stopped).resolves.toBeUndefined();

    expect(harness.bridge.appendSessionLiveTranscript).toHaveBeenCalledWith(
      'live-new',
      [
        { role: 'user', text: '最后一个问题' },
        { role: 'assistant', text: '最后一个回答' },
      ],
      'qwen3.5-omni-plus-realtime',
    );
    expect(harness.bridge.sendPrompt).not.toHaveBeenCalled();
    expect(harness.pendingTurns).toHaveLength(0);
    expect(harness.bridge.spawnOrAttach).toHaveBeenCalledTimes(1);
    expect(harness.bridge.killSession).not.toHaveBeenCalled();
  });

  it('waits for the provider final before closing a just-finished utterance', async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
    });
    harness.callbacks.onSpeechStarted?.({
      callEpoch: 1,
      itemId: 'input-final',
    });

    let stopped = false;
    const stop = harness.coordinator
      .stop({ epoch: 1, callId: 'call-1' })
      .then((result) => {
        stopped = true;
        return result;
      });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(harness.realtime.commitInputAudio).toHaveBeenCalledOnce();
    expect(harness.realtime.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_500);
    expect(stopped).toBe(false);
    expect(harness.realtime.close).not.toHaveBeenCalled();

    harness.callbacks.onInputCommitted?.({
      callEpoch: 1,
      itemId: 'input-final',
    });
    harness.callbacks.onInputTranscriptDone?.({
      callEpoch: 1,
      itemId: 'input-final',
      text: '最后一个问题',
    });
    harness.callbacks.onResponseCreated?.({
      callEpoch: 1,
      responseId: 'response-final',
      inputItemId: 'input-final',
      authority: 'direct',
    });
    harness.callbacks.onDirectTranscript?.({
      callEpoch: 1,
      entries: [
        { role: 'user', text: '最后一个问题' },
        { role: 'assistant', text: '最后一个回答' },
      ],
    });
    harness.callbacks.onResponseDone?.({
      callEpoch: 1,
      responseId: 'response-final',
      inputItemId: 'input-final',
      status: 'completed',
    });

    await expect(stop).resolves.toBeUndefined();
    expect(harness.bridge.appendSessionLiveTranscript).toHaveBeenCalledWith(
      'live-new',
      [
        { role: 'user', text: '最后一个问题' },
        { role: 'assistant', text: '最后一个回答' },
      ],
      'qwen3.5-omni-plus-realtime',
    );
    expect(harness.realtime.close).toHaveBeenCalledWith();
  });

  it('reports a bounded stop failure when the provider final never arrives', async () => {
    const harness = makeHarness({ gracefulStopDrainMs: 5 });
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
    });
    harness.callbacks.onSpeechStarted?.({
      callEpoch: 1,
      itemId: 'input-final',
    });
    harness.callbacks.onInputCommitted?.({
      callEpoch: 1,
      itemId: 'input-final',
    });

    await expect(
      harness.coordinator.stop({ epoch: 1, callId: 'call-1' }),
    ).resolves.toEqual({
      error:
        'Live Voice could not confirm the final spoken input before the stop deadline.',
    });
    expect(harness.realtime.close).toHaveBeenCalledWith({
      discardPendingInput: true,
    });
  });

  it('stops immediately while backend work continues and persists the final realtime tail', async () => {
    const harness = makeHarness({
      transcriptTail: [{ role: 'user', text: '先停下语音' }],
    });
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
    });
    harness.callbacks.onDelegateCall?.({
      callEpoch: 1,
      responseId: 'response-1',
      callId: 'handoff-1',
      request: '执行长任务',
      activeTranscript: [{ role: 'user', text: '执行长任务' }],
    });
    await waitFor(() => expect(harness.pendingTurns).toHaveLength(1));

    await expect(
      harness.coordinator.stop({ epoch: 1, callId: 'call-1' }),
    ).resolves.toBeUndefined();

    expect(harness.bridge.appendSessionLiveTranscript).toHaveBeenCalledWith(
      'live-new',
      [{ role: 'user', text: '先停下语音' }],
      'qwen3.5-omni-plus-realtime',
    );
    expect(harness.pendingTurns).toHaveLength(1);
    expect(harness.realtime.close).toHaveBeenCalledOnce();

    await harness.finishTurn(0, [{ type: 'message', text: '后台已完成。' }]);
  });

  it('reports a final transcript persistence failure while stopping', async () => {
    const harness = makeHarness({
      transcriptTail: [{ role: 'user', text: '最后一句' }],
      transcriptPersistenceError: new Error('disk unavailable'),
    });
    await harness.coordinator.start({
      epoch: 1,
      callId: 'call-1',
      mode: 'new',
    });

    await expect(
      harness.coordinator.stop({ epoch: 1, callId: 'call-1' }),
    ).resolves.toEqual({
      error: 'Live Voice could not persist the final transcript.',
    });
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
