/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServeApp } from './server.js';
import { getServeAppLifecycle } from './serve-app-lifecycle.js';
import {
  signedManagedHeaders,
  mountManagedLocalWeb,
} from './managed-local-web.js';

const SIGNING_KEY = '0123456789abcdef0123456789abcdef';

describe('signedManagedHeaders', () => {
  afterEach(() => vi.restoreAllMocks());

  it('matches the Java signature over raw UTF-8, encoded query and idempotency key', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    expect(
      signedManagedHeaders({
        method: 'POST',
        path: '/api/agent/web-shell/v1/sessions/create?a=1%2F2&b=hello+world',
        body: Buffer.from('{"message":"汉字\\n"}'),
        signingKey: SIGNING_KEY,
        tenantId: 'local',
        actorId: 'owner',
        idempotencyKey: 'request-1',
      }),
    ).toEqual({
      'X-Qwen-Tenant-Id': 'local',
      'X-Qwen-Actor-Id': 'owner',
      'X-Qwen-Signature-Timestamp': '1700000000',
      'X-Qwen-Signature':
        'v1=245591f2cf83a9019a7c039cff1ec31a3142597761b4d1a9d54de509a8e0f02e',
      'Idempotency-Key': 'request-1',
    });
  });
});

describe('Managed local front door', () => {
  let directory: string;
  let java: ReturnType<typeof createServer>;
  let web: { url: string; close(): Promise<void> } | undefined;
  let handler: (request: IncomingMessage, response: ServerResponse) => void;
  const calls: Array<{
    method?: string;
    url?: string;
    headers: IncomingMessage['headers'];
    body: Buffer;
  }> = [];
  let javaUrl: string;

  beforeEach(async () => {
    calls.length = 0;
    directory = await mkdtemp(path.join(tmpdir(), 'qwen-managed-web-'));
    await mkdir(path.join(directory, 'assets'));
    await writeFile(
      path.join(directory, 'index.html'),
      '<html><head><title>Qwen</title></head><body>app</body></html>',
    );
    await writeFile(path.join(directory, 'assets', 'app-12345678.js'), 'app;');
    handler = (_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    };
    java = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      calls.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      handler(request, response);
    });
    await new Promise<void>((resolve) => java.listen(0, '127.0.0.1', resolve));
    const address = java.address();
    if (typeof address !== 'object' || !address)
      throw new Error('Missing port');
    javaUrl = `http://127.0.0.1:${address.port}`;
    let port = 0;
    const app = createServeApp(
      {
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        port,
        workspace: directory,
        token: 'browser-token',
        requireAuth: true,
      },
      () => port,
      { webShellDir: directory, managedLocalWeb: options() },
    );
    const server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const publicAddress = server.address();
    if (!publicAddress || typeof publicAddress === 'string')
      throw new Error('Missing public port');
    port = publicAddress.port;
    web = {
      url: `http://127.0.0.1:${port}`,
      async close() {
        await getServeAppLifecycle(app)?.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  });

  function options() {
    return {
      javaUrl,
      signingKey: SIGNING_KEY,
      tenantId: 'local',
      actorId: 'owner',
      productScope: 'local:installation-1',
      agentId: 'qwen-code',
      modelPresets: [{ agentId: 'agent_local', label: 'Local model' }],
    };
  }

  function get(url: string, init?: RequestInit) {
    return fetch(`${web!.url}${url}`, {
      ...init,
      headers: { Authorization: 'Bearer browser-token', ...init?.headers },
    });
  }

  afterEach(async () => {
    await web?.close();
    web = undefined;
    java.closeAllConnections();
    await new Promise<void>((resolve) => java.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it('serves public compiled assets with only a Managed marker and same-origin CSP', async () => {
    const response = await fetch(
      `${web!.url}/?daemon=https://attacker.example&fanout=https://other.example`,
    );
    const html = await response.text();
    expect(html).toContain('<meta name="qwen-managed-app" content="true">');
    expect(html).not.toContain('browser-token');
    expect(html).not.toContain(SIGNING_KEY);
    expect(response.headers.get('content-security-policy')).not.toContain(
      'attacker',
    );
    expect(response.headers.get('content-security-policy')).not.toContain(
      'other.example',
    );
    const asset = await fetch(`${web!.url}/assets/app-12345678.js`);
    expect(await asset.text()).toBe('app;');
    expect(calls).toHaveLength(0);
  });

  it('requires the front-door bearer for capabilities and public boot options', async () => {
    for (const url of ['/managed/boot', '/capabilities']) {
      const unauthenticated = await fetch(`${web!.url}${url}`);
      expect(unauthenticated.status).toBe(401);
    }
    const response = await get('/managed/boot');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      mode: 'managed',
      productScope: 'local:installation-1',
      agentId: 'qwen-code',
      enableWorkspaceBinding: true,
      modelPresets: [{ agentId: 'agent_local', label: 'Local model' }],
    });
    const capabilities = await (await get('/capabilities')).json();
    expect(capabilities).toHaveProperty('workspaces');
    expect(capabilities).toHaveProperty('features');
    expect(calls).toHaveLength(0);
  });

  it('preserves exact raw bytes and query while replacing browser identity and private headers', async () => {
    handler = (_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.setHeader('set-cookie', 'private=value');
      response.setHeader('x-qwen-runtime-broker-token', 'private-secret');
      response.end('{"ok":true}');
    };
    const body = Buffer.from(' { "message" : "汉字\\n" }\n');
    const target = '/api/agent/web-shell/v1/sessions/create?opaque=a%2Fb+c';
    const response = await get(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Qwen-Tenant-Id': 'attacker',
        'X-Qwen-Actor-Id': 'administrator',
        'X-Qwen-Signature': 'forged',
        'X-Qwen-Writer-Token': 'private-secret',
        Cookie: 'secret=value',
        'Idempotency-Key': 'command-1',
        Origin: web!.url,
      },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-qwen-runtime-broker-token')).toBeNull();
    const call = calls[0]!;
    expect(call.url).toBe(target);
    expect(call.body.equals(body)).toBe(true);
    expect(call.headers['x-qwen-tenant-id']).toBe('local');
    expect(call.headers['x-qwen-actor-id']).toBe('owner');
    for (const name of [
      'authorization',
      'cookie',
      'origin',
      'x-qwen-writer-token',
    ]) {
      expect(call.headers[name]).toBeUndefined();
    }
    const canonical = `qwen-broker-auth-v1\nPOST\n/api/agent/web-shell/v1/sessions/create\nopaque=a%2Fb+c\nlocal\nowner\n${call.headers['x-qwen-signature-timestamp']}\n${createHash('sha256').update(body).digest('hex')}\ncommand-1`;
    expect(call.headers['x-qwen-signature']).toBe(
      `v1=${createHmac('sha256', SIGNING_KEY).update(canonical).digest('hex')}`,
    );
  });

  it('keeps ordinary health reads and JSON request handling in the daemon', async () => {
    const response = await get('/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const malformed = await get('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('allows only exact artifact content reads and preserves range validators', async () => {
    const target =
      '/v1/agents/sessions/session-1/artifacts/artifact-1/content?revision=abc';
    const response = await get(target, {
      headers: { 'If-Match': '"abc"', Range: 'bytes=0-2' },
    });
    expect(response.status).toBe(200);
    expect(calls[0]?.url).toBe(target);
    expect(calls[0]?.headers['if-match']).toBe('"abc"');
    expect(calls[0]?.headers.range).toBe('bytes=0-2');
    expect((await get(target, { method: 'HEAD' })).status).toBe(200);
    expect(calls[1]?.method).toBe('HEAD');
    for (const [method, url] of [
      ['POST', target],
      [
        'GET',
        '/v1/agents/sessions/session-1/artifacts/artifact-1/content/extra',
      ],
      ['GET', '/v1/agents/sessions/session-1/artifacts'],
      ['GET', '/internal/managed-session-store/v1/write'],
      ['GET', '/v1/agents'],
      ['GET', '/api/agent/web-shell/v10/sessions/query'],
    ]) {
      const denied = await get(url!, {
        method,
        headers: { Accept: 'text/html' },
      });
      expect(denied.status).toBe(404);
      expect(denied.headers.get('content-type')).toContain('application/json');
    }
    expect(calls).toHaveLength(2);
  });

  it('rejects foreign browser origins and DNS-rebinding Host values', async () => {
    expect(
      (
        await get('/managed/boot', {
          headers: { Origin: 'https://attacker.example' },
        })
      ).status,
    ).toBe(403);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        `${web!.url}/managed/boot`,
        {
          headers: {
            Host: 'attacker.example',
            Authorization: 'Bearer browser-token',
          },
        },
        (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode));
        },
      );
      request.once('error', reject);
      request.end();
    });
    expect(status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('bounds signed bodies and refuses repeated idempotency headers before Java', async () => {
    const target = '/api/agent/web-shell/v1/sessions/create';
    const oversized = await get(target, {
      method: 'POST',
      body: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    expect(oversized.status).toBe(413);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        `${web!.url}${target}`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer browser-token',
            'Idempotency-Key': ['one', 'two'],
          },
        },
        (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode));
        },
      );
      request.once('error', reject);
      request.end();
    });
    expect(status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('streams SSE before completion and cancels Java when the browser disconnects', async () => {
    let disconnected = false;
    handler = (_request, response) => {
      response.setHeader('content-type', 'text/event-stream');
      response.write('data: {"ready":true}\n\n');
      response.once('close', () => {
        disconnected = true;
      });
    };
    const controller = new AbortController();
    const response = await get('/api/agent/web-shell/v1/events/stream', {
      method: 'POST',
      body: '{}',
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      'ready',
    );
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await vi.waitFor(() => expect(disconnected).toBe(true));
  });

  it('refuses non-loopback Java targets', () => {
    expect(() =>
      mountManagedLocalWeb(express(), {
        ...options(),
        javaUrl: 'http://attacker.example',
      }),
    ).toThrow('loopback');
  });
});
