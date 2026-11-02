#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Host-side model proxy for a local `/verify-pr` round.
 *
 * A local round needs the same isolation the CI lane provides: the container
 * executes untrusted PR code, so the real model credential must stay outside
 * it. This proxy holds the real key on the host and lets the container reach
 * the model with a per-run bearer token instead. It mirrors the CI lane's
 * inline proxy (qwen-triage.yml `start_openai_proxy`), with changes the local
 * shape needs: the listen address is a flag (a container cannot reach the
 * host's loopback, so bind the Docker bridge address instead), and the
 * coordinates are printed as one JSON line for the maintainer to consume.
 * Hop-by-hop request headers are stripped rather than forwarded.
 * The printed baseUrl uses the listen address, so bind the address clients
 * dial — 0.0.0.0 listens on every interface but is not a dialable URL.
 *
 * The CI lane deliberately keeps its own inline copy: the proxy handles the
 * real key, so it must not execute a script from the PR-head checkout.
 *
 * Usage (from a trusted checkout, never the PR-head tree — this process holds
 * the real key and a PR can rewrite a script in its own checkout):
 *   read -rsp 'REVIEW_OPENAI_API_KEY: ' REVIEW_OPENAI_API_KEY; echo
 *   export REVIEW_OPENAI_API_KEY
 *   REVIEW_OPENAI_BASE_URL=<url> \
 *     node <trusted-clone>/scripts/verify-pr-model-proxy.mjs \
 *       [--listen <host>] [--port <n>]
 *
 * Reading the key instead of typing it as an inline assignment keeps it out
 * of shell history, `set -x` traces, and terminal transcripts.
 *
 * Options:
 *   --listen <host>  address to bind (default 127.0.0.1; use the Docker
 *                    bridge address, e.g. 172.17.0.1, for container clients)
 *   --port <n>       port to bind (default 0 = ephemeral)
 *
 * Environment:
 *   REVIEW_OPENAI_BASE_URL    upstream base URL, may carry a path prefix
 *   REVIEW_OPENAI_API_KEY     the real key; never leaves this process
 *   QWEN_VERIFY_PROXY_TOKEN   bearer clients must present (default: random)
 *
 * On readiness, prints one JSON line: {port, baseUrl, token, nonce}. Give the
 * container `baseUrl` as the provider base URL and `token` as its credential;
 * `GET /__health` echoes `nonce`. Only `POST <basePath>/chat/completions` is
 * relayed — the path is matched exactly, not as a suffix.
 */

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import { isEntryPoint } from './lib/entry-point.js';

export const DEFAULT_IDLE_TIMEOUT_MS = 240_000;

// The qwen client tolerates 240 s of silence inside one stream
// (DEFAULT_STREAM_IDLE_TIMEOUT_MS in the OpenAI content generator), so a
// tighter proxy window would cut a completion its own client would have
// waited out. Keep the default equal; a caller may still pass its own value.

// RFC 7230 hop-by-hop headers describe the client's connection to us, not the
// upstream one. Forwarding them is never correct, and a copied
// transfer-encoding or expect also fights the framing undici chooses for the
// relayed stream. `host` and `content-length` ride along for the same reason.
const STRIPPED_REQUEST_HEADERS = [
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
];

export function parseArgs(argv) {
  const options = { listen: '127.0.0.1', port: 0 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--listen' || arg === '--port') {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === '--listen') {
        options.listen = value;
      } else {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new Error(`--port must be an integer in [0, 65535]: ${value}`);
        }
        options.port = port;
      }
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/** Strips the trailing slashes a base path may carry; `''` means none. */
export function normalizeBasePath(pathname) {
  const trimmed = (pathname ?? '').replace(/\/+$/, '');
  return trimmed === '/' ? '' : trimmed;
}

/**
 * Assembles the base URL the maintainer hands to the container. A host that
 * carries a colon is an IPv6 literal and needs brackets, or `new URL()`
 * rejects the string downstream.
 */
export function formatLocalBaseUrl(listen, port, basePath = '') {
  const host = listen.includes(':') ? `[${listen}]` : listen;
  return `http://${host}:${port}${basePath}`;
}

/**
 * Returns an http.Server that relays only POST /chat/completions to the
 * upstream, replacing the client's bearer token with the real key. The idle
 * watchdog is per-chunk, not total: qwen tolerates minutes of silence inside
 * one stream, so a total cap would cut healthy long completions. It also
 * stays quiet while the downstream is paused — backpressure from a slow but
 * live client is not upstream idleness — and re-arms on 'drain'.
 */
export function createModelProxy({
  baseUrl,
  apiKey,
  token,
  nonce,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
}) {
  if (!baseUrl || !apiKey || !token || !nonce) {
    throw new Error('baseUrl, apiKey, token and nonce are all required');
  }
  const base = new URL(baseUrl);
  const basePath = normalizeBasePath(base.pathname);

  return http.createServer(async (req, res) => {
    if (req.url === '/__health') {
      // Identity, not just liveness: a squatter cannot know the nonce.
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(nonce);
      return;
    }

    let timer;
    try {
      const incoming = new URL(req.url || '/', 'http://127.0.0.1');
      const target = new URL(base.origin);

      let path = incoming.pathname;
      if (
        basePath &&
        basePath !== '/' &&
        path !== basePath &&
        !path.startsWith(`${basePath}/`)
      ) {
        path = `${basePath}${path.startsWith('/') ? '' : '/'}${path}`;
      }
      target.pathname = path;
      target.search = incoming.search;

      // Exact path, not a suffix: `endsWith('/chat/completions')` would also
      // relay `/admin/chat/completions` to the upstream.
      const allowedPath = basePath
        ? `${basePath}/chat/completions`
        : '/chat/completions';
      if (req.method !== 'POST' || target.pathname !== allowedPath) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end(`proxy: only POST ${allowedPath} is allowed\n`);
        return;
      }

      // Only the agent knows this run's token; anything else that finds the
      // port cannot get the key used.
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('proxy: unauthorized\n');
        return;
      }

      const headers = new Headers(req.headers);
      for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);
      // RFC 7230 §6.1: a header nominated by Connection is hop-by-hop too,
      // so a client cannot smuggle one through under an unlisted name.
      const nominated = String(req.headers.connection ?? '')
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean);
      for (const name of nominated) headers.delete(name);
      headers.set('authorization', `Bearer ${apiKey}`);

      const init = { method: req.method, headers };
      init.body = req;
      init.duplex = 'half';

      const controller = new AbortController();
      let body = null;
      let finished = false;
      const arm = () => {
        if (finished) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          // A paused body is downstream backpressure, not upstream silence:
          // the client is alive but slow, and aborting here would cut a
          // healthy completion. The 'drain' listener re-arms this window.
          if (body?.isPaused()) {
            arm();
            return;
          }
          controller.abort();
        }, idleTimeoutMs);
      };
      // Registered before the fetch: a client that disconnects while the
      // upstream headers are still in flight has already emitted 'close', so
      // registering after the response would never abort that request.
      res.on('close', () => {
        finished = true;
        clearTimeout(timer);
        controller.abort();
      });
      res.on('drain', arm);
      arm();
      let upstream;
      try {
        upstream = await fetch(target, { ...init, signal: controller.signal });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          if (!res.destroyed && !res.writableEnded) {
            res.writeHead(504, { 'content-type': 'text/plain' });
            res.end('proxy error: upstream request timed out\n');
          }
          return;
        }
        throw error;
      }
      if (res.destroyed) {
        finished = true;
        clearTimeout(timer);
        return;
      }
      // The timer is deliberately NOT cleared here: fetch() resolves on
      // HEADERS, and the armed timer doubles as the first idle window for
      // the body; the per-chunk handler below refreshes it.
      const responseHeaders = {};
      upstream.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (lower !== 'content-encoding' && lower !== 'content-length') {
          responseHeaders[key] = value;
        }
      });
      res.writeHead(upstream.status, responseHeaders);
      if (upstream.body) {
        body = Readable.fromWeb(upstream.body);
        const done = () => {
          finished = true;
          clearTimeout(timer);
        };
        body.on('end', done);
        // An idle watchdog firing mid-body aborts the upstream, which
        // surfaces here as an error: tear down the downstream response too.
        body.on('error', () => {
          done();
          res.destroy();
        });
        body.pipe(res);
        body.on('data', arm);
      } else {
        finished = true;
        clearTimeout(timer);
        res.end();
      }
    } catch (error) {
      clearTimeout(timer);
      console.error('proxy upstream failure:', error);
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('proxy error: upstream request failed\n');
    }
  });
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  const baseUrl = process.env.REVIEW_OPENAI_BASE_URL;
  const apiKey = process.env.REVIEW_OPENAI_API_KEY;
  if (!baseUrl || !apiKey) {
    process.stderr.write(
      'REVIEW_OPENAI_BASE_URL and REVIEW_OPENAI_API_KEY must both be set\n',
    );
    return 2;
  }
  const token =
    process.env.QWEN_VERIFY_PROXY_TOKEN || randomBytes(24).toString('hex');
  const nonce = randomBytes(24).toString('hex');
  const server = createModelProxy({ baseUrl, apiKey, token, nonce });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.listen, resolve);
  });
  const { port } = server.address();
  const localBaseUrl = formatLocalBaseUrl(
    options.listen,
    port,
    normalizeBasePath(new URL(baseUrl).pathname),
  );
  // One JSON line, on stdout: the maintainer pastes baseUrl/token into the
  // container's provider configuration. The real key is never printed.
  process.stdout.write(
    `${JSON.stringify({ port, baseUrl: localBaseUrl, token, nonce })}\n`,
  );
  return 0;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
