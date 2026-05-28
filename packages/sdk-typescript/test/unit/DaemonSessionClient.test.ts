/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import { DaemonSessionClient } from '../../src/daemon/DaemonSessionClient.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(frames: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function pendingSseResponse(onCancel: () => void): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': keepalive\n\n'));
    },
    cancel() {
      onCancel();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  signal?: AbortSignal | null;
}

function recordingFetch(
  reply: (req: CapturedRequest) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? 'GET';
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = new Headers(init.headers);
        h.forEach((v, k) => (headers[k.toLowerCase()] = v));
      }
      const body = typeof init?.body === 'string' ? init.body : null;
      const captured: CapturedRequest = {
        url,
        method,
        headers,
        body,
        signal: init?.signal,
      };
      calls.push(captured);
      return reply(captured);
    },
  ) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

describe('DaemonSessionClient', () => {
  it('creates or attaches a daemon session and exposes session metadata', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(200, {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: false,
        clientId: 'client-1',
      }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.createOrAttach(client, {
      workspaceCwd: '/work/a',
      modelServiceId: 'qwen-prod',
    });

    expect(session.sessionId).toBe('s-1');
    expect(session.workspaceCwd).toBe('/work/a');
    expect(session.attached).toBe(false);
    expect(session.clientId).toBe('client-1');
    expect(calls[0]?.url).toBe('http://daemon/session');
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      cwd: '/work/a',
      modelServiceId: 'qwen-prod',
    });
  });

  it('forwards a persisted client id through create, load, and resume', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-reuse',
        });
      }
      if (
        req.url.endsWith('/session/s-1/load') ||
        req.url.endsWith('/session/s-1/resume')
      ) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-reuse',
          state: {},
        });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await DaemonSessionClient.createOrAttach(
      client,
      { workspaceCwd: '/work/a' },
      'client-reuse',
    );
    await DaemonSessionClient.load(
      client,
      's-1',
      { workspaceCwd: '/work/a' },
      'client-reuse',
    );
    await DaemonSessionClient.resume(client, 's-1', {}, 'client-reuse');

    expect(calls.map((c) => c.headers['x-qwen-client-id'])).toEqual([
      'client-reuse',
      'client-reuse',
      'client-reuse',
    ]);
  });

  it('replays attach-time model switch events on first subscription', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
        });
      }
      if (req.url.endsWith('/session/s-1/events')) {
        return sseResponse('');
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.createOrAttach(client, {
      workspaceCwd: '/work/a',
      modelServiceId: 'qwen-prod',
    });

    for await (const _event of session.events()) {
      /* empty */
    }

    expect(calls[1]?.url).toBe('http://daemon/session/s-1/events');
    expect(calls[1]?.headers['last-event-id']).toBe('0');
  });

  it('loads an existing daemon session and seeds replay from the start', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/load')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: false,
          clientId: 'client-1',
          state: { configOptions: [] },
        });
      }
      if (req.url.endsWith('/session/s-1/events')) {
        return sseResponse('');
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.load(client, 's-1', {
      workspaceCwd: '/work/a',
    });

    expect(session.sessionId).toBe('s-1');
    expect(session.clientId).toBe('client-1');
    expect(session.state).toEqual({ configOptions: [] });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ cwd: '/work/a' });

    for await (const _event of session.events()) {
      /* empty */
    }
    expect(calls[1]?.headers['last-event-id']).toBe('0');
  });

  it('resumes an existing daemon session and seeds replay from the start', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/resume')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-1',
          state: { modes: null },
        });
      }
      if (req.url.endsWith('/session/s-1/events')) {
        return sseResponse('');
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.resume(client, 's-1');

    expect(session.attached).toBe(true);
    expect(session.clientId).toBe('client-1');
    expect(session.state).toEqual({ modes: null });
    for await (const _event of session.events()) {
      /* empty */
    }
    // Symmetric to load(): `unstable_resumeSession` schedules an
    // `available_commands_update` via setTimeout(0) on the agent side,
    // so the SDK seeds the subscription from the start of the ring.
    expect(calls[1]?.headers['last-event-id']).toBe('0');
  });

  it('replays from id 0 on freshly-created sessions so startup-window guardrail events are observable (codex review fix #1)', async () => {
    // Codex review round 2, finding #1: PR 14b's
    // `mcp_budget_warning` / `mcp_child_refused_batch` events fire
    // during the child's `newSession` handler and are buffered on
    // `BridgeClient.earlyEvents` until `byId.set(sessionId, entry)`
    // runs. The bridge drains them onto the per-session bus before
    // `spawnOrAttach` returns, so they live in the replay ring with
    // ids — but the SDK's old default of `lastEventId: undefined`
    // started subscriptions live, so consumers never observed them.
    //
    // Fix: when `session.attached === false` (newly-created), seed
    // `Last-Event-ID: 0` to replay the startup-window events. The
    // existing `modelServiceId` carve-out still triggers seed for
    // re-attached sessions where attach-time switch events need to
    // replay.
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: false,
        });
      }
      if (req.url.endsWith('/session/s-1/events')) {
        return sseResponse('');
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.createOrAttach(client, {
      workspaceCwd: '/work/a',
      // No `modelServiceId` — the only signal that triggered seed
      // pre-fix. With the fix, `attached: false` alone is enough.
    });

    for await (const _event of session.events()) {
      /* empty */
    }

    expect(session.attached).toBe(false);
    expect(calls[1]?.url).toBe('http://daemon/session/s-1/events');
    expect(calls[1]?.headers['last-event-id']).toBe('0');
  });

  it('starts live when createOrAttach has no model service replay need', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
        });
      }
      if (req.url.endsWith('/session/s-1/events')) {
        return sseResponse('');
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.createOrAttach(client, {
      workspaceCwd: '/work/a',
    });

    for await (const _event of session.events()) {
      /* empty */
    }

    expect(session.lastEventId).toBeUndefined();
    expect(calls[1]?.url).toBe('http://daemon/session/s-1/events');
    expect(calls[1]?.headers['last-event-id']).toBeUndefined();
  });

  it('forwards heartbeat through DaemonClient with the bound clientId', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(200, {
        sessionId: 's-1',
        clientId: 'client-1',
        lastSeenAt: 1_700_000_000_002,
      }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });
    const result = await session.heartbeat();
    expect(result).toEqual({
      sessionId: 's-1',
      clientId: 'client-1',
      lastSeenAt: 1_700_000_000_002,
    });
    expect(calls[0]?.url).toBe('http://daemon/session/s-1/heartbeat');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
  });

  it('forwards recap through DaemonClient with the bound clientId and signal', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(200, {
        sessionId: 's-1',
        recap: 'Refactoring the auth flow. Next: run the integration tests.',
      }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });
    const ctrl = new AbortController();
    const result = await session.recap({ signal: ctrl.signal });
    expect(result).toEqual({
      sessionId: 's-1',
      recap: 'Refactoring the auth flow. Next: run the integration tests.',
    });
    expect(calls[0]?.url).toBe('http://daemon/session/s-1/recap');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
    expect(calls[0]?.signal).toBe(ctrl.signal);
  });

  it('forwards session-scoped operations through DaemonClient', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/prompt')) {
        return jsonResponse(200, { stopReason: 'end_turn' });
      }
      if (req.url.endsWith('/session/s-1/model')) {
        return jsonResponse(200, { modelId: 'qwen3-coder' });
      }
      if (req.url.endsWith('/session/s-1/context')) {
        return jsonResponse(200, {
          v: 1,
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          state: { models: { currentModelId: 'qwen3-coder' } },
        });
      }
      if (req.url.endsWith('/session/s-1/supported-commands')) {
        return jsonResponse(200, {
          v: 1,
          sessionId: 's-1',
          availableCommands: [
            {
              name: 'init',
              description: 'Initialize',
              input: null,
            },
          ],
          availableSkills: ['review'],
        });
      }
      if (req.url.endsWith('/session/s-1/tasks')) {
        return jsonResponse(200, {
          v: 1,
          sessionId: 's-1',
          now: 1_700_000_000_000,
          tasks: [],
        });
      }
      if (req.url.endsWith('/session/s-1/cancel')) {
        return new Response(null, { status: 204 });
      }
      if (req.url.endsWith('/permission/req-1')) {
        return jsonResponse(200, {});
      }
      if (req.url.endsWith('/session/s-1/permission/req-2')) {
        return jsonResponse(200, {});
      }
      if (req.method === 'DELETE' && req.url.endsWith('/session/s-1')) {
        return new Response(null, { status: 204 });
      }
      if (req.url.endsWith('/session/s-1/metadata')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          displayName: 'My Session',
        });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });

    const controller = new AbortController();
    await expect(
      session.prompt(
        { prompt: [{ type: 'text', text: 'hi' }] },
        controller.signal,
      ),
    ).resolves.toEqual({ stopReason: 'end_turn' });
    await expect(session.setModel('qwen3-coder')).resolves.toEqual({
      modelId: 'qwen3-coder',
    });
    await expect(session.context()).resolves.toEqual({
      v: 1,
      sessionId: 's-1',
      workspaceCwd: '/work/a',
      state: { models: { currentModelId: 'qwen3-coder' } },
    });
    await expect(session.supportedCommands()).resolves.toEqual({
      v: 1,
      sessionId: 's-1',
      availableCommands: [
        {
          name: 'init',
          description: 'Initialize',
          input: null,
        },
      ],
      availableSkills: ['review'],
    });
    await expect(session.tasks()).resolves.toEqual({
      v: 1,
      sessionId: 's-1',
      now: 1_700_000_000_000,
      tasks: [],
    });
    await expect(session.cancel()).resolves.toBeUndefined();
    await expect(
      session.respondToPermission('req-1', {
        outcome: { outcome: 'selected', optionId: 'allow' },
      }),
    ).resolves.toBe(true);
    await expect(
      session.respondToSessionPermission('req-2', {
        outcome: { outcome: 'cancelled' },
      }),
    ).resolves.toBe(true);
    await expect(
      session.updateMetadata({ displayName: 'My Session' }),
    ).resolves.toEqual({ displayName: 'My Session' });
    await expect(session.close()).resolves.toBeUndefined();

    expect(calls.map((c) => c.url)).toEqual([
      'http://daemon/session/s-1/prompt',
      'http://daemon/session/s-1/model',
      'http://daemon/session/s-1/context',
      'http://daemon/session/s-1/supported-commands',
      'http://daemon/session/s-1/tasks',
      'http://daemon/session/s-1/cancel',
      'http://daemon/permission/req-1',
      'http://daemon/session/s-1/permission/req-2',
      'http://daemon/session/s-1/metadata',
      'http://daemon/session/s-1',
    ]);
    expect(calls[0]?.signal).toBe(controller.signal);
    expect(calls.map((c) => c.headers['x-qwen-client-id'])).toEqual([
      'client-1',
      'client-1',
      'client-1',
      'client-1',
      'client-1',
      'client-1',
      'client-1',
      'client-1',
      'client-1',
      'client-1',
    ]);
  });

  it('surfaces permission races and session operation failures', async () => {
    const { fetch } = recordingFetch((req) => {
      if (req.url.endsWith('/permission/missing-req')) {
        return jsonResponse(404, { error: 'unknown request' });
      }
      if (req.url.endsWith('/session/s-1/model')) {
        return jsonResponse(404, { error: 'unknown session' });
      }
      if (req.url.endsWith('/session/s-1/cancel')) {
        return jsonResponse(500, { error: 'cancel failed' });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });

    await expect(
      session.respondToPermission('missing-req', {
        outcome: { outcome: 'cancelled' },
      }),
    ).resolves.toBe(false);
    await expect(session.setModel('qwen3-coder')).rejects.toMatchObject({
      status: 404,
    });
    await expect(session.cancel()).rejects.toMatchObject({ status: 500 });
  });

  it('tracks Last-Event-ID across event subscriptions', async () => {
    let eventCallCount = 0;
    const { fetch, calls } = recordingFetch((req) => {
      if (!req.url.endsWith('/session/s-1/events')) {
        return jsonResponse(500, { error: `unexpected ${req.url}` });
      }
      eventCallCount++;
      if (eventCallCount === 1) {
        return sseResponse(
          'id: 4\nevent: session_update\ndata: {"id":4,"v":1,"type":"session_update","data":"a"}\n\n' +
            'id: 5\nevent: session_update\ndata: {"id":5,"v":1,"type":"session_update","data":"b"}\n\n',
        );
      }
      return sseResponse('');
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });

    const stream = session.events();
    const first = await stream.next();
    expect(first.value?.id).toBe(4);
    expect(session.lastEventId).toBeUndefined();

    const second = await stream.next();
    expect(second.value?.id).toBe(5);
    expect(session.lastEventId).toBe(4);

    await expect(stream.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(session.lastEventId).toBe(5);

    for await (const _event of session.events()) {
      /* empty */
    }

    expect(calls[0]?.headers['last-event-id']).toBeUndefined();
    expect(calls[1]?.headers['last-event-id']).toBe('5');
  });

  it('does not overwrite replay state for events without SSE ids', async () => {
    const { fetch } = recordingFetch(() =>
      sseResponse(
        'id: 4\nevent: session_update\ndata: {"id":4,"v":1,"type":"session_update","data":"a"}\n\n' +
          'event: session_update\ndata: {"v":1,"type":"session_update","data":"synthetic"}\n\n',
      ),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });

    for await (const _event of session.events()) {
      /* empty */
    }

    expect(session.lastEventId).toBe(4);
  });

  it('does not acquire the subscription guard until iteration starts', async () => {
    const { fetch, calls } = recordingFetch(() => sseResponse(''));
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });

    const abandoned = session.events();
    await expect(session.events().next()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    expect(calls).toHaveLength(1);
    await abandoned.return(undefined);
  });

  it('rejects concurrent subscriptions on one session client', async () => {
    const { fetch } = recordingFetch(() =>
      sseResponse(
        'id: 4\nevent: session_update\ndata: {"id":4,"v":1,"type":"session_update","data":"a"}\n\n',
      ),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });

    const first = session.events();
    await expect(first.next()).resolves.toMatchObject({
      done: false,
      value: { id: 4 },
    });

    const second = session.events();
    await expect(second.next()).rejects.toThrow(
      'Another event subscription is already active',
    );

    await first.return(undefined);

    for await (const _event of session.events()) {
      /* guard recovered */
    }
  });

  it('allows callers to seed, override, and disable replay state', async () => {
    const { fetch, calls } = recordingFetch(() => sseResponse(''));
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
      lastEventId: 7,
    });

    for await (const _event of session.events()) {
      /* empty */
    }
    for await (const _event of session.events({ lastEventId: 11 })) {
      /* empty */
    }
    for await (const _event of session.events({ resume: false })) {
      /* empty */
    }

    expect(calls[0]?.headers['last-event-id']).toBe('7');
    expect(calls[1]?.headers['last-event-id']).toBe('11');
    expect(calls[2]?.headers['last-event-id']).toBeUndefined();
  });

  it('allows callers to set and clear replay state explicitly', async () => {
    const { fetch, calls } = recordingFetch(() => sseResponse(''));
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });

    session.setLastEventId(12);
    expect(session.lastEventId).toBe(12);
    for await (const _event of session.events()) {
      /* empty */
    }

    session.setLastEventId(undefined);
    expect(session.lastEventId).toBeUndefined();
    for await (const _event of session.events()) {
      /* empty */
    }

    expect(calls[0]?.headers['last-event-id']).toBe('12');
    expect(calls[1]?.headers['last-event-id']).toBeUndefined();
    expect(() => session.setLastEventId(-1)).toThrow(TypeError);
    expect(() => session.setLastEventId(1.5)).toThrow(TypeError);
    expect(() => session.setLastEventId(Number.NaN)).toThrow(TypeError);
    expect(
      () =>
        new DaemonSessionClient({
          client,
          session: {
            sessionId: 's-1',
            workspaceCwd: '/work/a',
            attached: true,
          },
          lastEventId: Number.POSITIVE_INFINITY,
        }),
    ).toThrow(TypeError);
    expect(() => session.events({ lastEventId: -1 })).toThrow(TypeError);
  });

  it('honors abort signals and releases the subscription guard', async () => {
    let cancelled = false;
    const { fetch, calls } = recordingFetch(() =>
      pendingSseResponse(() => {
        cancelled = true;
      }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });
    const controller = new AbortController();

    const events = session.events({ signal: controller.signal });
    const next = events.next();
    await Promise.resolve();
    expect(calls).toHaveLength(1);

    controller.abort();

    await expect(next).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(cancelled).toBe(true);

    const retry = session.events();
    await retry.return(undefined);
  });

  it('releases the subscription guard when consumers throw into the iterator', async () => {
    const { fetch } = recordingFetch(() =>
      sseResponse(
        'id: 4\nevent: session_update\ndata: {"id":4,"v":1,"type":"session_update","data":"a"}\n\n',
      ),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });

    const events = session.events();
    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: { id: 4 },
    });

    await expect(events.throw(new Error('boom'))).rejects.toThrow('boom');

    for await (const _event of session.events()) {
      /* guard recovered */
    }
  });

  it('propagates prompt and subscription errors', async () => {
    const { fetch } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/prompt')) {
        return jsonResponse(500, { error: 'boom' });
      }
      if (req.url.endsWith('/session/s-1/events')) {
        return jsonResponse(500, { error: 'stream failed' });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });

    await expect(
      session.prompt({ prompt: [{ type: 'text', text: 'hi' }] }),
    ).rejects.toThrow('POST /session/:id/prompt: boom');

    const events = session.events();
    await expect(events.next()).rejects.toThrow(
      'GET /session/:id/events: stream failed',
    );

    const retry = session.events({ resume: false });
    await expect(retry.next()).rejects.toThrow(
      'GET /session/:id/events: stream failed',
    );
  });
});
