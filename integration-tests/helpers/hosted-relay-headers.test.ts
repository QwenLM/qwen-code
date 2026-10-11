/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { once } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { relayedHeaders, relayUpstream } from './hosted-relay-headers.js';

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
          // Two mixed-case tokens after ", " pin the dynamic branch's
          // split/trim/lowercase; keep them out of the expectation, and keep
          // 'keep-alive' out of this list — the dynamic branch would mask
          // the static NOT_RELAYED entry this case witnesses.
          connection: 'X-Upstream-Hop, X-Second-Hop',
          'content-encoding': 'identity',
          'content-length': '11',
          'content-type': 'application/json',
          'keep-alive': 'timeout=60',
          'proxy-authenticate': 'Basic',
          'proxy-authorization': 'Basic upstream-proxy-credential',
          'proxy-connection': 'keep-alive',
          te: 'trailers',
          trailer: 'x-qwen-trailer',
          'transfer-encoding': 'chunked',
          upgrade: 'h2c',
          'x-qwen-resource-digest': 'sha256',
          'x-qwen-resource-kind': 'workspace',
          'x-qwen-resource-schema-version': '1',
          'x-second-hop': '2',
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
    // A raw TCP origin: Node's own server would append
    // `Connection: keep-alive` to the reply, and the filter's dynamic branch
    // would then drop the advertised Keep-Alive even with the static
    // 'keep-alive' entry deleted, leaving this case green on that mutant.
    const sockets = new Set<Socket>();
    const raw = net.createServer((socket) => {
      sockets.add(socket);
      socket.once('data', () => {
        // Hold the socket open: with a short-lived origin the mutant dies on
        // a socket-reuse race instead of on the assertion. The 503 pins
        // relayUpstream's status pass-through.
        socket.write(
          'HTTP/1.1 503 Service Unavailable\r\n' +
            'Cache-Control: no-store\r\n' +
            'Keep-Alive: timeout=60\r\n' +
            'Content-Length: 2\r\n' +
            '\r\n' +
            '{}',
        );
      });
    });
    raw.listen(0, '127.0.0.1');
    await once(raw, 'listening');
    try {
      const upstream = `http://127.0.0.1:${
        (raw.address() as AddressInfo).port
      }`;
      const proxy = createServer(async (_req, res) => {
        const response = await fetch(upstream);
        relayUpstream(res, response, Buffer.from(await response.arrayBuffer()));
      });
      const response = await fetch(await listen(proxy));
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('{}');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('keep-alive')).toBe(
        `timeout=${proxy.keepAliveTimeout / 1000}`,
      );
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      const closed = once(raw, 'close');
      raw.close();
      await closed;
    }
  });

  it('keeps the five store relays calling the shared helper', () => {
    // The sdk-java workflow step runs this file after `cd integration-tests`
    // while the repo-root lanes use `--root ./integration-tests`, so resolve
    // the drivers relative to this file, never process.cwd(). Read source
    // text because importing a driver throws — each parses process.argv[2]
    // at module load. Positive pin only: a new driver hand-rolling its relay
    // is absent from the enumerated list and still passes.
    const dir = dirname(fileURLToPath(import.meta.url));
    const callers = readdirSync(dir)
      .filter((name) => /^hosted-.*-driver\.ts$/.test(name))
      .filter((name) =>
        /\brelayUpstream\s*\(/.test(readFileSync(join(dir, name), 'utf8')),
      )
      .sort();
    expect(callers).toEqual([
      'hosted-latency-driver.ts',
      'hosted-process-crash-driver.ts',
      'hosted-shell-output-driver.ts',
      'hosted-store-failure-driver.ts',
      'hosted-workspace-tool-turn-driver.ts',
    ]);
  });
});
