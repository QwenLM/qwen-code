#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { Readable } from 'node:stream';

const baseUrl = process.env.QWEN_UPSTREAM_OPENAI_BASE_URL;
const apiKey = process.env.QWEN_UPSTREAM_OPENAI_API_KEY;
const infoPath = process.env.QWEN_OPENAI_PROXY_INFO;

if (!baseUrl || !apiKey || !infoPath) {
  console.error('missing OpenAI proxy configuration');
  process.exit(1);
}

const base = new URL(baseUrl);
const basePath = base.pathname.replace(/\/+$/, '');

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function finishWith(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/__health') {
    res.writeHead(204);
    res.end();
    return;
  }

  const startedAt = process.hrtime.bigint();
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
      console.error(`[proxy] ${req.method} ${incoming.pathname} -> 403`);
      finishWith(res, 403, 'proxy: only POST /chat/completions is allowed\n');
      return;
    }

    const headers = new Headers(req.headers);
    headers.delete('host');
    headers.delete('content-length');
    headers.set('authorization', `Bearer ${apiKey}`);

    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req,
      duplex: 'half',
    });

    const responseHeaders = {};
    upstream.headers.forEach((value, key) => {
      if (!['content-encoding', 'content-length'].includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.error(
      `[proxy] ${req.method} ${target.pathname} -> ${upstream.status} (${durationMs.toFixed(0)}ms)`,
    );
    res.writeHead(upstream.status, responseHeaders);
    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    console.error(`[proxy] error: ${errorMessage(error)}`);
    if (!res.headersSent) {
      finishWith(res, 502, `proxy error: ${errorMessage(error)}\n`);
    } else {
      res.end();
    }
  }
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') {
    console.error('OpenAI proxy did not receive a TCP listen address');
    process.exit(1);
  }
  const path = basePath && basePath !== '/' ? basePath : '';
  writeFileSync(infoPath, `http://127.0.0.1:${address.port}${path}`);
});
