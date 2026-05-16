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

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
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
      const captured: CapturedRequest = { url, method, headers, body };
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
    expect(calls[0]?.url).toBe('http://daemon/session');
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      cwd: '/work/a',
      modelServiceId: 'qwen-prod',
    });
  });

  it('forwards session-scoped operations through DaemonClient', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/prompt')) {
        return jsonResponse(200, { stopReason: 'end_turn' });
      }
      if (req.url.endsWith('/session/s-1/model')) {
        return jsonResponse(200, { modelId: 'qwen3-coder' });
      }
      if (req.url.endsWith('/session/s-1/cancel')) {
        return new Response(null, { status: 204 });
      }
      if (req.url.endsWith('/permission/req-1')) {
        return jsonResponse(200, {});
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
    ).resolves.toEqual({ stopReason: 'end_turn' });
    await expect(session.setModel('qwen3-coder')).resolves.toEqual({
      modelId: 'qwen3-coder',
    });
    await expect(session.cancel()).resolves.toBeUndefined();
    await expect(
      session.respondToPermission('req-1', {
        outcome: { outcome: 'selected', optionId: 'allow' },
      }),
    ).resolves.toBe(true);

    expect(calls.map((c) => c.url)).toEqual([
      'http://daemon/session/s-1/prompt',
      'http://daemon/session/s-1/model',
      'http://daemon/session/s-1/cancel',
      'http://daemon/permission/req-1',
    ]);
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

    const events = [];
    for await (const event of session.events()) events.push(event);
    expect(events.map((event) => event.id)).toEqual([4, 5]);
    expect(session.lastEventId).toBe(5);

    for await (const _event of session.events()) {
      /* empty */
    }

    expect(calls[0]?.headers['last-event-id']).toBeUndefined();
    expect(calls[1]?.headers['last-event-id']).toBe('5');
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
});
