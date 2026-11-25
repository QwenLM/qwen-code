/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DaemonClient,
  DaemonSessionClient,
  createDaemonTranscriptStore,
  type DaemonEvent,
  type PromptRequest,
} from '@qwen-code/sdk/daemon';
import { DaemonWorkspaceProvider } from '../workspace/DaemonWorkspaceProvider.js';
import { DaemonSessionProvider } from './DaemonSessionProvider.js';
import { createDaemonSessionActions } from './actions.js';
import type { WebShellSessionAdapter } from './session-adapter.js';
import type {
  ActivePrompt,
  DaemonConnectionState,
  DaemonSessionNotice,
  SettledPrompt,
} from './types.js';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeAdapterClient extends DaemonClient {
  readonly capabilitiesMock = vi.fn(async () => ({
    v: 1 as const,
    mode: 'native' as const,
    features: [],
    modelServices: [],
    workspaces: [],
  }));
  readonly brandMock = vi.fn(async () => undefined);
  readonly detachMock = vi.fn(async () => undefined);
  readonly disposeMock = vi.fn();
  private readonly streamRelease = createDeferred<void>();

  constructor(opts: { baseUrl: string; token?: string }) {
    super(opts);
  }

  override async capabilities() {
    return this.capabilitiesMock();
  }

  override async brand() {
    return this.brandMock();
  }

  override async detachSession(_sessionId: string, _clientId?: string) {
    await this.detachMock();
  }

  override async *subscribeEvents(
    _sessionId: string,
    opts: Parameters<DaemonClient['subscribeEvents']>[1],
  ): AsyncGenerator<DaemonEvent> {
    opts.onSseStreamAccepted?.('adapter-stream-1');
    await Promise.race([
      this.streamRelease.promise,
      new Promise<void>((resolve) => {
        if (opts.signal?.aborted) resolve();
        else
          opts.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
      }),
    ]);
    yield* [];
  }

  override dispose() {
    this.streamRelease.resolve();
    this.disposeMock();
  }
}

function makeStandaloneSession(client: DaemonClient, sessionId = 'sa-1') {
  return new DaemonSessionClient({
    client,
    session: {
      sessionId,
      attached: false,
      clientId: 'client-adapter-1',
      sourceType: 'standalone',
      context: { kind: 'standalone' },
    },
  });
}

describe('WebShellSessionAdapter', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = undefined;
    }
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  it('does not recreate client or leak raw REST detach when re-rendered with inline sessionAdapter', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 404 }));
    const createdClients: FakeAdapterClient[] = [];
    const createClient = vi.fn((opts: { baseUrl: string; token?: string }) => {
      const client = new FakeAdapterClient(opts);
      createdClients.push(client);
      return client;
    });
    const load = vi.fn(async (client: DaemonClient, sessionId: string) =>
      makeStandaloneSession(client, sessionId),
    );
    const create = vi.fn(async (client: DaemonClient) =>
      makeStandaloneSession(client, 'sa-created'),
    );
    const submitPrompt = vi.fn(async () => ({
      promptId: 'p-1',
      completion: Promise.resolve(),
    }));

    const buildAdapter = (): WebShellSessionAdapter => ({
      createClient,
      create,
      load,
      submitPrompt,
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        <DaemonWorkspaceProvider
          baseUrl="http://host.example"
          sessionAdapter={buildAdapter()}
        >
          <DaemonSessionProvider
            sessionContext={{ kind: 'standalone' }}
            sessionId="sa-42"
            sessionAdapter={buildAdapter()}
          >
            <div />
          </DaemonSessionProvider>
        </DaemonWorkspaceProvider>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);

    // Re-render with fresh inline adapter object identities.
    await act(async () => {
      root!.render(
        <DaemonWorkspaceProvider
          baseUrl="http://host.example"
          sessionAdapter={buildAdapter()}
        >
          <DaemonSessionProvider
            sessionContext={{ kind: 'standalone' }}
            sessionId="sa-42"
            sessionAdapter={buildAdapter()}
          >
            <div />
          </DaemonSessionProvider>
        </DaemonWorkspaceProvider>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(createdClients[0]!.disposeMock).not.toHaveBeenCalled();

    // Unmount should detach through session.detach(), never raw REST fetch.
    await act(async () => {
      root!.unmount();
    });
    root = undefined;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(createdClients[0]!.detachMock).toHaveBeenCalledTimes(1);
    const detachFetchCalls = fetchSpy.mock.calls.filter(([input]) =>
      String(input).includes('/detach'),
    );
    expect(detachFetchCalls).toHaveLength(0);
  });

  it('sendPrompt settles when turn completes without hanging on completion and surfaces post-admission stream failure without retrying', async () => {
    const client = new FakeAdapterClient({ baseUrl: 'http://host.example' });
    const session = makeStandaloneSession(client, 'sa-prompt');
    vi.spyOn(session, 'waitForEventStream').mockResolvedValue(undefined);

    const store = createDaemonTranscriptStore();
    const activePromptsRef = { current: new Map<string, ActivePrompt>() };
    const settledPromptsRef = { current: new Map<string, SettledPrompt>() };
    const notices: DaemonSessionNotice[] = [];
    let connection: DaemonConnectionState = {
      status: 'connected',
      sessionId: session.sessionId,
      sessionContext: { kind: 'standalone' },
    };

    const submitPrompt = vi.fn<WebShellSessionAdapter['submitPrompt']>();
    const adapter: WebShellSessionAdapter = {
      createClient: () => client,
      create: async () => session,
      load: async () => session,
      submitPrompt,
    };

    const actions = createDaemonSessionActions({
      store,
      sessionRef: { current: session },
      getSessionAdapter: () => adapter,
      activePromptsRef,
      settledPromptsRef,
      pendingSessionLoadRef: { current: undefined },
      pendingSessionLoadIdRef: { current: 0 },
      sessionConfigGeneration: new WeakMap(),
      sessionRecoveryGeneration: new WeakMap(),
      heartbeatSupportedRef: { current: false },
      manualSessionClearRef: { current: false },
      skipNextCleanupDetachSessionRef: { current: undefined },
      passiveAssistantDoneTimerRef: { current: undefined },
      daemonActivePromptRef: { current: undefined },
      getClient: () => client,
      getCreateSessionRequest: () => ({}),
      createDetachedSession: async () => session,
      createDetachedStandaloneSession: async () => session,
      getDefaultSessionContext: () => ({ kind: 'standalone' }),
      getConnection: () => connection,
      getPromptStatus: () => 'idle',
      getEventDetailMode: () => 'summary',
      hasSessionActivePrompt: () => false,
      resetCurrentSessionActivePrompt: () => {},
      restartEventStream: vi.fn(),
      addNotice: (notice) => notices.push(notice),
      setConnection: (updater) => {
        connection =
          typeof updater === 'function' ? updater(connection) : updater;
      },
      setPromptStatus: () => {},
      setRestoreSessionId: () => {},
      setRestoreSessionContext: () => {},
      setRestoreMode: () => {},
      setRestoreSessionNonce: () => {},
      setAttachSessionNonce: () => {},
      setNewSessionNonce: () => {},
    });

    // 1. Stream fails after admission -> rejects once, no automatic retry, closes assistant block.
    const failingCompletion = createDeferred<void>();
    submitPrompt.mockResolvedValueOnce({
      promptId: 'p-fail',
      completion: failingCompletion.promise,
    });
    const failedTurn = actions.sendPrompt('hello', {
      idempotencyKey: 'idem-1',
    });
    await new Promise((r) => setTimeout(r, 0));
    failingCompletion.reject(new Error('stream interrupted'));

    await expect(failedTurn).rejects.toThrow('stream interrupted');
    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(notices.some((n) => n.operation === 'send_prompt')).toBe(true);
    // Optimistic local user message is suppressed for adapter sessions.
    expect(
      store.getSnapshot().blocks.filter((b) => b.kind === 'user'),
    ).toHaveLength(0);

    // 2. Turn completes via event stream while completion stays pending -> resolves immediately.
    const hangingCompletion = createDeferred<void>();
    submitPrompt.mockImplementationOnce(
      async (_s: DaemonSessionClient, _req: PromptRequest) => ({
        promptId: 'p-ok',
        completion: hangingCompletion.promise,
      }),
    );
    const okTurn = actions.sendPrompt('follow up');
    await new Promise((r) => setTimeout(r, 0));
    activePromptsRef.current
      .get(session.sessionId)
      ?.resolve?.({ stopReason: 'end_turn' });

    await expect(okTurn).resolves.toEqual({ stopReason: 'end_turn' });
    // Late rejection after turn settled must not surface as unhandled rejection.
    hangingCompletion.reject(new Error('late close'));
    await new Promise((r) => setTimeout(r, 0));
  });
});
