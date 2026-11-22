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
import { checkArtifacts } from '../../scripts/verify-pr-check.mjs';

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

  it('runs every round script from the trusted checkout', async () => {
    const { parseShellCommand } = await import(
      '@qwen-code/qwen-code-core/utils/shellAstParser.js'
    );
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
      ...skill.matchAll(/node "?([^"\s]+)\/scripts\/verify-pr-check\.mjs/g),
    ].map((match) => match[1]);
    expect(checkerCalls.length).toBeGreaterThanOrEqual(3);
    for (const prefix of checkerCalls) expect(prefix).toBe('<trusted-clone>');
    // The prepare calls are an exact closed set, but their arguments are not
    // one exact line: host/VM modes are valid with their required approvals.
    // This is deliberately not a shell parser; only the documented vocabulary
    // and one known logging suffix are accepted.
    const basic = ' <n> --repo <owner>/<repo> --execution container';
    const logSuffix =
      '> ~/.cache/qwen-verify/pr<n>/prepare.log 2>&1 || { cat ~/.cache/qwen-verify/pr<n>/prepare.log >&2; exit 1; }';
    const logged = ` ${basic.trim()} --context-out ~/.cache/qwen-verify/pr<n>/pr.json ${logSuffix}`;
    const script = '<trusted-clone>/scripts/verify-pr-prepare.mjs';
    const valueFlags = new Set([
      '--repo',
      '--execution',
      '--round',
      '--reason',
      '--context-out',
      '--approval',
      '--state-root',
      '--attestation',
    ]);
    const validToken = (token) => {
      const unquoted =
        token.startsWith('"') && token.endsWith('"') && token.length >= 2
          ? token.slice(1, -1)
          : token;
      return (
        unquoted.length > 0 &&
        !/[`$;|&()"'[\]{}\\]/.test(unquoted) &&
        (!/[<>]/.test(unquoted) || /^<[^<>]+>$/.test(unquoted))
      );
    };
    const validCoordinate = (raw) => {
      let text = raw.replace(/\s+/g, ' ').trim();
      if (text.endsWith(logSuffix)) {
        text = text.slice(0, -logSuffix.length).trim();
      }
      text = text.replace(/(^|\s)--repo=/g, '$1--repo ');
      // Only the documented call vocabulary may pass. Spaces inside quoted
      // text are not parsed, but shell substitution/operators never become
      // an option value merely because they follow another string.
      if (/[`$;|&]/.test(text)) return false;
      const options = new Map();
      const positional = [];
      const tokens = text.split(' ').filter(Boolean);
      if (!tokens.every(validToken)) return false;
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--trust-pr-head') {
          if (options.has(token)) return false;
          options.set(token, true);
        } else if (token.startsWith('--')) {
          const value = tokens[index + 1];
          if (
            !valueFlags.has(token) ||
            options.has(token) ||
            !value ||
            value.startsWith('--')
          ) {
            return false;
          }
          options.set(token, value);
          index += 1;
        } else {
          positional.push(token);
        }
      }
      if (
        positional.join(' ') !== '<n>' ||
        !/^(?:<owner>\/<repo>|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.test(
          options.get('--repo') ?? '',
        ) ||
        !options.has('--execution')
      ) {
        return false;
      }
      const approval = options.get('--approval');
      if (
        approval !== undefined &&
        approval !== '<url>' &&
        !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/\d+#issuecomment-\d+$/.test(
          approval,
        )
      ) {
        return false;
      }
      const execution = options.get('--execution');
      if (execution === 'container') {
        return [...options.keys()].every((key) =>
          ['--repo', '--execution', '--context-out'].includes(key),
        );
      }
      if (!['host', 'vm'].includes(execution)) return false;
      if (!/^(?:[1-9]\d*|<r>)$/.test(options.get('--round'))) return false;
      if (
        ['--round', '--reason', '--context-out'].some(
          (key) => !options.has(key),
        ) ||
        options.has('--trust-pr-head') === options.has('--approval') ||
        (options.has('--approval') && !options.has('--state-root')) ||
        (options.has('--trust-pr-head') && options.has('--state-root')) ||
        (execution === 'vm') !== options.has('--attestation')
      ) {
        return false;
      }
      return true;
    };
    // This is a closed vocabulary for the documented calls, not a general
    // shell parser. A different entry point, path, option, or value fails.
    const placeholder = '<[A-Za-z0-9_./,:-]+>';
    const value = String.raw`(?:[A-Za-z0-9_~./:+=-]+|${placeholder}|"(?:${placeholder}|\$rd)")`;
    const repo = String.raw`(?:<owner>/<repo>|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)`;
    const head = '(?:<headSha>|<40hex>|<H>)';
    const round = '(?:<r>|[1-9][0-9]*)';
    const verdict =
      '(?:merge-ready|findings|blocked|inconclusive|<word>|<verdict>)';
    const stateRoot = ' --state-root "<trusted-dir>"';
    const exact = (body) => new RegExp(`^${body.trim()}$`);
    const validHelperArguments = (kind, raw, quotedGate = false) => {
      let text = raw.replace(/\s+/g, ' ').trim();
      const codeEnd = text.indexOf('`');
      if (codeEnd >= 0) {
        const explanation = text.slice(codeEnd + 1).trim();
        if (
          !/^[).,:]*\s*(?:[A-Za-z][A-Za-z0-9 .,()_:-]*)?$/.test(explanation)
        ) {
          return false;
        }
        text = text.slice(0, codeEnd);
      }
      if (
        kind === 'prepare' &&
        text.endsWith(logSuffix) &&
        text.includes('--context-out')
      ) {
        text = text.slice(0, -logSuffix.length).trimEnd();
      } else if (
        kind === 'model-proxy' &&
        text.endsWith(
          '> ~/.cache/qwen-verify/pr<n>/proxy.json 2> ~/.cache/qwen-verify/pr<n>/proxy.err &',
        )
      ) {
        text = text.slice(
          0,
          -'> ~/.cache/qwen-verify/pr<n>/proxy.json 2> ~/.cache/qwen-verify/pr<n>/proxy.err &'
            .length,
        );
      } else if (kind === 'check' && text.endsWith('|| rc=$?')) {
        text = text.slice(0, -'|| rc=$?'.length);
      } else if (kind === 'credential-scan' && text.endsWith('|| exit 1')) {
        text = text.slice(0, -'|| exit 1'.length);
      }
      text = text.trim();
      const cliGate = kind === 'watch-gate' && text.includes(' --cli ');
      if (quotedGate !== cliGate) return false;
      if (kind !== 'check' && text.includes('$(cat ')) return false;
      text = text
        .replace(
          /"\$\(cat ~\/\.cache\/qwen-verify\/pr<n>\/pr\.sha256\)"/g,
          '<digest>',
        )
        .replace(/(^|\s)--repo=/g, '$1--repo ')
        .replaceAll('[--round <r>]', '--round <r>')
        .replaceAll('[--artifact-dir <dir>]', '--artifact-dir <artifact-dir>')
        .replaceAll('[--comment-id <id>]', '--comment-id <id>')
        .replaceAll('<blocking head>', '<headSha>')
        .replaceAll('<host snapshot>', '<host-snapshot>')
        .replaceAll('<artifact dir>', '<artifact-dir>')
        .replaceAll('<absolute qwen>', '<absolute-qwen>')
        .replaceAll('pr<n>', 'prN')
        .replaceAll('<owner>/<repo>', 'owner/repo');
      if (kind === 'prepare') {
        return (
          validCoordinate(text) ||
          text === '--require-isolation --artifact-dir <round-dir>'
        );
      }
      if (kind === 'check') {
        return exact(
          String.raw` --context ${value} --context-sha256 <digest>(?: --context-root ${value})? ${value}`,
        ).test(text);
      }
      if (kind === 'model-proxy') {
        return exact(String.raw` --listen ${value}`).test(text);
      }
      if (kind === 'credential-scan') return text === '/work';
      if (kind === 'watch-state') {
        const start = exact(
          String.raw` <n> --start --head ${head} --round ${round} --repo ${repo}(?:${stateRoot})?`,
        );
        const complete = exact(
          String.raw` <n> --complete --head ${head} --round ${round}(?: --registration-nonce <nonce>)? --verdict ${verdict}(?: --artifact-dir ${value})?(?: --comment-id ${value})? --repo ${repo}(?:${stateRoot})?`,
        );
        const release = exact(
          String.raw` <n> --release --head ${head}(?: --round ${round})?(?: --registration-nonce <nonce>)? --repo ${repo}(?:${stateRoot})?`,
        );
        if (start.test(text)) return 'start';
        if (complete.test(text)) return 'complete';
        if (release.test(text)) return 'release';
        return false;
      }
      if (kind === 'watch-gate') {
        return (
          exact(' <n> --check --claim').test(text) ||
          exact(' <n> --release').test(text) ||
          exact(` <n> --repo ${repo} --cli <absolute-qwen>`).test(text)
        );
      }
      return false;
    };
    const trustedPath = (path) =>
      !path.split('/').includes('..') &&
      !path.includes('\\') &&
      !/[*?[\]{}]/.test(path) &&
      [
        `${script.slice(0, script.lastIndexOf('/') + 1)}`,
        '<clone>/scripts/',
        '/trusted-scripts/',
      ].some((prefix) => path.startsWith(prefix)) &&
      /^(?:(?:<trusted-clone>|<clone>)\/scripts\/|\/trusted-scripts\/)verify-pr-[a-z-]+\.mjs$/.test(
        path,
      );
    const proxyJson = '~/.cache/qwen-verify/pr<n>/proxy.json';
    const trustedNodeEvaluations = new Map([
      [
        'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const all=JSON.parse(d).flat();const hit=all.filter(c=>(/bot$/.test(c.user.login)||c.user.login===process.argv[1])&&c.body.split("\\n\\n")[0].includes("Verdict:")).pop();process.stdout.write(hit?hit.body+"\\n":"")})',
        ['"$ME"'],
      ],
      [
        'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).baseRefOid)',
        ['~/.cache/qwen-verify/pr<n>/pr.json'],
      ],
      [
        'const j=JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); if (!j.token) process.exit(1)',
        [proxyJson],
      ],
      [
        'const fs=require("node:fs"); const j=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const u=new URL(j.baseUrl); fetch(`http://${u.hostname}:${u.port}/__health`).then(r=>r.text()).then(t=>process.exit(t===j.nonce?0:1)).catch(()=>process.exit(1))',
        [proxyJson],
      ],
      [
        'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).token)',
        [proxyJson],
      ],
    ]);
    const shellFragmentResults = new Map();
    const onlyDocumentedPrepareCalls = async (document) => {
      // This is a closed grammar for the recipe's executable examples, not an
      // OS-level shell sandbox. Data citations stay data; every selected shell
      // program is parsed in full and every command must have a registered shape.
      const fragments = [];
      const foldContinuations = (text) => text.replace(/\\\r?\n[ \t]*/g, '');
      const nodeProgramBoundary = (text) =>
        /^node\s+(?:-|["']?(?:\/|<|\$)|\S+\.[cm]?js(?=\s|$))/.test(text);
      const fencedRanges = [];
      const fence =
        /^([ \t]*)```([A-Za-z0-9_-]+)[^\n]*\n([\s\S]*?)^\1```[^\n]*$/gm;
      for (const match of document.matchAll(fence)) {
        fencedRanges.push([match.index, match.index + match[0].length]);
        const body = match[3]
          .split('\n')
          .map((line) =>
            line.startsWith(match[1]) ? line.slice(match[1].length) : line,
          )
          .join('\n');
        const language = match[2].toLowerCase();
        const textHelperExample =
          language === 'text' &&
          nodeProgramBoundary(foldContinuations(body).trim());
        if (!['bash', 'sh', 'shell'].includes(language) && !textHelperExample) {
          continue;
        }
        fragments.push({ source: body, quotedGate: false });
      }
      const inFences = (index) =>
        fencedRanges.some(([start, end]) => index >= start && index < end);
      const proseCommandFragments = new Set([
        'chmod 444',
        'chmod 555',
        'cp -a',
        'cp -al',
        'docker cp',
        'docker exec',
        'docker run',
        "printf '%s'",
        'rm -rf',
        'container=<name>',
        'cwd=<pr-clone>',
        'HARNESS_TURN_DEADLINE=600000',
        'href=""',
        'modelRequestsInFlightAtAbort=1',
        'QWEN_SANDBOX_IMAGE=ghcr.io/qwenlm/qwen-code:<label>',
        'QWEN_SANDBOX_IMAGE_TAG=<label>',
        'QWEN_VERIFY_CREDENTIAL_FREE=1',
        'QWEN_VERIFY_JAVA=1',
        'qwencode=<n>',
        'ref=refs/heads/<branch>',
        'SANDBOX=sandbox-exec',
      ]);
      const citation = (match) => {
        const content = match[2].trim();
        if (proseCommandFragments.has(content)) return true;
        const lineStart = document.lastIndexOf('\n', match.index - 1) + 1;
        const linePrefix = document.slice(lineStart, match.index);
        if (
          content === 'node scripts/lint.js' &&
          /Never run\s*$/.test(linePrefix)
        ) {
          return true;
        }
        if (
          ['node', 'bash -e', 'bash --noprofile --norc', 'bash -n'].includes(
            content,
          ) ||
          /^[a-z][a-z0-9-]*$/.test(content)
        ) {
          return true;
        }
        if (
          !content.endsWith('.mjs') &&
          /^[A-Za-z0-9_.~/<>:-]+$/.test(content) &&
          /\.[A-Za-z0-9]+$/.test(content)
        ) {
          return true;
        }
        if (
          !/^['"]?(?:(?:<trusted-clone>|<clone>)\/scripts\/|\/trusted-scripts\/|scripts\/)?verify-pr-[a-z-]+\.mjs['"]?$/.test(
            content,
          )
        ) {
          return false;
        }
        const opening = match.index;
        const closing = opening + match[0].length;
        const before = document.slice(0, opening);
        const prior = before.trimEnd().at(-1);
        if (
          ['(', '[', '{', '/', '"', "'", '&', '|', ';', '<', '>', '$'].includes(
            prior,
          ) ||
          /[|&;<>]+\s*(?:#[^\n]*\s*)*$/.test(before)
        ) {
          return false;
        }
        const following = document.slice(closing).trimStart();
        if (
          /^[)\]}]/.test(following) ||
          following.startsWith('/') ||
          /^\.[A-Za-z_$]/.test(following)
        ) {
          return false;
        }
        const lineEnd = document.indexOf('\n', closing);
        const trailing = document
          .slice(closing, lineEnd < 0 ? document.length : lineEnd)
          .trim();
        return !/[;|&$<>]/.test(trailing);
      };
      // Raw Markdown needs a structural command boundary so ordinary English
      // is not fed to the shell parser. Inside an actual Bash fence there is no
      // such pre-filter: the complete block was already selected above.
      const executableBoundary = (source) => {
        const text = foldContinuations(source).trim();
        const checks = [
          /^gate:/,
          /^(?:NODE_OPTIONS\s*=|alias\s|function\s|node\s*\(\s*\))/,
          /^command\s+(?:-v(?:\s|$)|["'$/]|node(?=\s|$))/,
          /^\/(?:[A-Za-z0-9_.-]+\/)+(?:env|nice|sudo)(?=\s|$)/,
          /^(?:env|nice|sudo|exec|eval|sh|cd|touch|cat|echo|grep|printf|sed|cp|rm|mkdir|chmod|kill|docker|python3|true)(?=\s|$)/,
          /^read\s+(?:-|[A-Z_][A-Z0-9_]*(?:\s|$))/,
          /^scripts\/\S+\s/,
          /^verify-pr-/,
          /^["']?(?:\/[A-Za-z0-9_.-]+)*\/(?:node|bash|sh|verify-pr-[a-z-]+\.mjs)(?=\s|$)/,
          /^qwen\s+.*--approval-mode\s/,
          /^(?:bash|sh)\s+-[a-z]*c(?:\s|$)/,
          /^for\s+[A-Za-z_][A-Za-z0-9_]*\s+in\s/,
          /^(?:export\s+[A-Za-z_][A-Za-z0-9_]*(?:=|\s|$)|unset(?:\s+[A-Za-z_][A-Za-z0-9_]*)+\s*$|[A-Za-z_][A-Za-z0-9_]*=)/,
          /(?:^|[;&|]\s*)(?:["']?(?:\/[A-Za-z0-9_.-]+)*\/node|node)\s+(?:-e|--eval)(?=\s|$)/,
          /(?:^|[;&|]\s*)[^\s;|&]*\$\([^)]*\)[^\s;|&]*\s+(?:-e|--eval)(?=\s|$)/,
          /(?:^|[;&|]\s*)python3(?=\s|$)/,
          /^(?=[A-Za-z_$/'"\\`])\S+\s+(?:(?:-e|--eval)(?=\s|$)|["']?\S+\.[cm]?js(?=\s|$))/,
        ];
        return (
          nodeProgramBoundary(text) || checks.some((check) => check.test(text))
        );
      };
      const spans = [...document.matchAll(/(`+)([\s\S]*?)\1/g)];
      const inCodeSpan = (index) =>
        spans.some(
          (match) =>
            index >= match.index && index < match.index + match[0].length,
        );
      for (const match of spans) {
        if (inFences(match.index) || citation(match)) continue;
        let source = match[2].trim();
        if (!executableBoundary(source)) continue;
        let quotedGate = false;
        if (source.startsWith('gate:')) {
          const gate = source.match(/^gate:\s*"([\s\S]+)"$/);
          if (!gate) return false;
          source = gate[1];
          quotedGate = true;
        }
        fragments.push({ source, quotedGate });
      }
      let lineStart = 0;
      const rawLines = document.split('\n');
      for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
        const inFence = inFences(lineStart);
        const inSpan = inCodeSpan(lineStart);
        let continuationEnd = lineIndex;
        let chainContinues = false;
        while (continuationEnd + 1 < rawLines.length) {
          const line = rawLines[continuationEnd];
          if (chainContinues && /^\s*#/.test(line)) {
            continuationEnd += 1;
            continue;
          }
          chainContinues = /(?:&&|\|\||\|&?)[ \t]*(?:#[^\r\n]*)?\r?$/.test(
            line,
          );
          if (!/\\[ \t]*\r?$/.test(line) && !chainContinues) break;
          continuationEnd += 1;
        }
        const source = rawLines
          .slice(lineIndex, continuationEnd + 1)
          .join('\n');
        const trimmed = rawLines[lineIndex].trim();
        const plainCitation =
          /^[('"]*(?:(?:<trusted-clone>|<clone>)\/scripts\/|\/trusted-scripts\/|scripts\/)?verify-pr-[a-z-]+\.mjs[\s'")\],.:]*$/.test(
            trimmed,
          );
        const leadingCitation = spans.find((match) => {
          const start = match.index - lineStart;
          return (
            start >= 0 &&
            start + match[0].length <= rawLines[lineIndex].length &&
            !rawLines[lineIndex].slice(0, start).trim()
          );
        });
        const citationLineWithoutExecutableTrailer =
          leadingCitation &&
          !executableBoundary(
            rawLines[lineIndex].slice(
              leadingCitation.index + leadingCitation[0].length - lineStart,
            ),
          );
        if (
          !inFence &&
          (!inSpan || leadingCitation) &&
          !plainCitation &&
          !citationLineWithoutExecutableTrailer &&
          executableBoundary(source)
        ) {
          fragments.push({ source, quotedGate: false });
        }
        for (let index = lineIndex; index <= continuationEnd; index += 1) {
          lineStart += rawLines[index].length + 1;
        }
        lineIndex = continuationEnd;
      }

      const calls = [];
      const staticText = (node, source) => {
        const raw = source.slice(node.startIndex, node.endIndex);
        if (node.type === 'word' || node.type === 'number') return raw;
        if (node.type === 'raw_string') return raw.slice(1, -1);
        if (
          node.type === 'string' &&
          node.namedChildren.every((child) => child.type === 'string_content')
        ) {
          return raw.slice(1, -1);
        }
        if (node.type === 'command_name' && node.namedChildCount === 1) {
          return staticText(node.namedChild(0), source);
        }
        return null;
      };
      const staticCommandName = (node, source) => {
        if (node.type !== 'command_name' || node.namedChildCount !== 1) {
          return null;
        }
        const child = node.namedChild(0);
        if (child.type === 'word') {
          const raw = source.slice(child.startIndex, child.endIndex);
          return raw.includes('\\') ? null : raw;
        }
        return staticText(child, source);
      };
      const argumentNodes = (command) => {
        const result = [];
        for (let index = 0; index < command.childCount; index += 1) {
          if (command.fieldNameForChild(index) === 'argument') {
            result.push(command.child(index));
          }
        }
        return result;
      };
      const walk = (node, visit) => {
        visit(node);
        for (const child of node.namedChildren) walk(child, visit);
      };
      const allowedNodes = new Set(
        'program command command_name word number raw_string string string_content comment list redirected_statement file_redirect file_descriptor compound_statement if_statement test_command unary_expression binary_expression test_operator regex variable_assignment variable_name command_substitution pipeline simple_expansion expansion concatenation else_clause declaration_command special_variable_name unset_command for_statement brace_expression do_group while_statement heredoc_redirect heredoc_start heredoc_body heredoc_end subshell negated_command'.split(
          ' ',
        ),
      );
      const trustedInterpreters = new Set([
        'node',
        '/bin/node',
        '/usr/bin/node',
        '/usr/local/bin/node',
      ]);
      const unquote = (raw) =>
        raw.length >= 2 &&
        ((raw.startsWith('"') && raw.endsWith('"')) ||
          (raw.startsWith("'") && raw.endsWith("'")))
          ? raw.slice(1, -1)
          : raw;
      const cacheRoot = '~/.cache/qwen-verify/pr<n>';
      const cachePath = (raw, suffix) =>
        unquote(raw) === `${cacheRoot}/${suffix}`;
      const relativeDataPath = (raw) => {
        const path = unquote(raw);
        return (
          /^(?:\.\/)?[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(path) &&
          !path.split('/').includes('..')
        );
      };
      const captureOutputPath = (path) =>
        /^(?:(?:tmp\/pr<n>-verify-<ts>\/)?evidence|…)\/[A-Za-z0-9][A-Za-z0-9._-]*\.png$/.test(
          path,
        );
      const validCaptureArguments = (values) => {
        let index = 1;
        const seen = new Set();
        while (index < values.length && values[index] !== '--') {
          const option = values[index];
          const argument = values[index + 1];
          if (
            !['--out', '--title', '--rows', '--cols'].includes(option) ||
            seen.has(option) ||
            typeof argument !== 'string' ||
            argument.startsWith('--')
          ) {
            return false;
          }
          if (option === '--out' && !captureOutputPath(argument)) return false;
          if (['--rows', '--cols'].includes(option)) {
            const size = Number(argument);
            if (
              !/^\d+$/.test(argument) ||
              !Number.isInteger(size) ||
              size < 1 ||
              size > 500
            ) {
              return false;
            }
          }
          seen.add(option);
          index += 2;
        }
        const tail = values.slice(index + 1);
        return (
          seen.has('--out') &&
          values[index] === '--' &&
          (tail.join(' ') === '<cmd>' ||
            tail.join(' ') === 'node my-harness.mjs')
        );
      };
      const inspect = async (
        {
          source,
          quotedGate,
          trustedDockerExec = false,
          credentialFreeDockerExec = false,
        },
        depth = 0,
      ) => {
        if (depth > 4 || source.length > 200_000) return false;
        // tree-sitter-bash 0.23.1 crashes on `!=` inside `[ ... ]` under the
        // current WASM runtime. Polarity is irrelevant to command validation;
        // this equal-length parser-only spelling preserves every source offset.
        const parsed = source
          .replace(/<[^<>\r\n]+>/g, (placeholder) =>
            'P'.repeat(placeholder.length),
          )
          .replaceAll('!=', '= ');
        let tree;
        try {
          tree = await parseShellCommand(parsed);
        } catch {
          return false;
        }
        try {
          if (tree.rootNode.hasError) return false;
          let valid = true;
          let visited = 0;
          const nested = [];
          const rawArgument = (arg) =>
            foldContinuations(source.slice(arg.startIndex, arg.endIndex));
          const commandParts = (command) => {
            const nameNode = command.childForFieldName('name');
            const commandArguments = argumentNodes(command);
            return {
              name: nameNode ? staticCommandName(nameNode, source) : null,
              args: commandArguments,
              values: commandArguments.map((arg) => staticText(arg, source)),
              rawValues: commandArguments.map(rawArgument),
            };
          };
          const validFileRedirect = (redirect) => {
            const raw = foldContinuations(
              source.slice(redirect.startIndex, redirect.endIndex),
            );
            let owner = null;
            const findOwner = (candidate) => {
              if (
                candidate.type === 'command' &&
                candidate.endIndex <= redirect.startIndex &&
                (!owner || candidate.endIndex > owner.endIndex)
              ) {
                owner = candidate;
              }
              for (const child of candidate.namedChildren) findOwner(child);
            };
            if (redirect.parent) findOwner(redirect.parent);
            if (!owner) return false;
            if (['>&2', '2>&1'].includes(raw)) return true;
            const { name, values, rawValues } = commandParts(owner);
            const modulePath = trustedInterpreters.has(name) ? values[0] : null;
            const helper = (family) =>
              typeof modulePath === 'string' &&
              modulePath.endsWith(`verify-pr-${family}.mjs`);
            if (raw === '2>/dev/null') {
              return name === 'kill' || modulePath === '-e';
            }
            if (
              raw ===
              '< "${REVIEW_OPENAI_KEY_FILE:-$HOME/.config/qwen-verify/review-openai-key}"'
            ) {
              return (
                name === 'read' &&
                rawValues.join(' ') === '-r REVIEW_OPENAI_API_KEY'
              );
            }
            if (raw === `> ${cacheRoot}/prepare.log`) {
              return helper('prepare');
            }
            if (raw === `> ${cacheRoot}/pr.sha256`) {
              return name === 'sed';
            }
            if (raw === `> ${cacheRoot}/previous-report.md`) {
              return name === 'printf' && rawValues[1] === '"$PREV"';
            }
            if (
              raw === `> ${cacheRoot}/proxy.json` ||
              raw === `2> ${cacheRoot}/proxy.err`
            ) {
              return helper('model-proxy');
            }
            if (raw === `> ${cacheRoot}/proxy.pid`) {
              return name === 'echo' && rawValues.join(' ') === '$!';
            }
            if (raw === '> "$rd/boundary.json"') {
              return name === 'printf';
            }
            if (raw === '> "$HOME/.qwen/settings.json"') {
              return trustedDockerExec && name === 'cat' && values.length === 0;
            }
            return false;
          };
          const validVariableAssignment = (assignment) => {
            const raw = foldContinuations(
              source.slice(assignment.startIndex, assignment.endIndex),
            );
            const nameNode = assignment.namedChildren.find(
              (child) => child.type === 'variable_name',
            );
            const name = nameNode
              ? source.slice(nameNode.startIndex, nameNode.endIndex)
              : null;
            const assigned = raw.slice(raw.indexOf('=') + 1);
            const parent = assignment.parent;
            const parentName =
              parent?.type === 'command'
                ? staticCommandName(parent.childForFieldName('name'), source)
                : null;
            if (['ME', 'PREV', 'BASE_OID'].includes(name)) {
              return (
                parent?.type !== 'command' &&
                parent?.type !== 'declaration_command' &&
                assigned.startsWith('"$(') &&
                assigned.endsWith(')"')
              );
            }
            if (name === 'REVIEW_OPENAI_BASE_URL') {
              return parentName === 'node' && assigned === '<upstream-url>';
            }
            if (name === 'IFS') {
              return parentName === 'read' && assigned === '';
            }
            if (name === 'QWEN_VERIFY_PROXY_TOKEN') {
              return (
                parent?.type === 'declaration_command' &&
                assigned.startsWith('"$(node -e ') &&
                assigned.endsWith(')"') &&
                assigned.includes('.token)') &&
                assigned.includes(`${cacheRoot}/proxy.json`)
              );
            }
            if (name === 'QWEN_VERIFY_CREDENTIAL_FREE') {
              return (
                trustedDockerExec &&
                parent?.type === 'declaration_command' &&
                assigned === '1'
              );
            }
            if (name === 'PATH') {
              return (
                trustedDockerExec &&
                parent?.type === 'declaration_command' &&
                assigned === '"$HOME/.local/bin:$PATH"'
              );
            }
            if (name === 'rc') {
              return (
                !['command', 'declaration_command'].includes(parent?.type) &&
                ['0', '1', '$?'].includes(assigned)
              );
            }
            if (name === 'rd') {
              return (
                !['command', 'declaration_command'].includes(parent?.type) &&
                ['"<round-dir>"', '"${rd%/}"'].includes(assigned)
              );
            }
            return false;
          };
          const validDataCommand = (name, command, values, rawValues) => {
            let statement = command.parent;
            while (
              statement &&
              ['list', 'pipeline', 'negated_command'].includes(statement.type)
            ) {
              statement = statement.parent;
            }
            const redirects =
              statement?.type === 'redirected_statement'
                ? statement.namedChildren.filter(
                    (child) => child.type === 'file_redirect',
                  )
                : [];
            const hasHeredoc =
              statement?.type === 'redirected_statement' &&
              statement.namedChildren.some(
                (child) => child.type === 'heredoc_redirect',
              );
            if (name === 'break' || name === 'true') return values.length === 0;
            if (name === 'cat') {
              if (values.length === 0) {
                return (
                  hasHeredoc ||
                  (trustedDockerExec &&
                    redirects.some((redirect) => validFileRedirect(redirect)))
                );
              }
              return (
                values.length === 1 &&
                (relativeDataPath(rawValues[0]) ||
                  ['prepare.log', 'pr.sha256', 'proxy.pid'].some((suffix) =>
                    cachePath(rawValues[0], suffix),
                  ))
              );
            }
            if (name === 'cd') {
              return (
                rawValues.length === 1 && unquote(rawValues[0]) === '<pr-clone>'
              );
            }
            if (name === 'chmod') {
              return (
                rawValues.length === 2 &&
                rawValues[0] === '600' &&
                cachePath(rawValues[1], 'proxy.json')
              );
            }
            if (name === 'cp') {
              return (
                rawValues.length === 2 &&
                rawValues[0] ===
                  '<pr-clone>/tmp/verify-context/pr<n>-review-threads.json' &&
                cachePath(rawValues[1], 'review-threads.json')
              );
            }
            if (name === 'dirname') {
              return rawValues.length === 1 && rawValues[0] === '"$rd"';
            }
            if (name === 'echo') {
              return (
                values.every(
                  (value) =>
                    typeof value === 'string' && !value.startsWith('-'),
                ) ||
                (rawValues.length === 1 &&
                  ['$!', '"$RUNNER_TEMP"'].includes(rawValues[0]))
              );
            }
            if (name === 'exit') {
              return (
                rawValues.length === 1 && ['1', '"$rc"'].includes(rawValues[0])
              );
            }
            if (name === 'grep') {
              if (
                rawValues.length === 3 &&
                rawValues[0] === '-Eq' &&
                values[1] === '^[0-9a-f]{64}$'
              ) {
                return cachePath(rawValues[2], 'pr.sha256');
              }
              if (
                values.length >= 2 &&
                values.length <= 3 &&
                ['-E', '-e'].includes(values[0]) &&
                typeof values[1] === 'string'
              ) {
                return values.length === 2 || relativeDataPath(rawValues[2]);
              }
              return false;
            }
            if (name === 'id') {
              return values.length === 1 && ['-u', '-g'].includes(values[0]);
            }
            if (name === 'kill') {
              return (
                rawValues.length === 1 &&
                rawValues[0] === `"$(cat ${cacheRoot}/proxy.pid)"`
              );
            }
            if (name === 'mkdir') {
              return (
                rawValues.length === 2 &&
                rawValues[0] === '-p' &&
                (unquote(rawValues[1]) === cacheRoot ||
                  cachePath(rawValues[1], 'qwen-base') ||
                  (trustedDockerExec && rawValues[1] === '"$HOME/.qwen"'))
              );
            }
            if (name === 'printf') {
              const destinations = redirects.map((redirect) =>
                foldContinuations(
                  source.slice(redirect.startIndex, redirect.endIndex),
                ),
              );
              if (destinations.includes(`> ${cacheRoot}/previous-report.md`)) {
                return (
                  rawValues.length === 2 &&
                  rawValues[0] === "'%s\\n'" &&
                  rawValues[1] === '"$PREV"'
                );
              }
              if (destinations.includes('> "$rd/boundary.json"')) {
                return (
                  rawValues.length === 2 &&
                  rawValues[0] === "'%s\\n'" &&
                  rawValues[1] ===
                    '\'{"mode":"container","detail":"<image, network policy, credential-free mount>"}\''
                );
              }
              if (values.length === 1 && values[0] === '%s') return true;
              if (values.length !== 2 || !['%s', '%s\\n'].includes(values[0])) {
                return false;
              }
              return (
                typeof values[1] === 'string' || rawValues[1] === '"$PREV"'
              );
            }
            if (name === 'read') {
              return (
                rawValues.join(' ') ===
                  "-rsp 'REVIEW_OPENAI_API_KEY: ' REVIEW_OPENAI_API_KEY" ||
                rawValues.join(' ') === '-r REVIEW_OPENAI_API_KEY'
              );
            }
            if (name === 'rm') {
              if (rawValues[0] === '-f') {
                return (
                  rawValues.length >= 2 &&
                  rawValues
                    .slice(1)
                    .every((raw) =>
                      [
                        'prepare.log',
                        'review-threads.json',
                        'previous-report.md',
                        'proxy.json',
                        'proxy.err',
                        'proxy.pid',
                      ].some((suffix) => cachePath(raw, suffix)),
                    )
                );
              }
              return (
                (rawValues.length === 2 &&
                  rawValues[0] === '-rf' &&
                  cachePath(rawValues[1], 'qwen-base')) ||
                (rawValues.length === 3 &&
                  rawValues.slice(0, 2).join(' ') === '-rf --' &&
                  rawValues[2] === '"$rd/boundary.json"')
              );
            }
            if (name === 'sleep') {
              return values.length === 1 && values[0] === '0.1';
            }
            if (name === 'test') {
              return (
                rawValues.length === 2 &&
                rawValues[0] === '-n' &&
                rawValues[1] === '"$QWEN_VERIFY_PROXY_TOKEN"'
              );
            }
            return false;
          };
          walk(tree.rootNode, (node) => {
            visited += 1;
            if (!valid) return;
            if (visited > 20_000 || !allowedNodes.has(node.type)) {
              valid = false;
              return;
            }
            if (node.type === 'variable_assignment') {
              valid = validVariableAssignment(node);
              return;
            }
            if (node.type === 'declaration_command') {
              const raw = source.slice(node.startIndex, node.endIndex);
              const assignments = node.namedChildren.filter(
                (child) => child.type === 'variable_assignment',
              );
              valid =
                raw === 'export REVIEW_OPENAI_API_KEY' ||
                (assignments.length === 1 &&
                  validVariableAssignment(assignments[0]));
              return;
            }
            if (node.type === 'for_statement') {
              const variable = node.namedChildren.find(
                (child) => child.type === 'variable_name',
              );
              valid =
                variable?.text === '_' &&
                source
                  .slice(node.startIndex, node.endIndex)
                  .startsWith('for _ in {1..100}; do');
              return;
            }
            if (node.type === 'unset_command') {
              valid = /^unset(?: [A-Za-z_][A-Za-z0-9_]*)+$/.test(
                source.slice(node.startIndex, node.endIndex),
              );
              return;
            }
            if (node.type === 'file_redirect') {
              const raw = foldContinuations(
                source.slice(node.startIndex, node.endIndex),
              );
              valid =
                /^(?:\d*>(?![>&])|<(?!<)|>&\d|\d*>&\d)/.test(raw) &&
                validFileRedirect(node);
              return;
            }
            if (node.type !== 'command') return;
            const { name, args, values, rawValues } = commandParts(node);
            if (!name) {
              valid = false;
              return;
            }
            if (name === 'corepack') {
              valid = values.join(' ') === 'pnpm install --frozen-lockfile';
              return;
            }
            if (name === 'npm') {
              valid =
                (values.length === 2 &&
                  values[0] === 'run' &&
                  ['build', 'bundle'].includes(values[1])) ||
                (values.length === 5 &&
                  values.slice(0, 3).join(' ') === 'install -g --prefix' &&
                  rawValues[3] === '"$HOME/.local"' &&
                  ['@qwen-code/qwen-code', '/work'].includes(values[4]));
              return;
            }
            if (name === 'gh') {
              valid =
                values.join(' ') === 'api user --jq .login' ||
                (values.length === 4 &&
                  values[0] === 'api' &&
                  typeof values[1] === 'string' &&
                  values.slice(2).join(' ') === '--paginate --slurp');
              return;
            }
            if (name === 'git') {
              valid =
                rawValues.length === 6 &&
                rawValues[0] === '-C' &&
                rawValues[1] === '<pr-clone>' &&
                rawValues[2] === 'archive' &&
                rawValues[3] === '"$BASE_OID"' &&
                rawValues[4] === '--' &&
                rawValues[5] === '.qwen';
              return;
            }
            if (name === 'sed') {
              valid =
                rawValues.length === 3 &&
                rawValues[0] === '-n' &&
                rawValues[1] === "'s/^  context-sha256  //p'" &&
                cachePath(rawValues[2], 'prepare.log');
              return;
            }
            if (name === 'tar') {
              valid =
                rawValues.length === 3 &&
                rawValues[0] === '-x' &&
                rawValues[1] === '-C' &&
                cachePath(rawValues[2], 'qwen-base');
              return;
            }
            if (
              [
                'break',
                'cat',
                'cd',
                'chmod',
                'cp',
                'dirname',
                'echo',
                'exit',
                'grep',
                'id',
                'kill',
                'mkdir',
                'printf',
                'read',
                'rm',
                'sleep',
                'test',
                'true',
              ].includes(name)
            ) {
              valid = validDataCommand(name, node, values, rawValues);
              return;
            }
            if (name === 'command') {
              valid =
                values.length === 2 &&
                values[0] === '-v' &&
                ['zstd', 'qwen', 'java'].includes(values[1]);
              return;
            }
            if (name === 'set') {
              valid = values.length === 1 && values[0] === '-e';
              return;
            }
            if (name === 'qwen') {
              const flags = values.filter((_, index) => index % 2 === 0);
              valid =
                credentialFreeDockerExec &&
                values.length === 6 &&
                flags.join(' ') === '--auth-type --approval-mode --prompt' &&
                values[1] === 'openai' &&
                values[3] === 'yolo' &&
                typeof values[5] === 'string';
              return;
            }
            if (['bash', 'sh', '/bin/bash', '/bin/sh'].includes(name)) {
              if (
                values.length !== 2 ||
                !['-c', '-lc'].includes(values[0]) ||
                typeof values[1] !== 'string'
              ) {
                valid = false;
              } else {
                nested.push({
                  source: values[1],
                  trustedDockerExec,
                  credentialFreeDockerExec,
                });
              }
              return;
            }
            if (name === 'docker') {
              const subcommand = values[0];
              if (subcommand === 'rm') {
                valid =
                  values.length === 3 &&
                  values[1] === '-f' &&
                  values[2] === 'qwen-verify-<n>';
                return;
              }
              if (subcommand === 'run') {
                const expected = [
                  'run',
                  '-d',
                  '--rm',
                  '--name',
                  'qwen-verify-<n>',
                  '--user',
                  '"$(id -u):$(id -g)"',
                  '-e',
                  'HOME=/tmp/qwen-home',
                  '-v',
                  '<pr-clone>:/work',
                  '-v',
                  '<trusted-clone>/scripts:/trusted-scripts:ro',
                  '-v',
                  `${cacheRoot}/qwen-base/.qwen:/work/.qwen:ro`,
                  '-v',
                  `${cacheRoot}:/verify-context:ro`,
                  '-e',
                  'QWEN_VERIFY_CONTEXT=/verify-context/pr.json',
                  '-e',
                  'QWEN_VERIFY_PROXY_TOKEN',
                  '-w',
                  '/work',
                  'node:22-bookworm',
                  'sleep',
                  'infinity',
                ];
                valid =
                  rawValues.length === expected.length &&
                  expected.every((value, index) => rawValues[index] === value);
                return;
              }
              if (subcommand !== 'exec') {
                valid = false;
                return;
              }
              let index = 1;
              if (values[index] !== '-i') {
                valid = false;
                return;
              }
              index += 1;
              let credentialFree = false;
              if (values[index] === '-e') {
                if (values[index + 1] !== 'QWEN_VERIFY_CREDENTIAL_FREE=1') {
                  valid = false;
                  return;
                }
                credentialFree = true;
                index += 2;
              }
              if (values[index] !== 'qwen-verify-<n>') {
                valid = false;
                return;
              }
              const tail = values.slice(index + 1);
              if (
                tail.length !== 3 ||
                tail[0] !== 'bash' ||
                tail[1] !== '-lc' ||
                typeof tail[2] !== 'string'
              ) {
                valid = false;
              } else {
                nested.push({
                  source: tail[2],
                  trustedDockerExec: true,
                  credentialFreeDockerExec: credentialFree,
                });
              }
              return;
            }
            if (!trustedInterpreters.has(name)) {
              valid = false;
              return;
            }
            const modulePath = values[0] ?? null;
            if (modulePath === '-e' || modulePath === '--eval') {
              const expected = trustedNodeEvaluations.get(values[1]);
              valid =
                !!expected &&
                expected.length === rawValues.length - 2 &&
                expected.every(
                  (value, index) => rawValues[index + 2] === value,
                );
              return;
            }
            if (['-v', '--version', '--check'].includes(modulePath)) {
              valid = values.length === 1;
              return;
            }
            if (modulePath === 'scripts/lint.js') {
              valid =
                values.length === 2 &&
                [
                  '--setup',
                  '--actionlint',
                  '--yamllint',
                  '--eslint',
                  '--prettier',
                ].includes(values[1]);
              return;
            }
            if (modulePath === 'scripts/verify-capture.mjs') {
              valid = validCaptureArguments(values);
              return;
            }
            if (modulePath === 'my-harness.mjs') {
              valid = values.length === 1;
              return;
            }
            const family = modulePath?.match(
              /\/verify-pr-([a-z-]+)\.mjs$/,
            )?.[1];
            if (
              !family ||
              !modulePath.endsWith(`verify-pr-${family}.mjs`) ||
              !trustedPath(modulePath)
            ) {
              valid = false;
              return;
            }
            let statement = node;
            while (
              statement.parent &&
              [
                'list',
                'redirected_statement',
                'pipeline',
                'negated_command',
              ].includes(statement.parent.type)
            ) {
              statement = statement.parent;
            }
            const lineEnd = source.indexOf('\n', statement.endIndex);
            const trailing = source
              .slice(statement.endIndex, lineEnd < 0 ? source.length : lineEnd)
              .trim();
            const background = family === 'model-proxy' && trailing === '&';
            if (!background && !/^[;)\]}]*$/.test(trailing)) {
              valid = false;
              return;
            }
            const argumentEnd = background
              ? source.indexOf('&', statement.endIndex) + 1
              : statement.endIndex;
            const rawArguments = foldContinuations(
              source.slice(args[0].endIndex, argumentEnd),
            );
            const approvedArguments = validHelperArguments(
              family,
              rawArguments,
              quotedGate,
            );
            if (!approvedArguments) {
              valid = false;
              return;
            }
            calls.push({
              family,
              action: family === 'watch-state' ? approvedArguments : null,
            });
          });
          if (!valid) return false;
          for (const program of nested) {
            if (
              !(await inspect({ ...program, quotedGate: false }, depth + 1))
            ) {
              return false;
            }
          }
          return true;
        } finally {
          tree.delete();
        }
      };
      for (const fragment of fragments) {
        const key = `${fragment.quotedGate}\0${fragment.source}`;
        const cached = shellFragmentResults.get(key);
        if (cached) {
          calls.push(...cached.calls);
          if (!cached.valid) return false;
          continue;
        }
        const callStart = calls.length;
        const fragmentValid = await inspect(fragment);
        const fragmentCalls = calls.slice(callStart);
        shellFragmentResults.set(key, {
          valid: fragmentValid,
          calls: fragmentCalls,
        });
        if (!fragmentValid) return false;
      }
      const families = calls.map((call) => call.family);
      const actions = calls.map((call) => call.action);
      return (
        calls.length === 24 &&
        families.filter((family) => family === 'prepare').length === 4 &&
        families.filter((family) => family === 'check').length === 3 &&
        families.filter((family) => family === 'watch-state').length === 12 &&
        families.filter((family) => family === 'watch-gate').length === 3 &&
        families.filter((family) => family === 'model-proxy').length === 1 &&
        families.filter((family) => family === 'credential-scan').length ===
          1 &&
        actions.filter((action) => action === 'start').length === 5 &&
        actions.filter((action) => action === 'complete').length === 2 &&
        actions.filter((action) => action === 'release').length === 5
      );
    };
    expect(await onlyDocumentedPrepareCalls(skill)).toBe(true);
    for (const valid of [
      '<n> --repo <owner>/<repo> --execution host --trust-pr-head --round 2 --reason why --context-out /tmp/pr.json',
      '<n> --repo <owner>/<repo> --execution vm --trust-pr-head --round 2 --reason why --context-out /tmp/pr.json --attestation no-host-mounts',
      '<n> --repo <owner>/<repo> --execution host --approval https://github.com/QwenLM/qwen-code/pull/42#issuecomment-900001 --state-root /trusted --round 2 --reason why --context-out /tmp/pr.json',
      '<n> --repo <owner>/<repo> --execution host --approval <url> --state-root /trusted --round 2 --reason why --context-out /tmp/pr.json',
    ]) {
      expect(
        await onlyDocumentedPrepareCalls(skill.replace(basic.trim(), valid)),
      ).toBe(true);
    }
    for (const hostile of [
      '<n> --repo <owner>/<repo> --execution host --trust-pr-head --round 2 --reason why --context-out /tmp/pr.json # --execution container',
      '<n> --repo <owner>/<repo> --execution host --round 2 --reason why --context-out /tmp/pr.json',
      '<n> --repo <owner>/<repo> --execution remote --trust-pr-head --round 2 --reason why --context-out /tmp/pr.json',
      '<n> --repo QwenLM --execution host --trust-pr-head --round 2 --reason why --context-out /tmp/pr.json',
      '<n> --repo <owner>/<repo> --execution host --approval not-a-url --state-root /trusted --round 2 --reason why --context-out /tmp/pr.json',
      '<n> --repo <owner>/<repo> --execution host --trust-pr-head --approval https://github.com/QwenLM/qwen-code/pull/42#issuecomment-900001 --state-root /trusted --round 2 --reason why --context-out /tmp/pr.json',
      '<n> --repo <owner>/<repo> --execution host --trust-pr-head --round 2 --reason why --context-out /tmp/pr.json --unknown value',
      '<n> --repo <owner>/<repo> --execution container --trust-pr-head',
      `${basic.trim()} # --execution container`,
      `${logged.trim()} ; echo unexpected`,
      `${basic.trim()} > /tmp/hijack`,
      `${basic.trim()} \`touch /tmp/should-not-write\``,
      '<n> --repo <owner>/<repo> --execution=host --trust-pr-head --round 2 --reason why --context-out /tmp/pr.json',
    ]) {
      expect(
        await onlyDocumentedPrepareCalls(skill.replace(basic.trim(), hostile)),
        hostile,
      ).toBe(false);
    }
    const injected =
      '<n> --repo <owner>/<repo> --execution host --trust-pr-head --round 2 --reason $(touch${IFS}/tmp/should-not-write;printf${IFS}why) --context-out /tmp/pr.json';
    const backtickInjected = injected.replace(
      '$(touch${IFS}/tmp/should-not-write;printf${IFS}why)',
      '`touch /tmp/should-not-write;printf why`',
    );
    for (const hostile of [injected, backtickInjected]) {
      expect(
        await onlyDocumentedPrepareCalls(skill.replace(basic.trim(), hostile)),
      ).toBe(false);
    }
    expect(
      await onlyDocumentedPrepareCalls(
        skill.replace(
          basic.trim(),
          '<n> --repo <owner>/<repo> --execution host --trust-pr-head --round 0 --reason why --context-out /tmp/pr.json',
        ),
      ),
    ).toBe(false);
    expect(
      await onlyDocumentedPrepareCalls(skill.replace('--repo ', '--repo=')),
    ).toBe(true);
    const invocation = `node ${script}`;
    const unsafeHost =
      '<n> --repo <owner>/<repo> --execution host --trust-pr-head --round 2 --reason why --context-out /tmp/pr.json # --execution container';
    for (const [replacement, tail, valid] of [
      [script, basic.trim(), false],
      [`sh ${script}`, basic.trim(), false],
      ['node /tmp/untrusted/verify-pr-prepare.mjs', basic.trim(), false],
      ['node /trusted-scripts/verify-pr-prepare.mjs', unsafeHost, false],
      [
        'node /trusted-scripts/verify-pr-prepare.mjs',
        '<n> --repo <owner>/<repo> --execution host --trust-pr-head --round 2 --reason why --context-out /tmp/pr.json',
        true,
      ],
    ]) {
      const changed = skill.replace(invocation, replacement);
      expect(
        await onlyDocumentedPrepareCalls(changed.replace(basic.trim(), tail)),
      ).toBe(valid);
    }
    for (const hostileValue of ['<(/tmp/evil)', '/tmp/x>/tmp/hijacked']) {
      expect(
        await onlyDocumentedPrepareCalls(
          skill.replace(
            '--context-out ~/.cache/qwen-verify/pr<n>/pr.json',
            `--context-out ${hostileValue}`,
          ),
        ),
        hostileValue,
      ).toBe(false);
    }
    expect(
      await onlyDocumentedPrepareCalls(
        `${skill}\nsudo -n true; node /tmp/payload/verify-pr-prepare.mjs ${basic.trim()}`,
      ),
    ).toBe(false);
    expect(
      await onlyDocumentedPrepareCalls(
        skill.replace(
          invocation,
          `${script.slice(0, script.lastIndexOf('/') + 1)}../verify-pr-prepare.mjs`,
        ),
      ),
    ).toBe(false);
    expect(
      await onlyDocumentedPrepareCalls(
        skill.replace(logged, `${logged} > /tmp/after`),
      ),
    ).toBe(false);
    const helperCalls = [
      ['prepare', invocation],
      [
        'check',
        'node <trusted-clone>/scripts/verify-pr-check.mjs --context <host snapshot> --context-sha256 "$(cat ~/.cache/qwen-verify/pr<n>/pr.sha256)" <artifact dir>',
      ],
      [
        'watch-state start',
        'node <clone>/scripts/verify-pr-watch-state.mjs <n> --start --head <H> --round <r> --repo <owner>/<repo>',
      ],
      [
        'watch-state complete',
        'node <clone>/scripts/verify-pr-watch-state.mjs <n> --complete --head <H> --round <r> --registration-nonce <nonce> --verdict <word> [--artifact-dir <dir>] [--comment-id <id>] --repo <owner>/<repo>',
      ],
      [
        'watch-state release',
        'node <clone>/scripts/verify-pr-watch-state.mjs <n> --release --head <headSha> [--round <r>] --registration-nonce <nonce> --repo <owner>/<repo>',
      ],
      [
        'watch-gate probe',
        'node <clone>/scripts/verify-pr-watch-gate.mjs <n> --check --claim',
      ],
      [
        'watch-gate CLI',
        'node <clone>/scripts/verify-pr-watch-gate.mjs <n> --repo <owner>/<repo> --cli <absolute qwen>',
      ],
      [
        'watch-gate release',
        'node <clone>/scripts/verify-pr-watch-gate.mjs <n> --release',
      ],
      [
        'credential-scan',
        'node /trusted-scripts/verify-pr-credential-scan.mjs /work || exit 1',
      ],
    ];
    for (const [family, call] of helperCalls) {
      expect(skill, family).toContain(call);
      expect(
        await onlyDocumentedPrepareCalls(
          skill.replace(call, `${call} ; touch /tmp/should-not-write`),
        ),
        family,
      ).toBe(false);
    }
    for (const verdict of [
      'merge-ready',
      'findings',
      'blocked',
      'inconclusive',
    ]) {
      expect(
        await onlyDocumentedPrepareCalls(
          skill.replace('--verdict <word>', `--verdict ${verdict}`),
        ),
        verdict,
      ).toBe(true);
    }
    expect(
      await onlyDocumentedPrepareCalls(
        skill.replace('--verdict <word>', '--verdict nonsense'),
      ),
    ).toBe(false);
    const prepareFailureRelease =
      'node <clone>/scripts/verify-pr-watch-state.mjs <n> --release --head <headSha> [--round <r>] --registration-nonce <nonce> --repo <owner>/<repo>';
    const repeatedStart =
      'node <clone>/scripts/verify-pr-watch-state.mjs <n> --start --head <headSha> --round <r> --repo <owner>/<repo>';
    expect(skill).toContain(prepareFailureRelease);
    expect(skill).toContain(repeatedStart);
    expect(
      await onlyDocumentedPrepareCalls(
        skill.replace(prepareFailureRelease, repeatedStart),
      ),
      'a release-to-start substitution must fail the pinned action census',
    ).toBe(false);
    expect(
      await onlyDocumentedPrepareCalls(
        skill.replace(
          '--context-out ~/.cache/qwen-verify/pr<n>/pr.json',
          '--context-out "$(cat ~/.cache/qwen-verify/pr<n>/pr.sha256)"',
        ),
      ),
    ).toBe(false);
    const proxyLogging =
      '> ~/.cache/qwen-verify/pr<n>/proxy.json 2> ~/.cache/qwen-verify/pr<n>/proxy.err &';
    expect(skill, 'model-proxy').toContain(proxyLogging);
    expect(
      await onlyDocumentedPrepareCalls(
        skill.replace(
          proxyLogging,
          `${proxyLogging} ; touch /tmp/should-not-write`,
        ),
      ),
      'model-proxy',
    ).toBe(false);
    expect(
      await onlyDocumentedPrepareCalls(
        skill.replace(
          '"$(cat ~/.cache/qwen-verify/pr<n>/pr.sha256)"',
          '"$(cat /tmp/evil)"',
        ),
      ),
    ).toBe(false);
    expect(
      await onlyDocumentedPrepareCalls(
        `${skill}\nnode <trusted-clone>/scripts/verify-pr-unknown.mjs <n> --start`,
      ),
    ).toBe(false);
    expect(
      await onlyDocumentedPrepareCalls(skill.replace('gate: "node ', 'node ')),
    ).toBe(false);
    expect(
      await onlyDocumentedPrepareCalls(
        skill.replace('--cli <absolute qwen>"', '--cli <absolute qwen>'),
      ),
    ).toBe(false);
    expect(
      await onlyDocumentedPrepareCalls(
        `${skill}\n\`verify-pr-watch-state.mjs\`; touch /tmp/should-not-write`,
      ),
    ).toBe(false);
    const dynamicImport =
      'node -e \'import(`/trusted-scripts/verify-pr-watch-state.mjs`).then(function(m){m.startRound("/tmp/fake",{pr:1,head:"bbbbbbb",round:1})})\'';
    for (const [label, hostile] of [
      ['dynamic import', dynamicImport],
      [
        'command before dynamic import',
        `touch /tmp/should-not-write; ${dynamicImport}`,
      ],
      [
        'multiline dynamic import',
        dynamicImport.replace('import(', 'import(\n'),
      ],
      [
        'line-comment dynamic import',
        dynamicImport.replace('import(', 'import(// continues\n'),
      ],
      ...['&&', '||', '|', '&', '|&', ';'].map((operator) => [
        `shell continuation ${operator}`,
        `touch /tmp/should-not-write ${operator}\n\`/trusted-scripts/verify-pr-watch-state.mjs\``,
      ]),
      ...['&&', '||', '|', '&', '|&', ';'].map((operator) => [
        `commented shell continuation ${operator}`,
        `touch /tmp/should-not-write ${operator} # continues\n\`/trusted-scripts/verify-pr-watch-state.mjs\``,
      ]),
      ...['&&', '||', '|', '&', '|&', ';'].map((operator) => [
        `double-commented shell continuation ${operator}`,
        `touch /tmp/should-not-write ${operator} # continues\n# still a comment\n\`/trusted-scripts/verify-pr-watch-state.mjs\``,
      ]),
      [
        'multiline quoted dynamic import',
        dynamicImport
          .replace('import(', 'import(\n')
          .replaceAll('`', '"')
          .replace(').then', '\n).then'),
      ],
    ]) {
      expect(
        await onlyDocumentedPrepareCalls(`${skill}\n${hostile}`),
        label,
      ).toBe(false);
    }
    const structuralHostiles = [
      [
        'concatenated dynamic import',
        "node -e 'import(`/trusted-scripts/verify-pr-watch`+`-state.mjs`).then(()=>{})'",
      ],
      [
        'fully split dynamic import',
        "node -e 'import(`/trusted-scripts/`+`verify`+`-pr-watch-state.mjs`).then(()=>{})'",
      ],
      [
        'multiline command substitution',
        'printf "%s" `printf "" &&\n/trusted-scripts/verify-pr-watch-state.mjs`',
      ],
      [
        'bare helper after cd',
        'cd <pr-clone> && verify-pr-watch-gate.mjs <n> --check --claim',
      ],
      [
        'cwd-relative helper after cd',
        'cd <pr-clone> && scripts/verify-pr-watch-gate.mjs <n> --check --claim',
      ],
      [
        'node function form shadow',
        'node() { :; }; node /trusted-scripts/verify-pr-watch-gate.mjs <n> --check --claim',
      ],
      [
        'node function keyword shadow',
        'function node { :; }; node /trusted-scripts/verify-pr-watch-gate.mjs <n> --check --claim',
      ],
      [
        'node alias shadow',
        "alias node='node --require=<pr-clone>/payload.cjs'; node /trusted-scripts/verify-pr-watch-gate.mjs <n> --check --claim",
      ],
      [
        'inherited node options',
        'NODE_OPTIONS=--require=<pr-clone>/payload.cjs node /trusted-scripts/verify-pr-watch-gate.mjs <n> --check --claim',
      ],
      [
        'escaped helper filename',
        String.raw`node /trusted-scripts/verify-pr\-watch-gate.mjs <n> --check --claim`,
      ],
      [
        'glob helper filename',
        'node /trusted-scripts/verify-pr-*.mjs <n> --check --claim',
      ],
      [
        'invalid parse with complete census',
        'node /trusted-scripts/verify-pr-watch-gate.mjs <n> --check --claim "unterminated',
      ],
    ];
    for (const [label, hostile] of structuralHostiles) {
      expect(
        await onlyDocumentedPrepareCalls(`${skill}\n${hostile}`),
        label,
      ).toBe(false);
    }
    const interpreterHostiles = [
      "node -e 'console.log(1)'",
      'node --eval \'require("node:fs")\'',
      'node -e \'import("/tmp/payload.mjs")\'',
      'node /tmp/arbitrary.js',
      'node --require=/tmp/setup.cjs /trusted-scripts/verify-pr-watch-gate.mjs <n> --check --claim',
      "/usr/bin/node -e 'console.log(1)'",
      '"/usr/bin/node" -e \'console.log(1)\'',
      "env node -e 'console.log(1)'",
      'sudo node /tmp/arbitrary.js',
      '/tmp/node /trusted-scripts/verify-pr-watch-gate.mjs <n> --check --claim',
    ];
    for (const hostile of interpreterHostiles) {
      for (const document of [
        `${skill}\n${hostile}`,
        `${skill}\n\`\`\`bash\n${hostile}\n\`\`\``,
      ]) {
        expect(await onlyDocumentedPrepareCalls(document), hostile).toBe(false);
      }
    }
    const opaqueInterpreterHostiles = [
      '\'no\'de -e "0 * 0"',
      String.raw`nod\e -e "0 * 0"`,
      'N=node; $N -e "0 * 0"',
      'M=/tmp/example.mjs; node "$M"',
    ];
    for (const hostile of opaqueInterpreterHostiles) {
      for (const [shape, document] of [
        ['raw', `${skill}\n${hostile}`],
        ['fenced', `${skill}\n\`\`\`bash\n${hostile}\n\`\`\``],
      ]) {
        expect(
          await onlyDocumentedPrepareCalls(document),
          `${shape} ${hostile}`,
        ).toBe(false);
      }
    }
    const wrappedInterpreterHostiles = [
      'env "$N" -e "0 * 0"',
      'env /usr/bin/node -e "0 * 0"',
      'env \'no\'de -e "0 * 0"',
      String.raw`env nod\e -e "0 * 0"`,
      'sudo "$N" -e "0 * 0"',
      'bash -c \'N=node; $N -e "0 * 0"\'',
      'bash -lc \'N=node; $N -e "0 * 0"\'',
      String.raw`bash -c 'nod\e -e "0 * 0"'`,
      'bash -lc "\'no\'de -e \\"0 * 0\\""',
      'env bash -c \'N=node; $N -e "0 * 0"\'',
      'docker -c \'node -e "0 * 0"\'',
    ];
    for (const hostile of wrappedInterpreterHostiles) {
      for (const [shape, document] of [
        ['raw', `${skill}\n${hostile}`],
        ['fenced', `${skill}\n\`\`\`bash\n${hostile}\n\`\`\``],
      ]) {
        expect(
          await onlyDocumentedPrepareCalls(document),
          `${shape} ${hostile}`,
        ).toBe(false);
      }
    }
    for (const hostile of [
      'nod\\\ne -e "0 * 0"',
      'env nod\\\ne -e "0 * 0"',
      'env no\\\nde -e "0 * 0"',
      '\\\nnode -e "0 * 0"',
    ]) {
      for (const [shape, document] of [
        ['raw', `${skill}\n${hostile}`],
        ['fenced', `${skill}\n\`\`\`bash\n${hostile}\n\`\`\``],
      ]) {
        expect(
          await onlyDocumentedPrepareCalls(document),
          `${shape} continued name ${hostile}`,
        ).toBe(false);
      }
    }
    const continuedEval = 'node \\\n -e "0 * 0"';
    for (const [interpreter, command] of [
      ['node', continuedEval],
      ['env node', `env ${continuedEval}`],
      ['/usr/bin/node', continuedEval.replace(/^node/, '/usr/bin/node')],
    ]) {
      for (const [newlineName, newline] of [
        ['LF', '\n'],
        ['CRLF', '\r\n'],
      ]) {
        const sample = command.replace('\n', newline);
        for (const [shape, document] of [
          ['raw', `${skill}\n${sample}`],
          ['fenced', `${skill}\n\`\`\`bash\n${sample}\n\`\`\``],
        ]) {
          expect(
            await onlyDocumentedPrepareCalls(document),
            `${interpreter} ${shape} ${newlineName}`,
          ).toBe(false);
        }
      }
    }
    for (const [newlineName, newline] of [
      ['LF', '\n'],
      ['CRLF', '\r\n'],
    ]) {
      const deeplyContinued = 'node \\\n -e \\\n "0 * 0"'.replaceAll(
        '\n',
        newline,
      );
      for (const [shape, document] of [
        ['raw', `${skill}\n${deeplyContinued}`],
        ['fenced', `${skill}\n\`\`\`bash\n${deeplyContinued}\n\`\`\``],
      ]) {
        expect(
          await onlyDocumentedPrepareCalls(document),
          `three-line eval ${shape} ${newlineName}`,
        ).toBe(false);
      }
    }
    for (const continuation of [
      'node /trusted-scripts/verify-pr-credential-scan.mjs \\\n /work || exit 1',
      'node /trusted-scripts/verify-pr-credential-scan.mjs \\\n /work \\\n || exit 1',
    ]) {
      expect(
        await onlyDocumentedPrepareCalls(
          skill.replace(
            'node /trusted-scripts/verify-pr-credential-scan.mjs /work || exit 1',
            continuation,
          ),
        ),
        'a continued legitimate call preserves the invocation census',
      ).toBe(true);
    }
    for (const prose of [
      'The prose word node does not execute anything; arbitrary-helper.js is only a filename.',
      'node is the runtime cited by this sentence, not an invocation.',
      'For details see verify-pr-check.mjs \\\nwhen discussing reports.',
    ]) {
      expect(
        await onlyDocumentedPrepareCalls(`${skill}\n${prose}`),
        prose,
      ).toBe(true);
    }
    for (const document of [
      `${skill}\ngrep -e needle ./notes.txt`,
      `${skill}\ngrep -e 'node -e "0 * 0"' ./notes.txt`,
      `${skill}\necho 'node -e "0 * 0"'`,
      `${skill}\nbash -lc 'grep -e needle ./notes.txt'`,
      `${skill}\n\`\`\`bash\ngrep -e needle ./notes.txt\ngrep -e 'node -e "0 * 0"' ./notes.txt\necho 'node -e "0 * 0"'\ncat ./notes.txt\n\`\`\``,
    ]) {
      expect(
        await onlyDocumentedPrepareCalls(document),
        'ordinary eval-flag and scoped data arguments are not Node entry points',
      ).toBe(true);
    }
    expect(
      await onlyDocumentedPrepareCalls(
        `${skill}\n\`\`\`text\nA sentence containing node is not a command.\n\`\`\``,
      ),
    ).toBe(true);
    const heredoc = [
      "cat <<'TEXT'",
      'node /trusted-scripts/verify-pr-watch-state.mjs <n> --release',
      'TEXT',
    ].join('\n');
    expect(
      await onlyDocumentedPrepareCalls(
        `${skill}\n\`\`\`bash\n${heredoc}\n\`\`\``,
      ),
      'here-doc body is not executable',
    ).toBe(true);
    const continuedHeredoc = ["cat <<'TEXT'", continuedEval, 'TEXT'].join('\n');
    expect(
      await onlyDocumentedPrepareCalls(
        `${skill}\n\`\`\`bash\n${continuedHeredoc}\n\`\`\``,
      ),
      'continued text in a here-doc remains data',
    ).toBe(true);
    const genuineGate =
      'node <clone>/scripts/verify-pr-watch-gate.mjs <n> --release';
    expect(
      await onlyDocumentedPrepareCalls(skill.replace(genuineGate, heredoc)),
      'a here-doc citation cannot replace a genuine invocation',
    ).toBe(false);
    expect(
      await onlyDocumentedPrepareCalls(`${skill}\nverify-pr-check.mjs`),
    ).toBe(true);
    expect(
      await onlyDocumentedPrepareCalls(`${skill}\n\`verify-pr-check.mjs\`.`),
    ).toBe(true);
    for (const interpreter of ['/bin/sh', '"/bin/sh"', "'/bin/sh'"]) {
      expect(
        await onlyDocumentedPrepareCalls(
          `${skill}\n${interpreter} <clone>/scripts/verify-pr-watch-gate.mjs <n> --check --claim`,
        ),
        interpreter,
      ).toBe(false);
    }
    const expectInRawAndBash = async (samples, expected, label) => {
      for (const sample of samples) {
        for (const [shape, document] of [
          ['raw', `${skill}\n${sample}`],
          ['fenced', `${skill}\n\`\`\`bash\n${sample}\n\`\`\``],
        ]) {
          expect(
            await onlyDocumentedPrepareCalls(document),
            `${label}: ${shape}: ${sample}`,
          ).toBe(expected);
        }
      }
    };
    await expectInRawAndBash(
      [
        'cp /tmp/replacement.js /trusted-scripts/verify-pr-prepare.mjs',
        'chmod 777 ~/.cache/qwen-verify/pr<n>/proxy.json',
        'rm -f ~/.cache/qwen-verify/pr<n>/pr.json',
        'rm -rf /tmp/host-snapshot',
        "printf '%s\\n' forged > ~/.cache/qwen-verify/pr<n>/pr.json",
        'echo forged > ~/.cache/qwen-verify/pr<n>/pr.json',
        'echo forged > "$HOME/.qwen/settings.json"',
        'printf \'%s\\n\' forged > "$rd/boundary.json"',
        'cat /tmp/notes.txt',
        'cat > "$HOME/.qwen/settings.json"',
        'mkdir -p "$HOME/.qwen"',
        'cd /tmp && true',
        'docker cp',
        'cp <pr-clone>/tmp/verify-context/pr<n>-review-threads.json /tmp/review-threads.json',
        "sed -n 's/^  context-sha256  //p' ~/.cache/qwen-verify/pr<n>/prepare.log > /tmp/pr.sha256",
        'kill 1',
      ],
      false,
      'data command arguments and destinations are closed',
    );
    await expectInRawAndBash(
      [
        'PATH=/tmp node --version',
        "BASH_ENV=/tmp/untrusted.sh bash -lc 'echo ok'",
        'export LD_PRELOAD',
        "bash -lc 'export LD_PRELOAD=/tmp/payload.so'",
        'read PATH',
        'for PATH in /tmp; do node --version; done',
        'LD_LIBRARY_PATH=/tmp node --version',
        'export PATH="$HOME/.local/bin:$PATH"',
        'export QWEN_VERIFY_CREDENTIAL_FREE=1',
      ],
      false,
      'environment assignment name value and scope are closed',
    );
    expect(
      await onlyDocumentedPrepareCalls(
        `${skill}\n\`BASH_ENV=/tmp/untrusted.sh\``,
      ),
      'an inline configuration assignment is not waved through as prose',
    ).toBe(false);
    await expectInRawAndBash(
      [
        'unset LD_PRELOAD',
        'unset NODE_OPTIONS BASH_ENV PATH',
        "bash -lc 'unset LD_PRELOAD BASH_ENV'",
        "printf '%s\\n' 'node -e looks like data'",
      ],
      true,
      'data and safe environment setup remain valid',
    );
    expect(
      await onlyDocumentedPrepareCalls(
        `${skill}\nFor details see \`cp -a\` and \`docker cp\`; neither citation dereferences links.`,
      ),
      'Java non-dereferencing copy citations remain raw prose',
    ).toBe(true);
    await expectInRawAndBash(
      [
        "python3 - <<'PY'\nprint('not data')\nPY",
        "true; python3 - <<'PY'\nprint('not data')\nPY",
      ],
      false,
      'here-doc Python is not a data channel',
    );
    await expectInRawAndBash(
      [
        '/usr/bin/env node -e "0 * 0"',
        '/usr/bin/env \\\n node -e "0 * 0"',
        'nice node -e "0 * 0"',
        'true; node -e "0 * 0"',
        'true \\\n; node -e "0 * 0"',
        'echo data; /usr/bin/env node -e "0 * 0"',
        '$(printf node) -e "0 * 0"',
        'true; $(printf node) -e "0 * 0"',
        'no$(printf \'\')de -e "0 * 0"',
        '`true`; node -e "0 * 0"',
        '`node`; node -e "0 * 0"',
      ],
      false,
      'wrapper substitution and complete-chain admission',
    );
    expect(
      await onlyDocumentedPrepareCalls(
        `${skill}\n\`\`\`Bash\n/usr/bin/env node -e "0 * 0"\n\`\`\``,
      ),
      'Bash fence tags are case-insensitive',
    ).toBe(false);
    expect(
      await onlyDocumentedPrepareCalls(
        `${skill}\n\`\`\`Bash\ngrep -e needle ./notes.txt\n\`\`\``,
      ),
      'mixed-case Bash fence preserves supported data commands',
    ).toBe(true);
    const documentedDockerRun = skill.match(
      /docker run -d[\s\S]*?sleep infinity/,
    )?.[0];
    expect(documentedDockerRun).toBeTruthy();
    await expectInRawAndBash(
      [
        'docker run --user root -v /:/host -w /host --network host node:22-bookworm sleep infinity',
        documentedDockerRun.replace(
          '--user "$(id -u):$(id -g)"',
          '--user root',
        ),
        documentedDockerRun.replace('-d --rm', '-d --rm --privileged'),
        documentedDockerRun.replace('-d --rm', '-d --rm --network host'),
        documentedDockerRun.replace('<pr-clone>:/work', '/:/host'),
        documentedDockerRun.replace(
          '<trusted-clone>/scripts:/trusted-scripts:ro',
          '/var/run/docker.sock:/var/run/docker.sock',
        ),
        documentedDockerRun.replace(
          '--user "$(id -u):$(id -g)"',
          '--user "$(id -u):$(id -g)" --user 0:0',
        ),
        documentedDockerRun.replace('-d --rm', '--rm -d'),
        documentedDockerRun.replace(
          '-e QWEN_VERIFY_PROXY_TOKEN',
          '-e OPENAI_API_KEY',
        ),
      ],
      false,
      'docker run binds every option user and mount',
    );
    await expectInRawAndBash(
      [
        'qwen --auth-type openai --approval-mode yolo --prompt "/verify-pr <n>"',
        'bash -lc \'qwen --auth-type openai --approval-mode yolo --prompt "/verify-pr <n>"\'',
        'docker exec -i qwen-verify-<n> bash -lc \'qwen --auth-type openai --approval-mode yolo --prompt "/verify-pr <n>"\'',
        'docker exec -i qwen-verify-<n> bash -lc \'node -e "0 * 0"\'',
        'docker exec -i -e QWEN_VERIFY_CREDENTIAL_FREE=1 qwen-verify-<n> bash -lc \'node -e "0 * 0"\'',
      ],
      false,
      'docker exec is recursive and yolo needs attested context',
    );
    expect(
      await onlyDocumentedPrepareCalls(
        skill.replace(
          '--prompt "/verify-pr <n> --repo <owner>/<repo>"',
          '--prompt "Do not execute node -e or true; this is prose"',
        ),
      ),
      'a hostile-looking prompt remains static data',
    ).toBe(true);
    await expectInRawAndBash(
      ['node scripts/lint.js', 'node scripts/lint.js --setup --setup'],
      false,
      'lint helper no-argument and duplicate forms',
    );
    await expectInRawAndBash(
      ['--setup', '--actionlint', '--yamllint', '--eslint', '--prettier'].map(
        (flag) => `node scripts/lint.js ${flag}`,
      ),
      true,
      'documented lint setup and non-mutating flags',
    );
    const capture =
      "node scripts/verify-capture.mjs --rows 20 --cols 100 --out tmp/pr<n>-verify-<ts>/evidence/01-ab.png --title 'A/B matrix' -- node my-harness.mjs";
    await expectInRawAndBash(
      [capture],
      true,
      'documented capture out rows cols title and command',
    );
    await expectInRawAndBash(
      [
        capture.replace('--rows 20', '--rows 0'),
        capture.replace('--rows 20', '--rows -1'),
        capture.replace('--rows 20', '--rows 501'),
        capture.replace('--rows 20', '--rows 1.5'),
        capture.replace('--rows 20', '--rows nope'),
        capture.replace('--rows 20 ', '--rows '),
        capture.replace('--cols 100', '--cols 0'),
        capture.replace('--cols 100', '--cols 501'),
        capture.replace(
          ' -- node my-harness.mjs',
          ' --rows 20 -- node my-harness.mjs',
        ),
        capture.replace(
          ' -- node my-harness.mjs',
          ' --out evidence/other.png -- node my-harness.mjs',
        ),
        capture.replace(' -- node my-harness.mjs', ' node my-harness.mjs'),
        capture.replace(
          'tmp/pr<n>-verify-<ts>/evidence/01-ab.png',
          '/tmp/ab.png',
        ),
        capture.replace(
          ' -- node my-harness.mjs',
          ' --unknown x -- node my-harness.mjs',
        ),
      ],
      false,
      'capture malformed duplicate and out-of-root arguments',
    );
    expect(skill).not.toMatch(
      /node <pr-clone>\/scripts\/verify-pr-(prepare|check|model-proxy|guard|watch-state|watch-gate|credential-scan)/,
    );
    expect(skill).not.toMatch(
      /node scripts\/verify-pr-(prepare|check|model-proxy|guard|watch-state|watch-gate|credential-scan)\.mjs/,
    );
  }, 30_000);

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
    // its continuation line — pin the executable call too. The trust root is
    // host-provided (--context-root) and the round-dir expansion is the
    // normalised $rd, quoted so a space-bearing path stays one argument.
    expect(skill).toContain('--context ~/.cache/qwen-verify/pr<n>/pr.json');
    expect(skill).toContain('--context-root "<pr-clone>" "$rd"');
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

  it('keeps both Java recipes on the waived mode their separate battery can produce', () => {
    const english = readFileSync(
      fileURLToPath(
        new URL(
          '../../docs/design/2026-11-14-verify-pr-java-container-recipe.md',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    const chinese = readFileSync(
      fileURLToPath(
        new URL(
          '../../docs/design/2026-11-14-verify-pr-java-container-recipe.zh-CN.md',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    expect(english.replace(/\s+/g, ' ')).toContain(
      "`boundary.json` retains prepare's `waived` executionApproval",
    );
    expect(english).not.toContain('`boundary.json` records container mode');
    for (const [document, titles] of [
      [
        english,
        [
          '1. **Image.**',
          '2. **Trusted scripts, PR clone, model proxy.**',
          '3. **Pre-seed execution approval.**',
          '4. **Offline Maven repository, seeded inside a boundary.**',
          '5. **Declaration.**',
        ],
      ],
      [
        chinese,
        [
          '1. **镜像。**',
          '2. **可信脚本、PR 克隆、模型代理。**',
          '3. **预置前执行批准。**',
          '4. **离线 Maven 仓库，在边界内预置。**',
          '5. **声明。**',
        ],
      ],
    ]) {
      let previous = -1;
      for (const title of titles) {
        const position = document.indexOf(title);
        expect(position, title).toBeGreaterThan(previous);
        previous = position;
      }
    }
    expect(english).toContain(
      'verify-pr-prepare.mjs <n> --repo <owner>/<repo> --execution host --round <r>',
    );
    expect(english).toContain('--approval <url> --state-root "<trusted-dir>"');
    expect(english).toContain(
      'keeps the same registration while changing modes',
    );
    expect(english.replace(/\s+/g, ' ')).toContain(
      'and does not ask the independent offline battery for a container nonce or gate record',
    );
    expect(chinese).toContain(
      '`boundary.json` 保留 prepare 生成、与宿主 context 一致的 `waived` executionApproval',
    );
    expect(chinese).not.toContain('`boundary.json` 记录 container 模式');
    expect(chinese).toContain(
      'verify-pr-prepare.mjs <n> --repo <owner>/<repo> --execution host --round <r>',
    );
    expect(chinese).toContain('在切换模式时保留同一注册');
    expect(chinese).toContain(
      '不要求独立离线电池提供 container nonce 或门禁记录',
    );
  });

  it('checks both documented waived boundary examples and separates gate acceptance', () => {
    const read = (suffix) =>
      readFileSync(
        fileURLToPath(
          new URL(
            `../../docs/design/2026-11-14-verify-pr-java-container-recipe${suffix}`,
            import.meta.url,
          ),
        ),
        'utf8',
      );
    const english = read('.md');
    const chinese = read('.zh-CN.md');
    const examples = [
      [
        english,
        '**Boundary.** host, maintainer-approved execution waiver recorded by prepare.',
        'Execution facts: exact seed image with mirror-only egress; battery --network none; model via host proxy; no credential signals observed.',
      ],
      [
        chinese,
        '**Boundary.** 宿主运行，使用 prepare 记录的维护者执行豁免。',
        '执行事实：预置按 digest 钉住镜像并仅镜像出网；电池 --network none；模型经宿主代理；无凭据信号。',
      ],
    ];
    const head = 'b'.repeat(40);
    const boundary = {
      mode: 'waived',
      source: 'local-trust',
      by: 'maintainer',
      basis: 'own-pr',
      permission: 'admin',
      head,
      round: 1,
      reason: 'independent Java battery with recorded waived executionApproval',
    };
    for (const [document, boundaryLine, executionFacts] of examples) {
      expect(document).toContain(boundaryLine);
      const result = checkArtifacts({
        files: {
          report: `merge-ready · 1 passed · 0 failed · 1 total · ${head}\n\n## Methodology\n\n${boundaryLine}\n${executionFacts}\n`,
          verdict: 'merge-ready\n',
          assertions: JSON.stringify({ pass: 1, fail: 0, total: 1 }),
          boundary: JSON.stringify(boundary),
        },
        evidence: ['01-ab.png'],
        coordinates: { owner: 'QwenLM', repo: 'qwen-code', number: 42 },
      });
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
    }
    const flatEnglish = english.replace(/\s+/g, ' ');
    expect(flatEnglish).toContain(
      'For a deliberately gate-less seed, acceptance admits only concrete, credential-free observations supported by the operator or measured launcher.',
    );
    expect(flatEnglish).toContain('a rejected seed is never reused');
    expect(flatEnglish).toContain(
      'Independently, a positive gated case runs `verify-pr-prepare.mjs --require-isolation --artifact-dir <round-dir>` in the exact Maven/JDK/Node seed image and requires exit 0.',
    );
    expect(flatEnglish).toContain(
      "Deep-compare that exact seed's `seed.json.gate` with the complete `boundary-gate.json` produced by the same invocation, never a sibling arm's or another round's record.",
    );
    expect(flatEnglish).toContain('no such gated live battery is claimed here');
    expect(flatEnglish).toContain(
      'Deliberately gate-less seed by operator choice, no gate or seed nonce generated',
    );
    expect(flatEnglish).toContain(
      'independent Maven/JDK battery cannot attest the seed boundary or return a seed nonce',
    );
    for (const text of [
      '无支撑的无凭据声明或任一凭据信号都拒绝该预置，被拒的预置不得复用',
      '在确切的 Maven/JDK/Node 预置镜像内运行 `verify-pr-prepare.mjs --require-isolation --artifact-dir <round-dir>` 并要求 exit 0',
      '把该确切预置的 `seed.json.gate` 与同一次调用产生的完整 `boundary-gate.json` 深度对账',
      '本文不宣称已经执行过这样的 gated live battery',
      '未选择门禁，因此根本没有生成预置 nonce',
      '独立 Java 电池无法返回该可选门禁的预置 nonce',
    ]) {
      expect(chinese).toContain(text);
    }
  });

  it('pins locked registration rotation and exact publication reconciliation in both designs', () => {
    const readDesign = (suffix) =>
      readFileSync(
        fileURLToPath(
          new URL(
            `../../docs/design/verify-pr-execution-preflight${suffix}`,
            import.meta.url,
          ),
        ),
        'utf8',
      );
    const english = readDesign('.md');
    const chinese = readDesign('.zh-CN.md');
    const flatEnglish = english.replace(/\s+/g, ' ');
    expect(english).not.toContain('--round <n>');
    expect(flatEnglish).toContain(
      'the declaration keys must match exactly, including `registrationNonce` for a comment approval',
    );
    expect(english).not.toContain('ignore additional declaration fields');
    expect(flatEnglish).toContain('the same cooperative watch-state lock');
    expect(flatEnglish).toContain(
      'A release plus a new start while the comment response is paused therefore makes the old prepare exit 3 without writing approval bytes.',
    );
    expect(flatEnglish).toContain(
      'a legacy entry without a nonce remains usable by the existing complete/release commands but must be released and restarted',
    );
    expect(flatEnglish).toContain(
      'repeats the exact HEAD/clean-status/index-flag check with the same hardened Git arguments and local-filter overrides used by the initial check',
    );
    expect(flatEnglish).toContain(
      'without any new network request in the lock',
    );
    expect(flatEnglish).toContain(
      'A withheld/no-publish round, after the local checker succeeds, uses that same command with the exact same head/round/nonce/state-root and artifact directory but omits the optional comment ID.',
    );
    expect(flatEnglish).toContain(
      'The verified entry retains `commentId: null` and the artifact directory',
    );
    expect(flatEnglish).toContain(
      'The marker is an instruction only when the complete HTML comment occupies one direct line at column zero',
    );
    expect(chinese).not.toContain('--round <n>');
    expect(chinese).toContain('声名字段键必须完全一致');
    expect(chinese).not.toContain('检查器规则忽略声明中的额外字段');
    expect(chinese).toContain('相同的协作式 watch-state 锁');
    expect(chinese).toContain('实际 release 后重新 start 会轮换 nonce');
    expect(chinese).toContain(
      '无 nonce 的 legacy 条目仍可由现有 complete/release 读取，但必须释放并重启',
    );
    expect(chinese).toContain(
      '再用初始检查相同的 hardened Git 参数与 local-filter override 重复 exact HEAD、clean-status 和 index-flag 检查',
    );
    expect(chinese).toContain('锁内不发起新的网络请求');
    expect(chinese).toContain(
      'withheld/no-publish 轮次则在本地 checker 成功后，仍以完全相同的 head/round/nonce/state-root 与 artifact dir 执行该完成命令，只省略可选 comment ID',
    );
    expect(chinese).toContain('verified 条目保留 `commentId: null`');
    expect(chinese).toContain(
      '只有完整 HTML comment 在列零独占一行时，标记才是执行批准',
    );
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
