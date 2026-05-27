/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonEvent,
  DaemonTranscriptBlock,
  DaemonUiSessionActions,
  PromptResult,
} from '@qwen-code/sdk/daemon';
import {
  DaemonSessionProvider,
  useDaemonActions,
  useDaemonConnection,
  useDaemonTranscriptBlocks,
  useDaemonTranscriptState,
  type DaemonSessionProviderProps,
  type DaemonConnectionState,
} from './DaemonSessionProvider.js';

interface MockSession {
  sessionId: string;
  workspaceCwd: string;
  clientId: string;
  lastEventId?: number;
  prompt: (req: unknown, signal?: AbortSignal) => Promise<PromptResult>;
  cancel: () => Promise<void>;
  setModel: (modelId: string) => Promise<{ modelId: string }>;
  respondToSessionPermission: () => Promise<boolean>;
  events: (opts?: {
    signal?: AbortSignal;
    maxQueued?: number;
  }) => AsyncGenerator<DaemonEvent, void, unknown>;
}

const sdkMocks = vi.hoisted(() => {
  const sessions: MockSession[] = [];
  const capabilities = vi.fn();

  class MockDaemonClient {
    constructor(_opts: unknown) {}

    capabilities = capabilities;
  }

  class MockDaemonSessionClient {
    static createOrAttach = vi.fn(
      async (_client: unknown, _req: unknown): Promise<MockSession> => {
        const session = sessions.shift();
        if (!session) throw new Error('No mock daemon session queued');
        return session;
      },
    );
  }

  return {
    sessions,
    capabilities,
    MockDaemonClient,
    MockDaemonSessionClient,
    reset() {
      sessions.length = 0;
      capabilities.mockReset();
      capabilities.mockResolvedValue({ workspaceCwd: '/mock-workspace' });
      MockDaemonSessionClient.createOrAttach.mockReset();
      MockDaemonSessionClient.createOrAttach.mockImplementation(
        async (_client: unknown, _req: unknown): Promise<MockSession> => {
          const session = sessions.shift();
          if (!session) throw new Error('No mock daemon session queued');
          return session;
        },
      );
    },
  };
});

vi.mock('@qwen-code/sdk/daemon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@qwen-code/sdk/daemon')>();
  return {
    ...actual,
    DaemonClient: sdkMocks.MockDaemonClient,
    DaemonSessionClient: sdkMocks.MockDaemonSessionClient,
  };
});

describe('DaemonSessionProvider', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    sdkMocks.reset();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  it('exposes idle connection state without auto connect', async () => {
    let connection: DaemonConnectionState | undefined;
    let blocks: readonly DaemonTranscriptBlock[] | undefined;

    function Harness() {
      connection = useDaemonConnection();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />);

    expect(connection).toEqual({ status: 'idle' });
    expect(blocks).toEqual([]);
  });

  it('records action errors when no session is connected', async () => {
    let actions: DaemonUiSessionActions | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      actions = useDaemonActions();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />);
    const providerActions = actions;
    if (!providerActions) throw new Error('actions were not initialized');

    await act(async () => {
      await expect(providerActions.sendPrompt('hi')).rejects.toThrow(
        'Daemon session is not connected',
      );
    });
    expect(blocks).toMatchObject([
      {
        kind: 'error',
        text: 'Prompt failed: Daemon session is not connected',
      },
    ]);

    await act(async () => {
      await expect(providerActions.cancel()).rejects.toThrow(
        'Daemon session is not connected',
      );
    });
    expect(blocks).toMatchObject([
      { text: 'Prompt failed: Daemon session is not connected' },
      { text: 'Cancel failed: Daemon session is not connected' },
    ]);

    await act(async () => {
      await expect(providerActions.setModel('qwen-plus')).rejects.toThrow(
        'Daemon session is not connected',
      );
    });
    expect(blocks).toMatchObject([
      { text: 'Prompt failed: Daemon session is not connected' },
      { text: 'Cancel failed: Daemon session is not connected' },
      { text: 'Set model failed: Daemon session is not connected' },
    ]);

    await act(async () => {
      await expect(
        providerActions.respondToPermission('perm-1', {
          outcome: {
            outcome: 'selected',
            optionId: 'allow',
          },
        }),
      ).rejects.toThrow('Daemon session is not connected');
    });
    expect(blocks).toMatchObject([
      { text: 'Prompt failed: Daemon session is not connected' },
      { text: 'Cancel failed: Daemon session is not connected' },
      { text: 'Set model failed: Daemon session is not connected' },
      { text: 'Permission response failed: Daemon session is not connected' },
    ]);
  });

  it('prevents double submit while a prompt is running', async () => {
    const prompt = createDeferred<PromptResult>();
    const session = createMockSession({
      prompt: vi.fn(() => prompt.promise),
      events: createIdleEvents(),
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonUiSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    const providerActions = requireActions(actions);

    let firstPrompt: Promise<unknown> | undefined;
    await act(async () => {
      firstPrompt = providerActions.sendPrompt('first');
      await flushPromises();
    });

    await act(async () => {
      await expect(providerActions.sendPrompt('second')).rejects.toThrow(
        'A prompt is already in progress',
      );
    });

    prompt.resolve({ stopReason: 'end_turn' });
    const runningPrompt = firstPrompt;
    if (!runningPrompt) throw new Error('prompt was not started');
    await act(async () => {
      await expect(runningPrompt).resolves.toEqual({ stopReason: 'end_turn' });
    });
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  it('treats prompt abort during cancel as cancellation and keeps busy until cancel completes', async () => {
    const cancel = createDeferred<void>();
    const assistantChunk = createDeferred<void>();
    let promptCalls = 0;
    const session = createMockSession({
      prompt: vi.fn((_req: unknown, signal?: AbortSignal) => {
        promptCalls += 1;
        if (promptCalls > 1) return Promise.resolve({ stopReason: 'end_turn' });
        return new Promise<PromptResult>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(createAbortError()), {
            once: true,
          });
        });
      }),
      cancel: vi.fn(() => cancel.promise),
      events: async function* assistantThenIdleEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        await assistantChunk.promise;
        yield {
          id: 10,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'streaming' },
            },
          },
        };
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve();
            return;
          }
          opts.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
      },
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonUiSessionActions | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      actions = useDaemonActions();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    const providerActions = requireActions(actions);

    let promptResult: Promise<unknown> | undefined;
    let cancelResult: Promise<void> | undefined;
    await act(async () => {
      promptResult = providerActions.sendPrompt('cancel me');
      await flushPromises();
      assistantChunk.resolve();
      await flushPromises();
    });
    expect(blocks).toMatchObject([
      { kind: 'user', text: 'cancel me' },
      { kind: 'assistant', text: 'streaming', streaming: true },
    ]);

    await act(async () => {
      cancelResult = providerActions.cancel();
      await flushPromises();
    });

    const cancelledPrompt = promptResult;
    if (!cancelledPrompt) throw new Error('prompt was not started');
    await expect(cancelledPrompt).resolves.toEqual({
      stopReason: 'cancelled',
    });
    await act(async () => {
      await expect(providerActions.sendPrompt('blocked')).rejects.toThrow(
        'A prompt is already in progress',
      );
    });

    cancel.resolve();
    const pendingCancel = cancelResult;
    if (!pendingCancel) throw new Error('cancel was not started');
    await act(async () => {
      await pendingCancel;
    });
    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(blocks[0]).toMatchObject({ kind: 'user', text: 'cancel me' });
    expect(blocks[1]).toMatchObject({
      kind: 'assistant',
      text: 'streaming',
      streaming: false,
    });
    await act(async () => {
      await expect(providerActions.sendPrompt('after cancel')).resolves.toEqual(
        {
          stopReason: 'end_turn',
        },
      );
    });
    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(
      blocks.some(
        (block) => block.kind === 'error' && block.text.includes('AbortError'),
      ),
    ).toBe(false);
  });

  it('ends assistant streaming when prompt fails with a non-abort error', async () => {
    const prompt = createDeferred<PromptResult>();
    const assistantChunk = createDeferred<void>();
    const session = createMockSession({
      prompt: vi.fn(() => prompt.promise),
      events: async function* assistantThenIdleEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        await assistantChunk.promise;
        yield {
          id: 11,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'partial' },
            },
          },
        };
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve();
            return;
          }
          opts.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
      },
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonUiSessionActions | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      actions = useDaemonActions();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    const providerActions = requireActions(actions);

    let promptResult: Promise<unknown> | undefined;
    await act(async () => {
      promptResult = providerActions.sendPrompt('fail later');
      await flushPromises();
      assistantChunk.resolve();
      await flushPromises();
    });
    expect(blocks).toMatchObject([
      { kind: 'user', text: 'fail later' },
      { kind: 'assistant', text: 'partial', streaming: true },
    ]);

    prompt.reject(new Error('network down'));
    const failedPrompt = promptResult;
    if (!failedPrompt) throw new Error('prompt was not started');
    await act(async () => {
      await expect(failedPrompt).rejects.toThrow('network down');
    });

    expect(blocks).toMatchObject([
      { kind: 'user', text: 'fail later' },
      { kind: 'assistant', text: 'partial', streaming: false },
      { kind: 'error', text: 'Prompt failed: network down' },
    ]);
  });

  it('exposes catchingUp on resume and clears it on replay_complete', async () => {
    // Resume subscriptions (session carries a Last-Event-ID) get a
    // deterministic catch-up indicator: `catchingUp` arms on connect and
    // clears when the daemon's `replay_complete` sentinel arrives.
    const replayDrained = createDeferred<void>();
    const session = createMockSession({
      lastEventId: 5,
      events: async function* resumeThenIdle(
        opts: { signal?: AbortSignal } = {},
      ) {
        // First a replayed history frame, then the sentinel, then idle.
        yield {
          id: 6,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'replayed' },
            },
          },
        };
        yield {
          v: 1,
          type: 'replay_complete',
          data: { replayedCount: 1, lastReplayedEventId: 6 },
        };
        replayDrained.resolve();
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve();
            return;
          }
          opts.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
      },
    });
    sdkMocks.sessions.push(session);

    const states: DaemonConnectionState[] = [];
    function Harness() {
      const connection = useDaemonConnection();
      states.push(connection);
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await replayDrained.promise;
      await flushPromises();
    });

    // While catching up we surface catchingUp:true; after replay_complete
    // it clears to a plain connected state.
    expect(states.some((s) => s.status === 'connected' && s.catchingUp)).toBe(
      true,
    );
    const last = states[states.length - 1];
    expect(last?.status).toBe('connected');
    expect(last?.catchingUp).toBeFalsy();
  });

  it('never sets catchingUp on a fresh subscription (no Last-Event-ID)', async () => {
    // A first-time attach has no resume cursor → the daemon emits no
    // replay_complete → arming catchingUp would stick forever. The Provider
    // only arms it when session.lastEventId is defined.
    const session = createMockSession({
      lastEventId: undefined, // fresh subscribe, live tail
      events: createIdleEvents(),
    });
    sdkMocks.sessions.push(session);

    const states: DaemonConnectionState[] = [];
    function Harness() {
      states.push(useDaemonConnection());
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await flushPromises();
    });

    expect(states.some((s) => s.status === 'connected')).toBe(true);
    expect(states.every((s) => !s.catchingUp)).toBe(true);
  });

  it('clears prompt state and transcript when reconnect attaches a different session', async () => {
    const firstEvents = createClosableEvents();
    const firstSession = createMockSession({
      sessionId: 'session-a',
      prompt: vi.fn(
        (_req: unknown, signal?: AbortSignal) =>
          new Promise<PromptResult>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(createAbortError()),
              { once: true },
            );
          }),
      ),
      events: async function* missingSessionEvents() {
        await firstEvents.closed.promise;
        yield* [];
        throw Object.assign(new Error('missing session'), { status: 404 });
      },
    });
    const secondSession = createMockSession({
      sessionId: 'session-b',
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      events: createIdleEvents(),
    });
    sdkMocks.sessions.push(firstSession, secondSession);
    let actions: DaemonUiSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    const providerActions = requireActions(actions);

    let promptResult: Promise<unknown> | undefined;
    await act(async () => {
      promptResult = providerActions.sendPrompt('old prompt');
      await flushPromises();
    });
    expect(blocks).toMatchObject([{ kind: 'user', text: 'old prompt' }]);

    firstEvents.close();
    await act(async () => {
      await wait(20);
      await flushPromises();
    });

    expect(connection).toMatchObject({ sessionId: 'session-b' });
    expect(blocks).toEqual([]);
    const abortedPrompt = promptResult;
    if (!abortedPrompt) throw new Error('prompt was not started');
    await expect(abortedPrompt).resolves.toEqual({ stopReason: 'cancelled' });

    await act(async () => {
      await expect(providerActions.sendPrompt('new prompt')).resolves.toEqual({
        stopReason: 'end_turn',
      });
    });
    expect(secondSession.prompt).toHaveBeenCalledTimes(1);
  });

  it('reuses the same session client after a normal SSE stream end', async () => {
    const events = vi.fn(async function* reusableEvents(
      opts: { signal?: AbortSignal } = {},
    ) {
      if (events.mock.calls.length === 1) {
        const event: DaemonEvent = {
          id: 5,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'hello' },
            },
          },
        };
        yield event;
        return;
      }
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) {
          resolve();
          return;
        }
        opts.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
      yield* [];
    });
    const session = createMockSession({ events });
    sdkMocks.sessions.push(session);
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await wait(5);
      await flushPromises();
    });

    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledTimes(2);
    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'hello' },
      { kind: 'status', text: 'SSE stream ended' },
    ]);
  });

  it('ignores stale connect attempts after provider props change', async () => {
    const staleAttach = createDeferred<MockSession>();
    const staleSession = createMockSession({ sessionId: 'session-a' });
    const activeSession = createMockSession({ sessionId: 'session-b' });
    sdkMocks.MockDaemonSessionClient.createOrAttach
      .mockImplementationOnce(async () => staleAttach.promise)
      .mockImplementationOnce(async () => activeSession);
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect={true}
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });
    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).toHaveBeenCalledTimes(1);

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4171"
          autoConnect={true}
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });
    expect(connection).toMatchObject({ sessionId: 'session-b' });

    staleAttach.resolve(staleSession);
    await act(async () => {
      await flushPromises();
    });
    expect(connection).toMatchObject({ sessionId: 'session-b' });
  });

  it('does not reconnect when event processing options change', async () => {
    const session = createMockSession({ events: createIdleEvents() });
    sdkMocks.sessions.push(session);

    function Harness() {
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect={true}
          includeRawEvent={false}
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect={true}
          includeRawEvent={true}
          suppressOwnUserEcho={false}
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });

    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).toHaveBeenCalledTimes(1);
  });

  it('surfaces SSE stream end and clears the session when reconnect is disabled', async () => {
    const session = createMockSession({ events: createClosedEvents() });
    sdkMocks.sessions.push(session);
    let actions: DaemonUiSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    const providerActions = requireActions(actions);

    await act(async () => {
      await flushPromises();
    });

    expect(connection).toMatchObject({ status: 'disconnected' });
    expect(blocks).toMatchObject([
      { kind: 'status', text: 'SSE stream ended' },
    ]);
    await act(async () => {
      await expect(providerActions.cancel()).rejects.toThrow(
        'Daemon session is not connected',
      );
    });
  });

  it('clears stale sessions on terminal HTTP stream errors', async () => {
    const session = createMockSession({
      events: async function* terminalErrorEvents() {
        await Promise.resolve();
        yield* [];
        throw Object.assign(new Error('session gone'), { status: 410 });
      },
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonUiSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    const providerActions = requireActions(actions);

    await act(async () => {
      await flushPromises();
    });

    expect(connection).toMatchObject({
      status: 'error',
      error: 'session gone',
    });
    expect(connection?.sessionId).toBeUndefined();
    await act(async () => {
      await expect(providerActions.cancel()).rejects.toThrow(
        'Daemon session is not connected',
      );
    });
  });

  it.each([401, 403])(
    'breaks out of the reconnect loop on %d auth failures even when autoReconnect is true (wenshao CRIT #1)',
    async (status) => {
      // Simulates a daemon that consistently returns 401 (bad token). Pre-fix,
      // autoReconnect: true would loop forever calling createOrAttach,
      // generating a reconnection storm and wiping the user's transcript on
      // every cycle. After the fix, the provider treats 401/403 as terminal
      // regardless of autoReconnect.
      let createAttempts = 0;
      sdkMocks.MockDaemonSessionClient.createOrAttach.mockImplementation(
        async () => {
          createAttempts += 1;
          throw Object.assign(new Error('Unauthorized'), { status });
        },
      );

      let connection: DaemonConnectionState | undefined;
      function Harness() {
        connection = useDaemonConnection();
        return null;
      }

      await renderWithProvider(<Harness />, {
        autoConnect: true,
        autoReconnect: true, // ← critical: must NOT loop
        reconnectDelayMs: 1, // keep timing tight in case it does loop
        maxReconnectDelayMs: 1,
      });

      await act(async () => {
        await flushPromises();
      });
      // Give any potential reconnect timer a window to fire.
      await act(async () => {
        await wait(20);
        await flushPromises();
      });

      expect(connection).toMatchObject({
        status: 'error',
        error: 'Unauthorized',
      });
      // No sessionId on auth-failure terminal state.
      expect(connection?.sessionId).toBeUndefined();
      // Crucial: only ONE attempt happened. Pre-fix, multiple attempts would
      // have occurred during the wait above. We assert exactly 1 to lock in
      // the no-storm invariant.
      expect(createAttempts).toBe(1);
    },
  );

  it.each([404, 410])(
    'still reconnects on %d session-not-found errors when autoReconnect is true',
    async (status) => {
      // Verifies the fix did NOT over-correct: 404/410 are session-not-found
      // (recoverable by creating a fresh session), not credential failures.
      // Pre-fix and post-fix behavior should be identical for these statuses.
      let createAttempts = 0;
      sdkMocks.MockDaemonSessionClient.createOrAttach.mockImplementation(
        async () => {
          createAttempts += 1;
          if (createAttempts === 1) {
            throw Object.assign(new Error('session gone'), { status });
          }
          // Second attempt succeeds.
          return createMockSession({ sessionId: `session-${createAttempts}` });
        },
      );

      let connection: DaemonConnectionState | undefined;
      function Harness() {
        connection = useDaemonConnection();
        return null;
      }

      await renderWithProvider(<Harness />, {
        autoConnect: true,
        autoReconnect: true,
        reconnectDelayMs: 1,
        maxReconnectDelayMs: 1,
      });

      await act(async () => {
        await wait(30);
        await flushPromises();
      });

      // 410 path: SHOULD have retried at least once (so connect succeeded on
      // attempt #2). This is the contrast case with the 401 test above.
      expect(createAttempts).toBeGreaterThanOrEqual(2);
      expect(connection?.status).not.toBe('error');
    },
  );

  it.each([401, 403])(
    'preserves transcript and clears prompt state on %d auth failures from the SSE stream',
    async (status) => {
      const streamFailure = createDeferred<void>();
      const session = createMockSession({
        prompt: vi.fn(
          (_req: unknown, signal?: AbortSignal) =>
            new Promise<PromptResult>((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => reject(createAbortError()),
                { once: true },
              );
            }),
        ),
        events: async function* authFailureEvents() {
          await streamFailure.promise;
          yield* [];
          throw Object.assign(new Error('Unauthorized'), { status });
        },
      });
      sdkMocks.sessions.push(session);
      let actions: DaemonUiSessionActions | undefined;
      let connection: DaemonConnectionState | undefined;
      let blocks: readonly DaemonTranscriptBlock[] = [];

      function Harness() {
        actions = useDaemonActions();
        connection = useDaemonConnection();
        blocks = useDaemonTranscriptBlocks();
        return null;
      }

      await renderWithProvider(<Harness />, {
        autoConnect: true,
        autoReconnect: true,
        reconnectDelayMs: 1,
        maxReconnectDelayMs: 1,
      });
      const providerActions = requireActions(actions);

      let promptResult: Promise<unknown> | undefined;
      await act(async () => {
        promptResult = providerActions.sendPrompt('keep transcript');
        await flushPromises();
      });
      expect(blocks).toMatchObject([{ kind: 'user', text: 'keep transcript' }]);

      streamFailure.resolve();
      await act(async () => {
        await wait(20);
        await flushPromises();
      });

      const runningPrompt = promptResult;
      if (!runningPrompt) throw new Error('prompt was not started');
      await expect(runningPrompt).resolves.toEqual({
        stopReason: 'cancelled',
      });
      expect(connection).toMatchObject({
        status: 'error',
        error: 'Unauthorized',
      });
      expect(blocks[0]).toMatchObject({
        kind: 'user',
        text: 'keep transcript',
      });
      expect(blocks).toContainEqual(
        expect.objectContaining({
          kind: 'error',
          text: 'Unauthorized',
        }) as DaemonTranscriptBlock,
      );
      expect(
        sdkMocks.MockDaemonSessionClient.createOrAttach,
      ).toHaveBeenCalledTimes(1);
      await act(async () => {
        await expect(providerActions.sendPrompt('after auth')).rejects.toThrow(
          'Daemon session is not connected',
        );
      });
    },
  );

  it.each([
    [
      'cancel',
      (actions: DaemonUiSessionActions) => actions.cancel(),
      'Cancel failed: Cancel timed out after 30000ms',
    ],
    [
      'setModel',
      (actions: DaemonUiSessionActions) => actions.setModel('qwen-plus'),
      'Set model failed: Set model timed out after 30000ms',
    ],
    [
      'respondToPermission',
      (actions: DaemonUiSessionActions) =>
        actions.respondToPermission('perm-1', {
          outcome: { outcome: 'selected', optionId: 'allow' },
        }),
      'Permission response failed: Permission response timed out after 30000ms',
    ],
  ])('times out hung %s actions', async (_name, invoke, expectedError) => {
    vi.useFakeTimers();
    try {
      const session = createMockSession({
        cancel: vi.fn(() => new Promise<void>(() => {})),
        setModel: vi.fn(() => new Promise<{ modelId: string }>(() => {})),
        respondToSessionPermission: vi.fn(() => new Promise<boolean>(() => {})),
        events: createIdleEvents(),
      });
      sdkMocks.sessions.push(session);
      let actions: DaemonUiSessionActions | undefined;
      let blocks: readonly DaemonTranscriptBlock[] = [];

      function Harness() {
        actions = useDaemonActions();
        blocks = useDaemonTranscriptBlocks();
        return null;
      }

      await renderWithProvider(<Harness />, { autoConnect: true });
      const providerActions = requireActions(actions);

      let actionResult: Promise<unknown> | undefined;
      let actionError: Promise<unknown> | undefined;
      await act(async () => {
        actionResult = invoke(providerActions);
        actionError = actionResult.catch((error: unknown) => error);
        await flushPromises();
      });
      await act(async () => {
        vi.advanceTimersByTime(30_000);
        await flushPromises();
      });

      const pendingAction = actionResult;
      if (!pendingAction) throw new Error('action was not started');
      const observedError = await actionError;
      expect(observedError).toBeInstanceOf(Error);
      expect((observedError as Error).message).toBe(
        expectedError.replace(/^.*?: /, ''),
      );
      expect(blocks.at(-1)).toMatchObject({ text: expectedError });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears awaitingResync on same-session reconnect after state_resync_required', async () => {
    // Regression test: if `state_resync_required` arms the awaitingResync
    // latch and then the SSE connection drops, a same-session reconnect
    // must clear the latch. Otherwise the transcript reducer permanently
    // drops all subsequent events.
    const firstStreamDone = createDeferred<void>();
    let streamCount = 0;

    const session = createMockSession({
      lastEventId: 10,
      events: async function* resyncThenReconnect(
        opts: { signal?: AbortSignal } = {},
      ) {
        streamCount += 1;
        if (streamCount === 1) {
          // First stream: emit state_resync_required, then close.
          yield {
            id: 11,
            v: 1,
            type: 'state_resync_required',
            data: {
              reason: 'epoch_reset',
              lastDeliveredId: 10,
              earliestAvailableId: 12,
            },
          };
          firstStreamDone.resolve();
          return; // stream closes → triggers reconnect
        }
        // Second stream (reconnect): emit replay_complete then idle.
        yield {
          v: 1,
          type: 'replay_complete',
          data: { replayedCount: 0, lastReplayedEventId: 11 },
        };
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve();
            return;
          }
          opts.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
      },
    });
    // Queue the same session twice (reconnect reuses it).
    sdkMocks.sessions.push(session, session);

    let awaitingResync = false;
    function Harness() {
      const state = useDaemonTranscriptState();
      awaitingResync = state.awaitingResync;
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });

    // Wait for first stream to emit state_resync_required.
    await act(async () => {
      await firstStreamDone.promise;
      await flushPromises();
    });
    // Latch should have been armed by the event.
    expect(awaitingResync).toBe(true);

    // Wait for reconnect to clear it.
    await act(async () => {
      await wait(30);
      await flushPromises();
    });
    expect(awaitingResync).toBe(false);
  });

  async function renderWithProvider(
    children: ReactNode,
    props: Partial<DaemonSessionProviderProps> = {},
  ) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect={false}
          {...props}
        >
          {children}
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });
  }
});

function requireActions(
  actions: DaemonUiSessionActions | undefined,
): DaemonUiSessionActions {
  if (!actions) throw new Error('actions were not initialized');
  return actions;
}

function createMockSession(opts: Partial<MockSession> = {}): MockSession {
  return {
    sessionId: opts.sessionId ?? 'session-1',
    workspaceCwd: opts.workspaceCwd ?? '/mock-workspace',
    clientId: opts.clientId ?? 'client-1',
    lastEventId: opts.lastEventId,
    prompt:
      opts.prompt ??
      vi.fn(async () => ({
        stopReason: 'end_turn',
      })),
    cancel: opts.cancel ?? vi.fn(async () => {}),
    setModel:
      opts.setModel ??
      vi.fn(async (modelId: string) => ({
        modelId,
      })),
    respondToSessionPermission:
      opts.respondToSessionPermission ?? vi.fn(async () => true),
    events: opts.events ?? createIdleEvents(),
  };
}

function createIdleEvents(): MockSession['events'] {
  return async function* idleEvents(opts: { signal?: AbortSignal } = {}) {
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted) {
        resolve();
        return;
      }
      opts.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    yield* [];
  };
}

function createClosedEvents(): MockSession['events'] {
  return async function* closedEvents() {
    await Promise.resolve();
    yield* [];
  };
}

function createClosableEvents(): {
  events: MockSession['events'];
  close: () => void;
  closed: ReturnType<typeof createDeferred<void>>;
} {
  const closed = createDeferred<void>();
  return {
    events: async function* closableEvents() {
      await closed.promise;
      yield* [];
    },
    close: closed.resolve,
    closed,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => res(value as T | PromiseLike<T>);
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}
