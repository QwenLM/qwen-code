/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import { createSessionAgentsHttpApi } from './session-agents-api';
import {
  DaemonAvailability,
  createDaemonClient,
  registerDaemonAvailability,
} from '../../daemon/availability.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function eventResponse(signal?: AbortSignal | null) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal?.addEventListener('abort', () => controller.error(signal.reason), {
        once: true,
      });
    },
  });
  return {
    controller,
    response: new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    }),
  };
}

it('uses its client owner when waiting for a shared session-agent stream', async () => {
  vi.useFakeTimers();
  const baseUrl = 'https://stream-owner.example';
  const native = vi.fn<typeof fetch>(
    async (_input, init) => eventResponse(init?.signal).response,
  );
  const a = new DaemonAvailability(baseUrl, undefined, native);
  const b = new DaemonAvailability(
    baseUrl,
    undefined,
    async () => new Response(null, { status: 401 }),
  );
  const client = createDaemonClient({ baseUrl, fetch: native }, a);
  const unregisterA = registerDaemonAvailability(baseUrl, undefined, a);
  const unregisterB = registerDaemonAvailability(baseUrl, undefined, b);
  let stop = () => {};
  try {
    await b.check();
    stop = createSessionAgentsHttpApi(
      baseUrl,
      undefined,
      '/repo',
      client,
    ).subscribe('session', vi.fn(), vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(native).toHaveBeenCalledOnce();
  } finally {
    stop();
    unregisterA();
    unregisterB();
    a.dispose();
    b.dispose();
    client.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();
  }
});

it('posts a retry to the run route of the session workspace', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 202,
    json: () => Promise.resolve({ runId: 'run 1' }),
  });
  vi.stubGlobal('fetch', fetchMock);
  const api = createSessionAgentsHttpApi(
    'http://daemon/',
    'secret',
    '/repo/a b',
  );

  await expect(api.retryRun('s/1', 'run 1')).resolves.toEqual({
    runId: 'run 1',
  });

  expect(fetchMock).toHaveBeenCalledWith(
    'http://daemon/workspaces/%2Frepo%2Fa%20b/agent/sessions/s%2F1/runs/run%201/retry',
    expect.objectContaining({
      method: 'POST',
      body: '{}',
    }),
  );
  expect(new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers)).toEqual(
    new Headers({
      'content-type': 'application/json',
      Authorization: 'Bearer secret',
    }),
  );
});

it('surfaces a refused retry as an error with the server message', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ message: 'This run cannot be retried.' }),
    }),
  );
  const api = createSessionAgentsHttpApi('http://daemon', undefined, '/repo');
  await expect(api.retryRun('s1', 'r1')).rejects.toThrow(
    'This run cannot be retried.',
  );
});

it('uses a supplied SDK native fetch instead of global fetch or ACP translation', async () => {
  const { DaemonClient } = await import('@qwen-code/sdk/daemon');
  const restFetch = vi.fn().mockResolvedValue(new Response('{"frames":[]}'));
  const acpFetch = vi.fn();
  const globalFetch = vi.fn();
  vi.stubGlobal('fetch', globalFetch);
  const client = new DaemonClient({
    baseUrl: 'https://daemon/prefix/',
    token: 'secret',
    transport: {
      restFetch,
      fetch: acpFetch,
    } as unknown as import('@qwen-code/sdk/daemon').DaemonTransport,
  });
  const api = createSessionAgentsHttpApi(
    'https://daemon/prefix/',
    'secret',
    '/repo a',
    client,
  );
  await expect(api.listRuns('session/b')).resolves.toEqual({ frames: [] });
  expect(restFetch.mock.calls[0][0]).toBe(
    'https://daemon/prefix/workspaces/%2Frepo%20a/agent/sessions/session%2Fb/runs',
  );
  expect(acpFetch).not.toHaveBeenCalled();
  expect(globalFetch).not.toHaveBeenCalled();
});

it('shares the SDK event request, reads frames after 30 seconds and aborts on the last unsubscribe', async () => {
  vi.useFakeTimers();
  try {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      const { response, controller } = eventResponse(signal);
      streamController = controller;
      return Promise.resolve(response);
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = createSessionAgentsHttpApi('https://daemon', 'secret', '/repo');
    const onEvent = vi.fn();
    const onSecondEvent = vi.fn();
    const stop = api.subscribe('s1', onEvent, vi.fn());
    const stopSecond = api.subscribe('s1', onSecondEvent, vi.fn());
    await vi.advanceTimersByTimeAsync(35_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    expect(
      new Headers(fetchMock.mock.calls[0][1]?.headers).get('authorization'),
    ).toBe('Bearer secret');
    streamController.enqueue(
      new TextEncoder().encode('data: {"type":"changed"}\n\n'),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(onEvent).toHaveBeenCalledWith({ type: 'changed' });
    expect(onSecondEvent).toHaveBeenCalledWith({ type: 'changed' });
    stop();
    expect(signal?.aborted).toBe(false);
    stopSecond();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('reconnects through the surviving subscriber after the first SDK owner is disposed', async () => {
  vi.useFakeTimers();
  const baseUrl = 'https://shared-stream.example';
  const token = 'fixture';
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const nativeFetch: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/health') return Response.json({ status: 'ok' });
    if (path === '/capabilities') return Response.json({ features: [] });
    if (path.endsWith('/runs')) return Response.json({ frames: [] });
    if (!path.endsWith('/session-events')) {
      throw new Error(`Unexpected path: ${path}`);
    }
    const { response, controller } = eventResponse(init?.signal);
    streams.push(controller);
    return response;
  };
  const a = new DaemonAvailability(baseUrl, token, nativeFetch);
  const b = new DaemonAvailability(baseUrl, token, nativeFetch);
  const unregisterA = registerDaemonAvailability(baseUrl, token, a);
  const unregisterB = registerDaemonAvailability(baseUrl, token, b);
  const clientA = createDaemonClient({ baseUrl, token, fetch: nativeFetch }, a);
  const clientB = createDaemonClient({ baseUrl, token, fetch: nativeFetch }, b);
  const requestA = vi.spyOn(clientA, 'requestRest');
  const requestB = vi.spyOn(clientB, 'requestRest');
  const apiA = createSessionAgentsHttpApi(baseUrl, token, '/repo', clientA);
  const apiB = createSessionAgentsHttpApi(baseUrl, token, '/repo', clientB);
  const onEventA = vi.fn();
  const onEventB = vi.fn();
  const stopA = apiA.subscribe('session', onEventA, vi.fn());
  const stopB = apiB.subscribe('session', onEventB, vi.fn());
  try {
    await vi.advanceTimersByTimeAsync(0);
    streams[0].enqueue(
      new TextEncoder().encode('data: {"type":"changed"}\n\n'),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(streams).toHaveLength(1);
    expect(onEventA).toHaveBeenCalledTimes(1);
    expect(onEventB).toHaveBeenCalledTimes(1);

    stopA();
    unregisterA();
    a.dispose();
    clientA.dispose();
    streams[0].close();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(requestA).toHaveBeenCalledTimes(1);
    expect(requestB).toHaveBeenCalledWith(
      '/workspaces/%2Frepo/agent/session-events?sessionId=session',
      expect.anything(),
      0,
    );
    expect(streams).toHaveLength(2);
    streams[1].enqueue(
      new TextEncoder().encode('data: {"type":"changed","recovered":true}\n\n'),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(onEventB).toHaveBeenLastCalledWith({
      type: 'changed',
      recovered: true,
    });
    expect(onEventA).toHaveBeenCalledTimes(1);
    await expect(apiB.listRuns('session')).resolves.toEqual({ frames: [] });
  } finally {
    stopA();
    stopB();
    unregisterA();
    unregisterB();
    a.dispose();
    b.dispose();
    clientA.dispose();
    clientB.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();
  }
});
