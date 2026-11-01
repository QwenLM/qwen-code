/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  createModelProxy,
  formatLocalBaseUrl,
  normalizeBasePath,
  parseArgs,
} from '../../scripts/verify-pr-model-proxy.mjs';

const SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-model-proxy.mjs', import.meta.url),
);

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A local upstream stand-in: records the request and the sequence it took to
 * answer (or to be aborted). No outbound network is involved.
 */
async function startUpstream({
  status = 200,
  chunks = ['data: ok\n\n'],
  delayMs = 0,
  chunkDelayMs = 0,
  resetAfterFirstChunk = false,
  resetDelayMs = 50,
  respectBackpressure = false,
} = {}) {
  const requests = [];
  const events = [];
  const server = http.createServer((req, res) => {
    const body = [];
    req.on('data', (chunk) => body.push(chunk));
    req.on('end', async () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        authorization: req.headers.authorization,
        body: Buffer.concat(body).toString('utf8'),
      });
      res.on('finish', () => events.push('upstream-finish'));
      if (delayMs) await sleep(delayMs);
      if (res.destroyed) {
        events.push('aborted-before-headers');
        return;
      }
      res.writeHead(status, { 'content-type': 'text/event-stream' });
      events.push('write-head');
      for (const [index, chunk] of chunks.entries()) {
        if (chunkDelayMs) await sleep(chunkDelayMs);
        if (res.destroyed) {
          events.push('aborted-mid-body');
          return;
        }
        // Respecting backpressure keeps the stream alive while the proxy's
        // downstream is paused; without it the mock buffers the whole body in
        // its own process and the pause never propagates.
        if (!res.write(chunk) && respectBackpressure) {
          await once(res, 'drain');
        }
        if (resetAfterFirstChunk && index === 0) {
          await sleep(resetDelayMs);
          res.destroy();
          events.push('upstream-reset');
          return;
        }
      }
      res.end();
    });
  });
  const port = await listen(server);
  return { port, requests, events };
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

  it('strips hop-by-hop headers and relays a chunked request body', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy(upstream);
    const { port } = new URL(proxy);
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/chat/completions',
          method: 'POST',
          headers: {
            authorization: `Bearer ${TOKEN}`,
            connection: 'x-client-hop',
            'proxy-authorization': 'Basic client-proxy-secret',
            'transfer-encoding': 'chunked',
            expect: '100-continue',
            'content-type': 'application/json',
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.write('{"model":');
      req.end('"m"}');
    });
    expect(status).toBe(200);
    const seen = upstream.requests[0];
    expect(seen.body).toBe('{"model":"m"}');
    expect(seen.authorization).toBe(`Bearer ${REAL_KEY}`);
    expect(seen.headers['proxy-authorization']).toBeUndefined();
    expect(seen.headers.expect).toBeUndefined();
    expect(seen.headers.connection).not.toBe('x-client-hop');
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

  it('aborts the upstream when the client disconnects before headers', async () => {
    const upstream = await startUpstream({ delayMs: 100 });
    const proxy = await startProxy(upstream);
    const { port } = new URL(proxy);
    await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/chat/completions',
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      req.on('error', () => resolve());
      req.end('{}', () => {
        req.destroy();
        resolve();
      });
    });
    await sleep(400);
    expect(upstream.requests).toHaveLength(1);
    // The upstream must never answer a client that is already gone: with the
    // abort registered only after the fetch, it writes headers and the whole
    // completion to a socket nobody reads.
    expect(upstream.events).toContain('aborted-before-headers');
    expect(upstream.events).not.toContain('write-head');
  });

  it('does not abort a healthy stream while the downstream is paused', async () => {
    const chunks = Array.from(
      { length: 128 },
      (_, index) => `${String(index).padStart(3, '0')}:${'x'.repeat(65_520)}\n`,
    );
    chunks.push('TAIL-MARKER');
    const upstream = await startUpstream({
      chunks,
      respectBackpressure: true,
    });
    const proxy = await startProxy(upstream, { idleTimeoutMs: 100 });
    const { port } = new URL(proxy);
    const body = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/chat/completions',
          method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}` },
        },
        (res) => {
          const parts = [];
          res.on('data', (chunk) => parts.push(chunk));
          res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
          res.on('error', reject);
          // Pause past the idle window while the upstream keeps producing:
          // a slow but live client must not be read as upstream idleness.
          res.pause();
          setTimeout(() => res.resume(), 400);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(body).toContain('TAIL-MARKER');
  });

  it('keeps a slow-but-healthy stream alive past the window', async () => {
    const upstream = await startUpstream({
      chunks: ['data: 1\n\n', 'data: 2\n\n', 'data: 3\n\n', 'data: 4\n\n'],
      chunkDelayMs: 40,
    });
    const proxy = await startProxy(upstream, { idleTimeoutMs: 100 });
    const res = await fetch(`${proxy}/chat/completions`, chatRequest());
    expect(res.status).toBe(200);
    // Total delivery (160 ms) outlives the 100 ms window; only the per-chunk
    // re-arm keeps this from being cut.
    expect(await res.text()).toBe(
      'data: 1\n\ndata: 2\n\ndata: 3\n\ndata: 4\n\n',
    );
  });

  it('survives an upstream reset after headers', async () => {
    const upstream = await startUpstream({
      chunks: ['data: partial\n\n'],
      resetAfterFirstChunk: true,
    });
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        PATH: process.env.PATH,
        REVIEW_OPENAI_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
        REVIEW_OPENAI_API_KEY: REAL_KEY,
      },
      // The reset is the point of this test; the proxy's diagnostic for it
      // would only look like a failure in the suite output.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    cleanups.push(async () => {
      child.kill('SIGTERM');
    });
    const line = await new Promise((resolve, reject) => {
      let buffer = '';
      child.stdout.on('data', (data) => {
        buffer += data;
        if (buffer.includes('\n')) resolve(buffer.split('\n')[0]);
      });
      child.on('error', reject);
      child.on('exit', (code) =>
        reject(new Error(`proxy exited before printing: ${code}`)),
      );
    });
    const info = JSON.parse(line);
    await fetch(`http://127.0.0.1:${info.port}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${info.token}` },
      body: '{}',
    }).catch(() => {});
    await sleep(200);
    // The client may see a torn stream; the proxy process must not die on it.
    expect(child.exitCode).toBeNull();
    const health = await fetch(`http://127.0.0.1:${info.port}/__health`);
    expect(health.status).toBe(200);
  });
});

describe('proxy defaults and base url formatting', () => {
  it('keeps the idle window at the client default', () => {
    // packages/core openaiContentGenerator DEFAULT_STREAM_IDLE_TIMEOUT_MS.
    // A tighter proxy would cut streams its own client still tolerates.
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(240_000);
  });

  it('brackets an IPv6 listen host', () => {
    expect(formatLocalBaseUrl('::1', 8080, '/v1')).toBe('http://[::1]:8080/v1');
  });

  it('leaves an IPv4 host alone and tolerates an empty base path', () => {
    expect(formatLocalBaseUrl('192.0.2.10', 8080)).toBe(
      'http://192.0.2.10:8080',
    );
    expect(formatLocalBaseUrl('192.0.2.10', 8080, '/v1')).toBe(
      'http://192.0.2.10:8080/v1',
    );
  });

  it('normalizes base paths', () => {
    expect(normalizeBasePath('/v1/')).toBe('/v1');
    expect(normalizeBasePath('/v1///')).toBe('/v1');
    expect(normalizeBasePath('/')).toBe('');
    expect(normalizeBasePath('')).toBe('');
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

describe('CLI', () => {
  it('exits 2 when the upstream configuration is missing', () => {
    const res = spawnSync(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('REVIEW_OPENAI_BASE_URL');
  });

  it('prints the listen coordinates as JSON and honors the token override', async () => {
    const upstream = await startUpstream();
    const child = spawn(process.execPath, [SCRIPT, '--listen', '0.0.0.0'], {
      env: {
        PATH: process.env.PATH,
        REVIEW_OPENAI_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
        REVIEW_OPENAI_API_KEY: REAL_KEY,
        QWEN_VERIFY_PROXY_TOKEN: 'fixed-token',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    cleanups.push(async () => {
      child.kill('SIGTERM');
    });
    const line = await new Promise((resolve, reject) => {
      let buffer = '';
      child.stdout.on('data', (data) => {
        buffer += data;
        if (buffer.includes('\n')) resolve(buffer.split('\n')[0]);
      });
      child.on('error', reject);
      child.on('exit', (code) =>
        reject(new Error(`proxy exited before printing: ${code}`)),
      );
    });
    const info = JSON.parse(line);
    expect(info.token).toBe('fixed-token');
    // The listen value must reach the printed URL; hard-coding loopback here
    // would hand the container an address it cannot dial.
    expect(info.baseUrl).toBe(`http://0.0.0.0:${info.port}/v1`);
    expect(info.nonce).toMatch(/^[0-9a-f]{48}$/);
    // The printed baseUrl must not leak the real key, and the health
    // endpoint must echo the printed nonce.
    expect(line).not.toContain(REAL_KEY);
    const health = await fetch(`http://127.0.0.1:${info.port}/__health`);
    expect(await health.text()).toBe(info.nonce);
  });
});

/**
 * The recipe is the only place where the trust delegation lives, and a
 * pleasing-looking revert (relative path, attestation on the run line) is
 * invisible to the runtime tests. Pin the load-bearing lines.
 */
describe('local container recipe pins', () => {
  const skill = readFileSync(
    fileURLToPath(
      new URL('../../.qwen/skills/verify-pr/SKILL.md', import.meta.url),
    ),
    'utf8',
  );

  it('runs the key-holding proxy and the checker from a trusted checkout', () => {
    expect(skill).toContain(
      'node <trusted-clone>/scripts/verify-pr-model-proxy.mjs',
    );
    expect(skill).toContain('node <trusted-clone>/scripts/verify-pr-check.mjs');
    expect(skill).not.toMatch(
      /node scripts\/verify-pr-(model-proxy|check)\.mjs/,
    );
  });

  it('mounts the round tree writable and the metadata snapshot read-only', () => {
    expect(skill).toContain('-v <pr-clone>:/work');
    expect(skill).toContain('-v ~/.cache/qwen-verify/pr<n>:/verify-context:ro');
    expect(skill).toContain('QWEN_VERIFY_CONTEXT=/verify-context/pr.json');
  });

  it('reads the real key instead of putting it on a command line', () => {
    expect(skill).toContain("read -rsp 'REVIEW_OPENAI_API_KEY: '");
    expect(skill).not.toContain('REVIEW_OPENAI_API_KEY=<real-key>');
  });

  it('keeps the attestation off the docker run line and behind a check', () => {
    const dockerRun = skill.split('docker run -d')[1]?.split('```')[0] ?? '';
    expect(dockerRun).not.toContain('QWEN_VERIFY_CREDENTIAL_FREE');
    expect(skill).toContain(
      'git -C /work status --porcelain --ignored -- .env',
    );
    expect(skill).toContain('export QWEN_VERIFY_CREDENTIAL_FREE=1');
  });

  it('pins the checker head from the host snapshot', () => {
    expect(skill).toContain('--context ~/.cache/qwen-verify/pr<n>/pr.json');
  });
});
