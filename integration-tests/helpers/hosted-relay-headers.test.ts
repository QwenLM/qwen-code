/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { relayedHeaders } from './hosted-relay-headers.js';

const servers: Server[] = [];
async function listen(server: Server) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});

describe('Hosted proxy header relay', () => {
  it('keeps only the end-to-end headers that describe the buffered body', () => {
    expect(
      relayedHeaders(
        new Headers({
          'cache-control': 'no-store',
          connection: 'X-Upstream-Hop',
          'content-encoding': 'identity',
          'content-length': '11',
          'content-type': 'application/json',
          'keep-alive': 'timeout=60',
          'proxy-authenticate': 'Basic',
          'proxy-connection': 'keep-alive',
          te: 'trailers',
          trailer: 'x-qwen-trailer',
          'transfer-encoding': 'chunked',
          upgrade: 'h2c',
          'x-qwen-resource-digest': 'sha256',
          'x-qwen-resource-kind': 'workspace',
          'x-qwen-resource-schema-version': '1',
          'x-upstream-hop': '1',
        }),
      ),
    ).toEqual({
      'cache-control': 'no-store',
      'content-type': 'application/json',
      'x-qwen-resource-digest': 'sha256',
      'x-qwen-resource-kind': 'workspace',
      'x-qwen-resource-schema-version': '1',
    });
  });

  it("advertises the proxy's own keep-alive window, not the upstream's", async () => {
    const upstream = await listen(
      createServer((_req, res) => {
        res.writeHead(200, {
          'Cache-Control': 'no-store',
          'Keep-Alive': 'timeout=60',
        });
        res.end('{}');
      }),
    );
    const proxy = createServer(async (_req, res) => {
      const response = await fetch(upstream);
      const body = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, relayedHeaders(response.headers));
      res.end(body);
    });
    const response = await fetch(await listen(proxy));
    expect(await response.text()).toBe('{}');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('keep-alive')).toBe(
      `timeout=${proxy.keepAliveTimeout / 1000}`,
    );
  });
});
