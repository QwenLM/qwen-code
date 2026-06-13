/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { MatrixRestApi } from './restApi.js';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(
  responder: (c: Captured) => { status: number; json?: unknown },
) {
  const calls: Captured[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const c: Captured = {
      url,
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    const { status, json } = responder(c);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function api(impl: typeof fetch, txn = 'TXN1') {
  return new MatrixRestApi({
    homeserverUrl: 'https://home.example.com/',
    accessToken: 'secret-token',
    fetchImpl: impl,
    txnId: () => txn,
  });
}

describe('MatrixRestApi — whoami', () => {
  it('GETs the whoami endpoint with bearer auth and returns the user_id', async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      json: { user_id: '@qwenbot:home.example.com' },
    }));
    const r = await api(impl).whoami();
    expect(r.userId).toBe('@qwenbot:home.example.com');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe(
      'https://home.example.com/_matrix/client/v3/account/whoami',
    );
    expect(calls[0].headers['Authorization']).toBe('Bearer secret-token');
  });
});

describe('MatrixRestApi — sync', () => {
  it('GETs /sync with the since + timeout query and returns the body', async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      json: { next_batch: 's2' },
    }));
    const r = await api(impl).sync('s1', 30000);
    expect((r.body as { next_batch: string }).next_batch).toBe('s2');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe(
      'https://home.example.com/_matrix/client/v3/sync?timeout=30000&since=s1',
    );
  });

  it('omits since on the initial sync', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, json: {} }));
    await api(impl).sync(undefined, 0);
    expect(calls[0].url).toBe(
      'https://home.example.com/_matrix/client/v3/sync?timeout=0',
    );
  });
});

describe('MatrixRestApi — joinRoom', () => {
  it('POSTs the URL-encoded join path', async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      json: { room_id: '!abc:home.example.com' },
    }));
    const r = await api(impl).joinRoom('!abc:home.example.com');
    expect(r.ok).toBe(true);
    expect(calls[0].method).toBe('POST');
    // `:` is percent-encoded; `!` is left as-is by encodeURIComponent.
    expect(calls[0].url).toBe(
      'https://home.example.com/_matrix/client/v3/rooms/!abc%3Ahome.example.com/join',
    );
  });
});

describe('MatrixRestApi — sendMessage', () => {
  it('PUTs to the txn-scoped send path and returns the event id', async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      json: { event_id: '$evt_42' },
    }));
    const r = await api(impl).sendMessage('!abc:home.example.com', {
      msgtype: 'm.text',
      body: 'hi',
    });
    expect(r.eventId).toBe('$evt_42');
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe(
      'https://home.example.com/_matrix/client/v3/rooms/!abc%3Ahome.example.com/send/m.room.message/TXN1',
    );
    expect((calls[0].body as { body: string }).body).toBe('hi');
  });

  it('surfaces 429 retry_after_ms (milliseconds)', async () => {
    const { impl } = fakeFetch(() => ({
      status: 429,
      json: { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 2500 },
    }));
    const r = await api(impl).sendMessage('!r:h', {
      msgtype: 'm.text',
      body: 'x',
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    expect(r.retryAfterMs).toBe(2500);
  });

  it('returns status 0 on a network error', async () => {
    const impl = (async () => {
      throw new Error('econn');
    }) as unknown as typeof fetch;
    const r = await api(impl).sendMessage('!r:h', {
      msgtype: 'm.text',
      body: 'x',
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
  });

  it('uses a fresh transaction id per call', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, json: {} }));
    let n = 0;
    const client = new MatrixRestApi({
      homeserverUrl: 'https://h',
      accessToken: 't',
      fetchImpl: impl,
      txnId: () => `txn-${n++}`,
    });
    await client.sendMessage('!r:h', { msgtype: 'm.text', body: 'a' });
    await client.sendMessage('!r:h', { msgtype: 'm.text', body: 'b' });
    expect(calls[0].url).toContain('/txn-0');
    expect(calls[1].url).toContain('/txn-1');
  });
});
