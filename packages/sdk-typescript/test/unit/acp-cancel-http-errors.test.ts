/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AcpHttpTransport } from '../../src/daemon/AcpHttpTransport.js';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import { DaemonHttpError } from '../../src/daemon/DaemonHttpError.js';

function cancellationClient(response: Response) {
  const methods: string[] = [];
  const transport = new AcpHttpTransport(
    'https://daemon.example',
    undefined,
    async (url, init = {}) => {
      if (String(url).endsWith('/capabilities')) {
        return Response.json({ v: 1, features: [] });
      }
      const request = JSON.parse(String(init.body)) as {
        id?: number;
        method: string;
      };
      methods.push(request.method);
      if (request.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: request.id,
          result: {},
        });
      }
      return response;
    },
  );
  const client = new DaemonClient({
    baseUrl: 'https://daemon.example',
    transport,
  });
  return { client, methods, transport };
}

describe('ACP HTTP cancellation failures', () => {
  it.each([401, 429, 503])(
    'preserves HTTP %s and its response body',
    async (status) => {
      const { client, methods, transport } = cancellationClient(
        Response.json(
          { error: 'Cancellation was rejected' },
          { status, headers: { 'Retry-After': '7' } },
        ),
      );
      try {
        const error: unknown = await client.cancel('session-a').catch((e) => e);
        expect(error).toBeInstanceOf(DaemonHttpError);
        expect(error).toMatchObject({
          status,
          body: { error: 'Cancellation was rejected' },
          retryAfter: '7',
        });
        expect(methods).toEqual(['initialize', 'session/cancel']);
      } finally {
        transport.dispose();
      }
    },
  );

  it.each([202, 204])('accepts HTTP %s notifications', async (status) => {
    const { client, methods, transport } = cancellationClient(
      new Response(null, { status }),
    );
    try {
      await expect(client.cancel('session-a')).resolves.toBeUndefined();
      expect(methods).toEqual(['initialize', 'session/cancel']);
    } finally {
      transport.dispose();
    }
  });
});
