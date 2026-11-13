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
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error('condition not met before timeout');
}

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
  respectBackpressure = false,
  gzipBody = false,
  headersOnly = false,
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
      if (gzipBody) {
        // The gzip header is what the relay must drop: undici hands the proxy
        // decoded bytes, so forwarding `content-encoding: gzip` makes the
        // client gunzip plain text.
        res.writeHead(status, {
          'content-type': 'text/event-stream',
          'content-encoding': 'gzip',
          'content-length': String(
            gzipSync(Buffer.from(chunks.join(''))).length,
          ),
        });
        events.push('write-head');
        requests.at(-1).sentContentEncoding = 'gzip';
        res.end(gzipSync(Buffer.from(chunks.join(''))));
        return;
      }
      res.writeHead(status, { 'content-type': 'text/event-stream' });
      events.push('write-head');
      if (headersOnly) {
        // Flush so the proxy's fetch resolves on headers; the test is the
        // first-body idle window, not the pre-header one.
        res.flushHeaders();
        return;
      }
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
          // Register on the socket, not unconditionally: the test asserts
          // the upstream really reset after headers.
          res.on('close', () => events.push('upstream-reset'));
          await sleep(50);
          res.destroy();
          return;
        }
      }
      res.end();
    });
  });
  const port = await listen(server);
  return { port, requests, events };
}

async function startProxy(upstream, overrides = {}, basePath = '/v1') {
  const server = createModelProxy({
    baseUrl: `http://127.0.0.1:${upstream.port}${basePath}`,
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
    // Exact path, not a suffix: this must not reach the upstream as
    // /v1/admin/chat/completions.
    const admin = await fetch(`${proxy}/admin/chat/completions`, chatRequest());
    expect(admin.status).toBe(403);
    // The method half matters on its own: a PUT to the allowed path would
    // otherwise spend the real key upstream.
    const put = await fetch(`${proxy}/chat/completions`, {
      ...chatRequest(),
      method: 'PUT',
    });
    expect(put.status).toBe(403);
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

  it('matches the exact path even without a base-path prefix', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy(upstream, {}, '');
    const admin = await fetch(`${proxy}/admin/chat/completions`, chatRequest());
    expect(admin.status).toBe(403);
    expect(upstream.requests).toHaveLength(0);
    const ok = await fetch(`${proxy}/chat/completions`, chatRequest());
    expect(ok.status).toBe(200);
    expect(upstream.requests[0].url).toBe('/chat/completions');
  });

  it('strips the upstream content-encoding instead of forwarding it', async () => {
    const upstream = await startUpstream({
      gzipBody: true,
      chunks: ['data: gzip-ok\n\n'],
    });
    const proxy = await startProxy(upstream);
    const res = await fetch(`${proxy}/chat/completions`, chatRequest());
    expect(res.status).toBe(200);
    // The fixture must really have compressed; otherwise this test would
    // pass against an uncompressed upstream and pin nothing.
    expect(upstream.requests[0].sentContentEncoding).toBe('gzip');
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    // undici already decoded the body; forwarding the header would make the
    // client gunzip plain text.
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toBe('data: gzip-ok\n\n');
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
            connection: ' x-client-hop , keep-alive ',
            'x-client-hop': 'client-secret',
            'x-keep-me': 'kept',
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
    // The Connection-nominated name must not survive under its own spelling;
    // this is the assertion that goes red when the nominated-strip loop is
    // removed (the fixed-set strip alone would still drop `connection`).
    expect(seen.headers['x-client-hop']).toBeUndefined();
    // Passthrough in the positive direction: a custom header NOT nominated
    // by Connection, and the content type, must survive — the stripping is
    // selective, not a wholesale header drop.
    expect(seen.headers['x-keep-me']).toBe('kept');
    expect(seen.headers['content-type']).toBe('application/json');
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

  it('answers 502 and stays alive when the upstream is unreachable', async () => {
    // Bind an ephemeral port and close it: the dial must really be refused.
    // Port 9 would never dial at all — it is on undici's blocked-port list,
    // so fetch rejects with `bad port` before a socket opens and the
    // connect-refused path this test names would go unexercised.
    const dead = http.createServer(() => {});
    const deadPort = await listen(dead);
    await new Promise((resolve) => {
      dead.closeAllConnections();
      dead.close(resolve);
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const proxy = await startProxy({ port: deadPort }, {}, '');
      const res = await fetch(`${proxy}/chat/completions`, chatRequest());
      expect(res.status).toBe(502);
      const failure = logged.mock.calls
        .map((call) => call.find((arg) => arg instanceof Error))
        .find(Boolean);
      expect(failure?.cause?.code).toBe('ECONNREFUSED');
      const health = await fetch(`${proxy}/__health`);
      expect(health.status).toBe(200);
    } finally {
      logged.mockRestore();
    }
  });

  // A slow request UPLOAD is activity: fetch resolves only on the upstream
  // headers, so a window meant for stream silence must not tear a large
  // prompt down mid-upload.
  it('keeps a slow request upload alive past the idle window', async () => {
    const upstream = await startUpstream();
    const proxy = await startProxy(upstream, { idleTimeoutMs: 300 });
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
            'content-type': 'application/json',
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      // Three chunks 150 ms apart: total 450 ms outlives the 300 ms window,
      // and no single gap exceeds it — only the per-chunk re-arm survives.
      req.write('{"model"');
      setTimeout(() => req.write(':"m"'), 150);
      setTimeout(() => req.write(',"stream":false}'), 300);
      setTimeout(() => req.end(), 450);
    });
    expect(status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0].body).toBe('{"model":"m","stream":false}');
  });

  it('aborts when headers arrive but no body follows', async () => {
    const upstream = await startUpstream({ headersOnly: true });
    const proxy = await startProxy(upstream, { idleTimeoutMs: 100 });
    // The upstream flushes headers, then stalls: the first-body idle window
    // must tear the stream down instead of letting it hang.
    await expect(
      fetch(`${proxy}/chat/completions`, chatRequest()),
    ).rejects.toThrow();
    const health = await fetch(`${proxy}/__health`);
    expect(health.status).toBe(200);
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
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/chat/completions',
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    req.on('error', () => {});
    req.end('{}');
    // The end callback does not prove the proxy's upstream request exists yet;
    // wait for the mock to record it, then disconnect while headers are still
    // delayed so the pre-header abort is what the test exercises.
    await waitFor(() => upstream.requests.length === 1);
    req.destroy();
    await sleep(400);
    expect(upstream.requests).toHaveLength(1);
    // The upstream must never answer a client that is already gone: with the
    // abort registered only after the fetch, it writes headers and the whole
    // completion to a socket nobody reads.
    expect(upstream.events).toContain('aborted-before-headers');
    expect(upstream.events).not.toContain('write-head');
  });

  it('aborts the upstream when the client disconnects after headers', async () => {
    const upstream = await startUpstream({
      chunks: ['data: first\n\n', 'data: second\n\n', 'data: third\n\n'],
      chunkDelayMs: 100,
    });
    const proxy = await startProxy(upstream, { idleTimeoutMs: 5000 });
    const { port } = new URL(proxy);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/chat/completions',
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        res.once('data', () => {
          res.destroy();
          req.destroy();
        });
        res.on('error', () => {});
      },
    );
    req.on('error', () => {});
    req.end('{}');
    await waitFor(() => upstream.events.includes('aborted-mid-body'), 3000);
    expect(upstream.events).toContain('aborted-mid-body');
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
    // The pause (800 ms) must exceed the window (300 ms) or the pause guard
    // is never exercised; the margin keeps a loaded runner from flipping it.
    const proxy = await startProxy(upstream, { idleTimeoutMs: 300 });
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
          setTimeout(() => res.resume(), 800);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(body).toBe(chunks.join(''));
  });

  it('keeps a slow-but-healthy stream alive past the window', async () => {
    const upstream = await startUpstream({
      chunks: [
        'data: 1\n\n',
        'data: 2\n\n',
        'data: 3\n\n',
        'data: 4\n\n',
        'data: 5\n\n',
      ],
      chunkDelayMs: 80,
    });
    const proxy = await startProxy(upstream, { idleTimeoutMs: 300 });
    const res = await fetch(`${proxy}/chat/completions`, chatRequest());
    expect(res.status).toBe(200);
    // Total delivery (400 ms) outlives the 300 ms window while every gap
    // (80 ms) stays well inside it: only the per-chunk re-arm keeps this
    // from being cut, and the 220 ms margin survives a loaded runner.
    expect(await res.text()).toBe(
      'data: 1\n\ndata: 2\n\ndata: 3\n\ndata: 4\n\ndata: 5\n\n',
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
    // The CLI-generated token is the container's only credential.
    expect(info.token).toMatch(/^[0-9a-f]{48}$/);
    const res = await fetch(`http://127.0.0.1:${info.port}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${info.token}` },
      body: '{}',
    }).catch(() => null);
    if (res) await res.text().catch(() => {});
    await waitFor(() => upstream.events.includes('upstream-reset'), 2000);
    await sleep(200);
    // The client may see a torn stream; the proxy process must not die on it.
    expect(child.exitCode).toBeNull();
    expect(upstream.events).toContain('upstream-reset');
    const health = await fetch(`http://127.0.0.1:${info.port}/__health`);
    expect(health.status).toBe(200);
  });
});

describe('proxy defaults and base url formatting', () => {
  it('keeps the idle window at the client default', () => {
    // Read the core constant from its source instead of restating it: two
    // hardcoded copies can drift with the suite green. A tighter proxy would
    // cut streams its own client still tolerates.
    const constants = readFileSync(
      fileURLToPath(
        new URL(
          '../../packages/core/src/core/openaiContentGenerator/constants.ts',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    const match = /DEFAULT_STREAM_IDLE_TIMEOUT_MS\s*=\s*(\d+)/.exec(constants);
    expect(match).not.toBeNull();
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(Number(match[1]));
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
    expect(parseArgs([])).toEqual({ listen: '127.0.0.1' });
  });

  it('parses --listen', () => {
    expect(parseArgs(['--listen', '172.17.0.1'])).toEqual({
      listen: '172.17.0.1',
    });
  });

  it('rejects --port, which the recipe does not use', () => {
    expect(() => parseArgs(['--port', '8080'])).toThrow('unknown argument');
  });

  it('rejects unknown arguments and missing values', () => {
    expect(() => parseArgs(['--docker'])).toThrow('unknown argument');
    expect(() => parseArgs(['--listen'])).toThrow('requires a value');
  });

  // server.listen(port, '') binds EVERY interface — past the bridge a
  // key-holding proxy is meant to stay on — and a flag-looking value is a
  // missing value, not a host.
  it('rejects an empty or flag-looking --listen value', () => {
    expect(() => parseArgs(['--listen', ''])).toThrow('requires a value');
    expect(() => parseArgs(['--listen', '--other'])).toThrow(
      'requires a value',
    );
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

  it('runs every round script from the trusted checkout', () => {
    expect(skill).toContain(
      'cd <pr-clone> && node <trusted-clone>/scripts/verify-pr-prepare.mjs',
    );
    expect(skill).toContain(
      'node /trusted-scripts/verify-pr-prepare.mjs --require-isolation',
    );
    expect(skill).toContain(
      'node /trusted-scripts/verify-pr-credential-scan.mjs /work',
    );
    expect(skill).toContain(
      'node <trusted-clone>/scripts/verify-pr-model-proxy.mjs',
    );
    expect(skill).toContain('<trusted-clone>/scripts/verify-pr-guard.mjs');
    expect(skill).toContain(
      '`<clone>` below is the trusted checkout the watch scripts run from',
    );
    // Enumerate the checker call sites: the preamble also names the trusted
    // path, so a single positive assertion cannot detect step 7 reverting to
    // <pr-clone>/scripts.
    const checkerCalls = [
      ...skill.matchAll(/node (\S+)\/scripts\/verify-pr-check\.mjs/g),
    ].map((match) => match[1]);
    expect(checkerCalls.length).toBeGreaterThanOrEqual(3);
    for (const prefix of checkerCalls) expect(prefix).toBe('<trusted-clone>');
    expect(skill).not.toMatch(
      /node <pr-clone>\/scripts\/verify-pr-(prepare|check|model-proxy|guard|watch-state|watch-gate)/,
    );
    expect(skill).not.toMatch(
      /node scripts\/verify-pr-(prepare|check|model-proxy|guard|watch-state|watch-gate)\.mjs/,
    );
  });

  it('base-pins `.qwen` and states that root AGENTS/QWEN.md still come from the PR', () => {
    expect(skill).toContain('git -C <pr-clone> archive "$BASE_OID" -- .qwen');
    expect(skill).toContain(
      '-v ~/.cache/qwen-verify/pr<n>/qwen-base/.qwen:/work/.qwen:ro',
    );
    expect(skill).toContain('`AGENTS.md`/`QWEN.md` do come from the PR clone');
  });

  it('mounts the round tree writable and the metadata snapshot read-only', () => {
    expect(skill).toContain('--user "$(id -u):$(id -g)"');
    expect(skill).toContain('-v <pr-clone>:/work');
    // toContain alone is satisfied by `:/work:ro` — the exact mutation this
    // pin exists to catch — so the read-only spelling is excluded outright.
    expect(skill).not.toContain('-v <pr-clone>:/work:ro');
    expect(skill).toContain('-v <trusted-clone>/scripts:/trusted-scripts:ro');
    expect(skill).toContain('-v ~/.cache/qwen-verify/pr<n>:/verify-context:ro');
    expect(skill).toContain('QWEN_VERIFY_CONTEXT=/verify-context/pr.json');
  });

  it('reads both credentials from files, including without a TTY', () => {
    expect(skill).toContain('if [ -t 0 ]; then');
    expect(skill).toContain('REVIEW_OPENAI_KEY_FILE');
    // `read` returns 1 at EOF even when it assigned the variable: a key file
    // without a trailing newline must be judged by the variable, not the
    // exit status, or the documented agent path aborts with the opposite
    // diagnosis.
    expect(skill).toContain('[ -n "$REVIEW_OPENAI_API_KEY" ]');
    expect(skill).not.toContain('REVIEW_OPENAI_API_KEY=<real-key>');
    // The proxy owns its copy: later diagnostics must not see the key.
    expect(skill).toContain('unset REVIEW_OPENAI_API_KEY');
    expect(skill).toContain('QWEN_VERIFY_PROXY_TOKEN="$(node -e');
    expect(skill).toContain('chmod 600');
    // The background process truncates proxy.json before printing; the loop
    // and the non-empty check keep an empty read from reaching Docker.
    expect(skill).toContain('for _ in {1..100}; do');
    expect(skill).not.toContain('$(seq 1 100)');
    expect(skill).toContain('test -n "$QWEN_VERIFY_PROXY_TOKEN"');
    // The nonce, not just the JSON shape, is checked before use.
    expect(skill).toContain('/__health');
    expect(skill).toContain('fetch(`http://${u.hostname}:${u.port}/__health`)');
    expect(skill).toContain('process.exit(t===j.nonce?0:1)');
    // Each step is its own shell: the token is re-derived where it is used.
    const dockerRun =
      skill.match(/export QWEN_VERIFY_PROXY_TOKEN[\s\S]*?```/)?.[0] ?? '';
    expect(dockerRun).toContain('proxy.json');
    expect(dockerRun).toContain('test -n "$QWEN_VERIFY_PROXY_TOKEN"');
    expect(skill).toMatch(/-e QWEN_VERIFY_PROXY_TOKEN[ \t]*\\?\n/);
    expect(skill).not.toContain('-e QWEN_VERIFY_PROXY_TOKEN=<token>');
    expect(skill).not.toContain('--port');
  });

  it('keeps the attestation off the docker run line and on the round shell', () => {
    const dockerRunMatch = skill.match(/docker run -d[\s\S]*?```/);
    expect(dockerRunMatch).not.toBeNull();
    expect(dockerRunMatch[0]).not.toContain('QWEN_VERIFY_CREDENTIAL_FREE');
    // A fresh docker exec is a new shell: the round's shell must carry the
    // attestation or its first isolation check exits 4.
    expect(skill).toContain(
      'docker exec -i -e QWEN_VERIFY_CREDENTIAL_FREE=1 qwen-verify-<n>',
    );
    const roundBlock = skill.split('qwen --auth-type openai')[0].split('```');
    expect(roundBlock.at(-1)).toContain('QWEN_VERIFY_CREDENTIAL_FREE');
    // The credential hit aborts structurally, not via `set -e`.
    expect(skill).toContain(
      'node /trusted-scripts/verify-pr-credential-scan.mjs /work || exit 1',
    );
  });

  it('names the released CLI as the engine and gives the tree-build route', () => {
    expect(skill).toContain("The round's engine is the released CLI");
    expect(skill).toContain('npm run build && npm run bundle');
    expect(skill).toContain('npm install -g --prefix "$HOME/.local" /work');
  });

  it('refuses a nested repository in the scan description', () => {
    expect(skill).toMatch(/nested\s+git repository outright/);
    expect(skill).toMatch(/vendored\s+git\s+dependency/);
    expect(skill).toContain('not public keys');
    expect(skill).toContain('untracked clone, populated submodule');
  });

  it('names the value-inspection contract and the include-following enumeration', () => {
    expect(skill).toContain('inspects every local config');
    expect(skill).toContain('`http.proxy` included');
    expect(skill).toContain('`url.*.pushInsteadOf`');
    expect(skill).toContain('`Authorization` /');
    expect(skill).toContain('`Proxy-Authorization` header values');
    expect(skill).toContain('bare `git@` account name');
    expect(skill).toMatch(/enumeration\s+follows\s+`include\.path`/);
    expect(skill).toContain('covers the enabled `.git/config.worktree` scope');
    expect(skill).toContain('absent means an empty scope');
    expect(skill).toMatch(/filter name\s+containing `=` is refused outright/);
  });

  it('snapshots the previous report and pins both checker call sites', () => {
    expect(skill).toContain('previous-report.md');
    expect(skill).toContain('issues/<n>/comments');
    const contextCalls = [
      ...skill.matchAll(/verify-pr-check\.mjs --context <host snapshot>/g),
    ];
    expect(contextCalls.length).toBeGreaterThanOrEqual(2);
    // The prose occurrences alone cannot catch step 7 dropping the flag on
    // its continuation line — pin the executable call too.
    expect(skill).toContain(
      '--context ~/.cache/qwen-verify/pr<n>/pr.json <round-dir>',
    );
  });

  it('writes previous-report.md only when a report exists', () => {
    // The file's PRESENCE is the follow-up trigger: an empty file from a
    // first round (or gh error text) misclassifies every round.
    expect(skill).toContain('if [ -n "$PREV" ]; then');
    expect(skill).toContain(
      'else rm -f ~/.cache/qwen-verify/pr<n>/previous-report.md; fi',
    );
    expect(skill).toContain(
      '{ echo "could not read PR comments" >&2; exit 1; }',
    );
    // First-paragraph marker + bot-or-self author, not a bare substring any
    // reply quoting `Verdict:` would satisfy. gh's --slurp cannot combine
    // with --jq, so the selection runs in node over the piped pages.
    expect(skill).toContain('c.body.split("\\n\\n")[0].includes("Verdict:")');
    expect(skill).toContain(
      '/bot$/.test(c.user.login)||c.user.login===process.argv[1]',
    );
  });

  it('copies the review snapshot only when prepare wrote one', () => {
    // Absent means the fetch failed; an earlier round's copy left in the
    // cache would read as this round's review state.
    expect(skill).toContain(
      'rm -f ~/.cache/qwen-verify/pr<n>/review-threads.json',
    );
    expect(skill).toContain(
      'if [ -f <pr-clone>/tmp/verify-context/pr<n>-review-threads.json ]; then',
    );
    // The container sees only the name the skill tells the round to read.
    const cp = skill.indexOf(
      'cp <pr-clone>/tmp/verify-context/pr<n>-review-threads.json ~/.cache/qwen-verify/pr<n>/review-threads.json',
    );
    // Clear first, then copy: the other way round deletes the copy it just
    // made, and every local round would read the review state as unknown.
    const rm = skill.indexOf(
      'rm -f ~/.cache/qwen-verify/pr<n>/review-threads.json',
    );
    const test = skill.indexOf(
      'if [ -f <pr-clone>/tmp/verify-context/pr<n>-review-threads.json ]; then',
    );
    expect(rm).toBeGreaterThan(-1);
    expect(test).toBeGreaterThan(rm);
    expect(cp).toBeGreaterThan(test);
  });

  it('keeps the proxy JSON parseable and the base extraction fresh', () => {
    // One stderr line folded into proxy.json breaks every parse of it.
    expect(skill).toContain(
      '> ~/.cache/qwen-verify/pr<n>/proxy.json 2> ~/.cache/qwen-verify/pr<n>/proxy.err',
    );
    // Add-only extraction would keep a .qwen file the base deleted.
    expect(skill).toContain('rm -rf ~/.cache/qwen-verify/pr<n>/qwen-base');
  });

  it('hashes the base-pinned skill copy in the publish footer', () => {
    // The round loads the base commit's .qwen, not the PR head's: hashing
    // the head would certify instructions the round never ran.
    expect(skill).toContain(
      'git -C <pr-clone> rev-parse "<baseRefOid>:.qwen/skills/verify-pr/SKILL.md"',
    );
    expect(skill).toContain("never the PR head's copy");
  });
});
