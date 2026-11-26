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
  type DaemonEvent,
} from '@qwen-code/sdk/daemon';
import { DaemonWorkspaceProvider } from '../workspace/DaemonWorkspaceProvider.js';
import {
  DaemonSessionProvider,
  useDaemonSession,
  useDaemonPromptSettled,
} from './DaemonSessionProvider.js';
import type { WebShellSessionAdapter } from './session-adapter.js';
import type { DaemonSessionContextValue } from './types.js';

class FakeAdapterClient extends DaemonClient {
  readonly detachMock = vi.fn(async () => undefined);
  readonly disposeMock = vi.fn();
  readonly promptEvents = Promise.withResolvers<DaemonEvent[]>();
  readonly streamReady = Promise.withResolvers<void>();

  override async capabilities() {
    return {
      v: 1 as const,
      mode: 'native' as const,
      features: [],
      modelServices: [],
      workspaces: [],
    };
  }

  override async brand() {
    return undefined;
  }

  override async detachSession() {
    await this.detachMock();
  }

  override async *subscribeEvents(
    _sessionId: string,
    opts: Parameters<DaemonClient['subscribeEvents']>[1],
  ): AsyncGenerator<DaemonEvent> {
    const { promise: aborted, resolve: onAbort } =
      Promise.withResolvers<void>();
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    await Promise.race([this.streamReady.promise, aborted]);
    if (opts.signal?.aborted) return;
    opts.onEventStreamReady?.();
    const events = await Promise.race([this.promptEvents.promise, aborted]);
    if (events) yield* events;
    await aborted;
  }

  override dispose() {
    this.disposeMock();
  }
}

describe('WebShellSessionAdapter provider lifecycle', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = undefined;
    }
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  it('renders and finishes adapter turns without a terminal event, reuses the client, and detaches on unmount', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 404 }));
    const clients: FakeAdapterClient[] = [];
    const createClient = vi.fn((opts: { baseUrl: string; token?: string }) => {
      const client = new FakeAdapterClient(opts);
      clients.push(client);
      return client;
    });
    const load = vi.fn(
      async (client: DaemonClient, sessionId: string) =>
        new DaemonSessionClient({
          client,
          session: {
            sessionId,
            attached: false,
            clientId: 'client-adapter-1',
            sourceType: 'standalone',
            context: { kind: 'standalone' },
          },
        }),
    );
    const completion = Promise.withResolvers<void>();
    const buildAdapter = (): WebShellSessionAdapter => ({
      createClient,
      create: async (client) => load(client, 'sa-created'),
      load,
      submitPrompt: async (_session, request) => {
        clients[0]!.promptEvents.resolve([
          {
            id: 1,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'user_message_chunk',
                content: request.prompt[0],
              },
            },
          },
          {
            id: 2,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Host reply' },
              },
            },
          },
        ]);
        return { promptId: 'p-1', completion: completion.promise };
      },
    });
    let session: DaemonSessionContextValue | undefined;
    const onSettled = vi.fn();
    function Harness() {
      session = useDaemonSession();
      useDaemonPromptSettled(onSettled);
      return null;
    }
    const renderTree = () => (
      <DaemonWorkspaceProvider
        baseUrl="http://host.example"
        sessionAdapter={buildAdapter()}
      >
        <DaemonSessionProvider
          sessionContext={{ kind: 'standalone' }}
          sessionId="sa-42"
          sessionAdapter={buildAdapter()}
        >
          <Harness />
        </DaemonSessionProvider>
      </DaemonWorkspaceProvider>
    );

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root!.render(renderTree()));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => root!.render(renderTree()));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(clients[0]!.disposeMock).not.toHaveBeenCalled();

    const onAdmitted = vi.fn();
    const turn = Promise.withResolvers<void>();
    await act(async () => {
      void session!.actions
        .sendPrompt('Host-owned prompt', { onAdmitted })
        .then(() => turn.resolve(), turn.reject);
    });
    expect(onAdmitted).not.toHaveBeenCalled();
    await act(async () => clients[0]!.streamReady.resolve());
    await vi.waitFor(() => {
      expect(session!.store.getSnapshot().blocks).toMatchObject([
        { kind: 'user', text: 'Host-owned prompt' },
        { kind: 'assistant', text: 'Host reply', streaming: true },
      ]);
    });
    await act(async () => completion.resolve());
    await expect(turn.promise).resolves.toBeUndefined();
    expect(session!.promptStatus).toBe('idle');
    expect(session!.store.getSnapshot().blocks.at(-1)).toMatchObject({
      kind: 'assistant',
      streaming: false,
    });
    expect(onSettled).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'sa-42',
      promptId: 'p-1',
      outcome: 'completed',
      stopReason: 'end_turn',
    });

    await act(async () => root!.unmount());
    root = undefined;
    await act(async () => new Promise((r) => setTimeout(r, 10)));

    expect(clients[0]!.detachMock).toHaveBeenCalledTimes(1);
    expect(
      fetchSpy.mock.calls.filter(([input]) =>
        String(input).includes('/detach'),
      ),
    ).toHaveLength(0);
  });
});
