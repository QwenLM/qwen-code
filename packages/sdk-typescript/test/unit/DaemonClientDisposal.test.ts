/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import { DaemonTransportClosedError } from '../../src/daemon/DaemonTransport.js';

const operations: Array<[string, (client: DaemonClient) => Promise<unknown>]> =
  [
    [
      'native REST',
      (client) => client.requestRest('/workspace/notify', { method: 'POST' }),
    ],
    [
      'blob upload',
      (client) =>
        client.uploadWorkspaceFile({
          path: 'blob.bin',
          data: new Blob(['blob']),
        }),
    ],
    [
      'mod-row request',
      (client) =>
        client.askSessionModRow('session-1', {
          component: 'AssistantMessage',
          props: {},
        }),
    ],
  ];

function expectNoPost(fetch: ReturnType<typeof vi.fn>): void {
  expect(
    fetch.mock.calls.filter(([, init]) => init?.method === 'POST'),
  ).toHaveLength(0);
}

afterEach(() => vi.unstubAllGlobals());

describe('DaemonClient disposal', () => {
  it('keeps ordinary transport rejection and repeated disposal intact', async () => {
    const fetch = vi.fn();
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    client.dispose();
    client.dispose();

    await expect(client.health()).rejects.toBeInstanceOf(
      DaemonTransportClosedError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(operations)(
    'rejects %s without sending after disposal',
    async (_name, operation) => {
      const fetch = vi.fn(async () => new Response('{}'));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      client.dispose();

      await expect(operation(client)).rejects.toBeInstanceOf(
        DaemonTransportClosedError,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('rejects a browser-progress upload without an XHR send', async () => {
    const send = vi.fn();
    class FakeXMLHttpRequest {
      status = 201;
      responseText = '{"path":"progress.bin"}';
      upload = {};
      onload: (() => void) | null = null;
      open(): void {}
      setRequestHeader(): void {}
      send(): void {
        send();
        this.onload?.();
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    const client = new DaemonClient({ baseUrl: 'http://daemon' });
    client.dispose();

    await expect(
      client.uploadWorkspaceFile({
        path: 'progress.bin',
        data: new Blob(['blob']),
        onProgress: () => {},
      }),
    ).rejects.toBeInstanceOf(DaemonTransportClosedError);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a new BTW stream without a POST after disposal', async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { requestId: string };
        return new Response(
          `data: ${JSON.stringify({ v: 1, requestId: body.requestId, type: 'done', answer: 'done' })}\n\n`,
        );
      },
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    client.dispose();
    const stream = client.streamSessionBtw('session-1', 'Question');

    await expect(stream.next()).rejects.toBeInstanceOf(
      DaemonTransportClosedError,
    );
    expectNoPost(fetch);
    await stream.return(undefined);
  });

  it('blocks BTW reconnects when disposal happens between attempts', async () => {
    let posts = 0;
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE')
          return new Response(null, { status: 204 });
        posts++;
        if (posts === 1) {
          return new Response('{"error":"temporary"}', { status: 503 });
        }
        const body = JSON.parse(String(init?.body)) as { requestId: string };
        return new Response(
          `data: ${JSON.stringify({ v: 1, requestId: body.requestId, type: 'done', answer: 'done' })}\n\n`,
        );
      },
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const stream = client.streamSessionBtw('session-1', 'Question');
    const next = stream.next();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    client.dispose();

    await expect(next).rejects.toBeInstanceOf(DaemonTransportClosedError);
    expect(
      fetch.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1);
    await stream.return(undefined);
  });
});
