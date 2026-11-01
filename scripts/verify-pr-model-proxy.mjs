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
 * inline proxy (qwen-triage.yml `start_openai_proxy`), with two changes the
 * local shape needs: the listen address is a flag (a container cannot reach
 * the host's loopback, so bind the Docker bridge address instead), and the
 * coordinates are printed as one JSON line for the maintainer to consume.
 *
 * The CI lane deliberately keeps its own inline copy: the proxy handles the
 * real key, so it must not execute a script from the PR-head checkout.
 *
 * Usage:
 *   REVIEW_OPENAI_BASE_URL=<url> REVIEW_OPENAI_API_KEY=<key> \
 *     node scripts/verify-pr-model-proxy.mjs [--listen <host>] [--port <n>]
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
 * `GET /__health` echoes `nonce`. Only `POST .../chat/completions` is relayed.
 */

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import { isEntryPoint } from './lib/entry-point.js';

const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

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

/**
 * Returns an http.Server that relays only POST /chat/completions to the
 * upstream, replacing the client's bearer token with the real key. The idle
 * watchdog is per-chunk, not total: qwen tolerates minutes of silence inside
 * one stream, so a total cap would cut healthy long completions.
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
  const basePath = base.pathname.replace(/\/+$/, '');

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

      if (
        req.method !== 'POST' ||
        !target.pathname.endsWith('/chat/completions')
      ) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('proxy: only POST /chat/completions is allowed\n');
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
      headers.delete('host');
      headers.delete('content-length');
      headers.set('authorization', `Bearer ${apiKey}`);

      const init = { method: req.method, headers };
      init.body = req;
      init.duplex = 'half';

      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), idleTimeoutMs);
      let upstream;
      try {
        upstream = await fetch(target, { ...init, signal: controller.signal });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          res.writeHead(504, { 'content-type': 'text/plain' });
          res.end('proxy error: upstream request timed out\n');
          return;
        }
        throw error;
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
        const body = Readable.fromWeb(upstream.body);
        const done = () => clearTimeout(timer);
        body.on('end', done);
        // An idle watchdog firing mid-body aborts the upstream, which
        // surfaces here as an error: tear down the downstream response too.
        body.on('error', () => {
          done();
          res.destroy();
        });
        // A downstream disconnect must abort the upstream request too, or
        // the stalled fetch keeps the socket alive.
        res.on('close', () => {
          done();
          controller.abort();
        });
        body.pipe(res);
        body.on('data', () => {
          clearTimeout(timer);
          timer = setTimeout(() => controller.abort(), idleTimeoutMs);
        });
      } else {
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
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const localBaseUrl =
    `http://${options.listen}:${port}` +
    (basePath && basePath !== '/' ? basePath : '');
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
