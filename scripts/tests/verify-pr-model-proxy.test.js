/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createModelProxy,
  parseArgs,
} from '../../scripts/verify-pr-model-proxy.mjs';

const TOKEN = 'test-proxy-token';
const NONCE = 'test-nonce';
const REAL_KEY = 'real-upstream-key';

let cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
  cleanups = [];
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      cleanups.push(
        () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(done);
          }),
      );
      resolve(port);
    });
  });
}

/**
 * A local upstream stand-in: records the last request and answers with the
 * configured status/body. No outbound network is involved.
 */
async function startUpstream({ status = 200, chunks = ['data: ok\n\n'] } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const body = [];
    req.on('data', (chunk) => body.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: Buffer.concat(body).toString('utf8'),
      });
      res.writeHead(status, { 'content-type': 'text/event-stream' });
      for (const chunk of chunks) res.write(chunk);
      res.end();
    });
  });
  const port = await listen(server);
  return { port, requests };
}

async function startProxy(upstream, overrides = {}) {
  const server = createModelProxy({
    baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
    apiKey: REAL_KEY,
    token: TOKEN,
    nonce: NONCE,
    ...overrides,
  });
  const port = await listen(server);
  return `http://127.0.0.1:${port}`;
}

const chatRequest = (body = '{"model":"m"}') => ({
  method: 'POST',
  headers: {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
  },
  body,
});

describe('verify-pr-model-proxy', () => {
  it('health endpoint echoes the nonce without touching the upstream', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy(upstream);
    const res = await fetch(`${proxy}/__health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(NONCE);
    expect(upstream.requests).toHaveLength(0);
  });

  it('rejects a missing or wrong bearer token before the upstream', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy(upstream);
    for (const authorization of [undefined, 'Bearer wrong']) {
      const res = await fetch(`${proxy}/chat/completions`, {
        method: 'POST',
        headers: authorization ? { authorization } : {},
        body: '{}',
      });
      expect(res.status).toBe(401);
    }
    expect(upstream.requests).toHaveLength(0);
  });

  it('allows only POST /chat/completions', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy(upstream);
    const get = await fetch(`${proxy}/v1/models`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(403);
    const post = await fetch(`${proxy}/v1/models`, chatRequest());
    expect(post.status).toBe(403);
    expect(upstream.requests).toHaveLength(0);
  });

  it('relays chat completions with the real key and the base-path prefix', async () => {
    const upstream = await startUpstream({
      chunks: ['data: a\n\n', 'data: b\n\n'],
    });
    const proxy = await startProxy(upstream);
    const res = await fetch(
      `${proxy}/chat/completions?stream=true`,
      chatRequest('{"model":"m","stream":true}'),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('data: a\n\ndata: b\n\n');
    expect(upstream.requests).toHaveLength(1);
    const seen = upstream.requests[0];
    expect(seen.method).toBe('POST');
    // The proxy's base URL carries /v1; the client path does not repeat it.
    expect(seen.url).toBe('/v1/chat/completions?stream=true');
    expect(seen.authorization).toBe(`Bearer ${REAL_KEY}`);
    expect(seen.body).toBe('{"model":"m","stream":true}');
  });

  it('does not double-prefix a client path that already carries the base path', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy(upstream);
    const res = await fetch(`${proxy}/v1/chat/completions`, chatRequest());
    expect(res.status).toBe(200);
    expect(upstream.requests[0].url).toBe('/v1/chat/completions');
  });

  it('propagates an upstream error status and body', async () => {
    const upstream = await startUpstream({
      status: 429,
      chunks: ['slow down'],
    });
    const proxy = await startProxy(upstream);
    const res = await fetch(`${proxy}/chat/completions`, chatRequest());
    expect(res.status).toBe(429);
    expect(await res.text()).toBe('slow down');
  });

  it('answers 504 when the upstream stalls past the idle window', async () => {
    const server = http.createServer(() => {
      // Never respond: the watchdog must fire.
    });
    const port = await listen(server);
    const proxy = await startProxy({ port }, { idleTimeoutMs: 50 });
    const res = await fetch(`${proxy}/chat/completions`, chatRequest());
    expect(res.status).toBe(504);
  });

  it('refuses to start without the full configuration', () => {
    expect(() =>
      createModelProxy({
        baseUrl: 'http://x',
        apiKey: '',
        token: 't',
        nonce: 'n',
      }),
    ).toThrow('required');
  });
});

describe('parseArgs', () => {
  it('defaults to loopback with an ephemeral port', () => {
    expect(parseArgs([])).toEqual({ listen: '127.0.0.1', port: 0 });
  });

  it('parses --listen and --port', () => {
    expect(parseArgs(['--listen', '172.17.0.1', '--port', '8080'])).toEqual({
      listen: '172.17.0.1',
      port: 8080,
    });
  });

  it('rejects unknown arguments, missing values and bad ports', () => {
    expect(() => parseArgs(['--docker'])).toThrow('unknown argument');
    expect(() => parseArgs(['--listen'])).toThrow('requires a value');
    expect(() => parseArgs(['--port', 'abc'])).toThrow('--port');
    expect(() => parseArgs(['--port', '70000'])).toThrow('--port');
    expect(() => parseArgs(['--port', '-1'])).toThrow('--port');
  });
});
