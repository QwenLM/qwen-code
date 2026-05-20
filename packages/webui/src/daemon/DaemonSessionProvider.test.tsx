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
  type DaemonSessionProviderProps,
  type DaemonConnectionState,
} from './DaemonSessionProvider.js';

interface MockSession {
  sessionId: string;
  workspaceCwd: string;
  clientId: string;
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

  class MockDaemonClient {
    constructor(_opts: unknown) {}

    capabilities = vi.fn(async () => ({
      workspaceCwd: '/mock-workspace',
    }));
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
    MockDaemonClient,
    MockDaemonSessionClient,
    reset() {
      sessions.length = 0;
      MockDaemonSessionClient.createOrAttach.mockClear();
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

    let promptResult: Promise<unknown> | undefined;
    let cancelResult: Promise<void> | undefined;
    await act(async () => {
      promptResult = providerActions.sendPrompt('cancel me');
      await flushPromises();
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
