/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHmac, createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runManagedWebServe } from './managed-web-serve.js';

const browserToken = 'browser-token';
const signingKey = 'operator-signing-key-with-thirty-two-bytes\n ';

describe('dedicated Managed Web gateway', () => {
  let directory: string;
  let configFile: string;
  let keyFile: string;
  let apiUrl: string;
  let peer: ReturnType<typeof createServer>;
  let gateway: Awaited<ReturnType<typeof runManagedWebServe>> | undefined;
  let handler: (req: IncomingMessage, res: ServerResponse) => void;
  const calls: Array<{
    url?: string;
    headers: IncomingMessage['headers'];
    body: Buffer;
  }> = [];

  beforeEach(async () => {
    vi.stubEnv('QWEN_SERVER_TOKEN', undefined);
    calls.length = 0;
    directory = await mkdtemp(join(tmpdir(), 'qwen-managed-gateway-'));
    await mkdir(join(directory, 'assets'));
    await writeFile(
      join(directory, 'index.html'),
      '<html><head></head><body>WebShell</body></html>',
    );
    await writeFile(join(directory, 'assets', 'app-12345678.js'), 'app;');
    keyFile = join(directory, 'operator-signing-key');
    await writeFile(keyFile, signingKey, { mode: 0o600 });
    handler = (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
    };
    peer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      calls.push({
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      handler(req, res);
    });
    await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve));
    const address = peer.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing peer port');
    apiUrl = `http://127.0.0.1:${address.port}`;
    configFile = join(directory, 'gateway.json');
    await saveConfig();
  });

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
    peer.closeAllConnections();
    await new Promise<void>((resolve) => peer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function saveConfig(extra: Record<string, unknown> = {}) {
    return writeFile(
      configFile,
      JSON.stringify({
        apiUrl,
        tenantId: 'tenant-a',
        actorId: 'operator-a',
        signingKeyFile: keyFile,
        ...extra,
      }),
    );
  }

  async function start(
    options: Partial<Parameters<typeof runManagedWebServe>[0]> = {},
  ) {
    gateway = await runManagedWebServe(
      {
        configFile,
        hostname: '127.0.0.1',
        port: 0,
        token: browserToken,
        ...options,
      },
      { webShellDir: directory, installSignalHandlers: false },
    );
    return gateway;
  }

  function get(path: string, options: RequestInit = {}) {
    return fetch(`${gateway!.url}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${browserToken}`, ...options.headers },
    });
  }

  it('serves public assets and authenticated Managed-only boot with a short browser token', async () => {
    await start();
    const html = await (await fetch(`${gateway!.url}/`)).text();
    expect(html).toContain('<meta name="qwen-managed-app" content="true">');
    expect(html).not.toContain(browserToken);
    expect(html).not.toContain(signingKey);
    expect(
      await (await fetch(`${gateway!.url}/assets/app-12345678.js`)).text(),
    ).toBe('app;');
    for (const path of ['/managed/boot', '/capabilities', '/health']) {
      expect((await fetch(`${gateway!.url}${path}`)).status).toBe(401);
      expect(
        (await get(path, { headers: { Authorization: 'Bearer wrong' } }))
          .status,
      ).toBe(401);
    }
    const boot = await (await get('/managed/boot')).json();
    expect(boot).toMatchObject({
      mode: 'managed',
      managedOnly: true,
      agentId: 'qwen-code',
      enableWorkspaceBinding: true,
    });
    expect(JSON.stringify(boot)).not.toContain(keyFile);
    expect(JSON.stringify(boot)).not.toContain(signingKey);
    expect(await (await get('/capabilities')).json()).toEqual({
      mode: 'managed',
    });
    expect((await get('/health')).ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rejects daemon routes even with a valid browser token and HTML Accept', async () => {
    await start();
    for (const accept of ['application/json', 'text/html']) {
      for (const [method, path] of [
        ['GET', '/file?path=operator-signing-key'],
        ['GET', '/file/bytes?path=operator-signing-key'],
        ['POST', '/workspaces'],
        ['POST', '/workspaces/key-dir/trust/grant'],
        ['GET', '/workspaces/key-dir/file?path=operator-signing-key'],
        ['POST', '/session'],
        ['GET', '/session/id'],
        ['POST', '/session/id/shell'],
        ['POST', '/workspace/settings'],
        ['POST', '/workspace/mcp/initialize'],
        ['POST', '/workspace/mcp/server/restart'],
        ['POST', '/desktop-relay/credential'],
        ['GET', '/acp'],
        ['GET', '/internal/managed-session-store/v1/read'],
        ['GET', '/v1/agents/sessions'],
      ]) {
        const response = await get(path!, {
          method,
          headers: { Accept: accept },
        });
        expect(response.status, `${method} ${path} ${accept}`).toBe(404);
        expect(response.headers.get('Content-Type')).toContain(
          'application/json',
        );
      }
    }
    expect(calls).toHaveLength(0);
  });

  it('signs exact bytes with the fixed principal and preserves artifact range', async () => {
    await start();
    const path = '/api/agent/web-shell/v1/sessions/create?q=a%2Fb+c';
    const body = ' {"input":"汉字"}\n';
    const response = await get(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'one-command',
        'X-Qwen-Tenant-Id': 'attacker',
        'X-Qwen-Actor-Id': 'administrator',
        'X-Qwen-Writer-Token': 'private-value',
        Origin: gateway!.url,
      },
      body,
    });
    expect(response.status).toBe(200);
    const call = calls[0]!;
    expect(call.body.toString()).toBe(body);
    expect(call.headers['x-qwen-tenant-id']).toBe('tenant-a');
    expect(call.headers['x-qwen-actor-id']).toBe('operator-a');
    expect(call.headers.authorization).toBeUndefined();
    expect(call.headers['x-qwen-writer-token']).toBeUndefined();
    const canonical = `qwen-broker-auth-v1\nPOST\n/api/agent/web-shell/v1/sessions/create\nq=a%2Fb+c\ntenant-a\noperator-a\n${call.headers['x-qwen-signature-timestamp']}\n${createHash('sha256').update(body).digest('hex')}\none-command`;
    expect(call.headers['x-qwen-signature']).toBe(
      `v1=${createHmac('sha256', signingKey).update(canonical).digest('hex')}`,
    );
    expect(
      (
        await get('/v1/agents/sessions/s1/artifacts/a1/content', {
          headers: { Range: 'bytes=0-2', 'If-Match': '"revision"' },
        })
      ).status,
    ).toBe(200);
    expect(calls[1]?.headers.range).toBe('bytes=0-2');
    expect(calls[1]?.headers['if-match']).toBe('"revision"');
  });

  it('streams SSE without buffering and closes upstream on browser disconnect', async () => {
    let disconnected = false;
    handler = (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"ready":true}\n\n');
      res.once('close', () => {
        disconnected = true;
      });
    };
    await start();
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
    await reader.cancel().catch(() => {});
    await vi.waitFor(() => expect(disconnected).toBe(true));
  });

  it('supports authenticated non-loopback HTTP and an explicit TLS ingress origin', async () => {
    await start({
      hostname: '0.0.0.0',
      allowOrigins: ['https://managed.example'],
    });
    const url = gateway!.url.replace('0.0.0.0', '127.0.0.1');
    for (const origin of [url, 'https://managed.example']) {
      const response = await fetch(`${url}/managed/boot`, {
        headers: { Authorization: `Bearer ${browserToken}`, Origin: origin },
      });
      expect(response.status).toBe(200);
    }
    expect(
      (
        await fetch(`${url}/managed/boot`, {
          headers: {
            Authorization: `Bearer ${browserToken}`,
            Origin: 'https://attacker.example',
          },
        })
      ).status,
    ).toBe(403);
    await new Promise<void>((resolve, reject) => {
      const upgrade = request(`${url}/acp`, {
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          Authorization: `Bearer ${browserToken}`,
        },
      });
      upgrade.on('upgrade', () =>
        reject(new Error('Gateway accepted a WebSocket upgrade')),
      );
      upgrade.on('error', () => resolve());
      upgrade.end();
    });
  });

  it('forwards the terminal upgrade to the control plane with its ticket subprotocol', async () => {
    let peerPath: string | undefined;
    let peerProtocol: string | undefined;
    let peerAuthorization: string | undefined;
    let peerSocket: import('node:stream').Duplex | undefined;
    peer.on('upgrade', (req, socket) => {
      peerSocket = socket;
      peerPath = req.url;
      peerProtocol = req.headers['sec-websocket-protocol'];
      peerAuthorization = req.headers['authorization'];
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Accept: test-accept\r\n' +
          'Sec-WebSocket-Protocol: qwen-ws\r\n\r\n',
      );
      socket.on('data', (chunk) => socket.write(chunk));
    });
    await start();
    const result = await new Promise<{
      status: number;
      protocol?: string;
    }>((resolve, reject) => {
      const upgrade = request(
        `${gateway!.url}/api/agent/web-shell/v1/sessions/sess-1/terminal?terminalId=t1&replay=1`,
        {
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Protocol': 'qwen-ws, qwen-bearer.ticket-abc',
            Authorization: `Bearer ${browserToken}`,
          },
        },
      );
      upgrade.on('upgrade', (res, socket) => {
        socket.destroy();
        resolve({
          status: res.statusCode ?? 0,
          protocol: res.headers['sec-websocket-protocol'],
        });
      });
      upgrade.on('response', (res) => resolve({ status: res.statusCode ?? 0 }));
      upgrade.on('error', reject);
      upgrade.end();
    });
    expect(result.status).toBe(101);
    expect(result.protocol).toBe('qwen-ws');
    expect(peerPath).toBe(
      '/api/agent/web-shell/v1/sessions/sess-1/terminal?terminalId=t1&replay=1',
    );
    expect(peerProtocol).toBe('qwen-ws, qwen-bearer.ticket-abc');
    // The gateway bearer must not leak to the control-plane upgrade.
    expect(peerAuthorization).toBeUndefined();
    peerSocket?.destroy();
  });

  it('shutdown destroys an attached terminal instead of hanging', async () => {
    let peerSocket: import('node:stream').Duplex | undefined;
    peer.on('upgrade', (_req, socket) => {
      peerSocket = socket;
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Accept: test-accept\r\n' +
          'Sec-WebSocket-Protocol: qwen-ws\r\n\r\n',
      );
      socket.on('data', (chunk) => socket.write(chunk));
    });
    await start();
    const clientSocket = await new Promise<import('node:stream').Duplex>(
      (resolve, reject) => {
        const upgrade = request(
          `${gateway!.url}/api/agent/web-shell/v1/sessions/sess-1/terminal?terminalId=t1&replay=1`,
          {
            headers: {
              Connection: 'Upgrade',
              Upgrade: 'websocket',
              'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
              'Sec-WebSocket-Version': '13',
              'Sec-WebSocket-Protocol': 'qwen-ws, qwen-bearer.ticket-abc',
              Authorization: `Bearer ${browserToken}`,
            },
          },
        );
        upgrade.on('upgrade', (_res, socket) => resolve(socket));
        upgrade.on('response', (res) =>
          reject(new Error(`upgrade refused: ${res.statusCode}`)),
        );
        upgrade.on('error', reject);
        upgrade.end();
      },
    );
    const clientClosed = new Promise<void>((resolve) =>
      clientSocket.once('close', () => resolve()),
    );
    const timeout = (message: string) =>
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(message)), 5_000).unref(),
      );
    // An attached, idle terminal is an upgraded socket closeAllConnections()
    // does not reach; shutdown must destroy it rather than wait on it.
    await Promise.race([
      gateway!.close(),
      timeout('gateway close hung with a terminal attached'),
    ]);
    await Promise.race([
      clientClosed,
      timeout('terminal socket survived gateway shutdown'),
    ]);
    peerSocket?.destroy();
  });

  it('shutdown tears down an in-flight upgrade whose 101 is withheld', async () => {
    let peerSocket: import('node:stream').Duplex | undefined;
    const peerReceived = new Promise<void>((resolve) => {
      peer.on('upgrade', (_req, socket) => {
        peerSocket = socket;
        socket.resume();
        // Withhold the 101 so the upgrade stays in flight at shutdown.
        resolve();
      });
    });
    await start();
    const clientSocket = await new Promise<import('node:stream').Duplex>(
      (resolve, reject) => {
        const upgrade = request(
          `${gateway!.url}/api/agent/web-shell/v1/sessions/sess-1/terminal?terminalId=t1&replay=1`,
          {
            headers: {
              Connection: 'Upgrade',
              Upgrade: 'websocket',
              'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
              'Sec-WebSocket-Version': '13',
              'Sec-WebSocket-Protocol': 'qwen-ws, qwen-bearer.ticket-abc',
              Authorization: `Bearer ${browserToken}`,
            },
          },
        );
        upgrade.on('socket', (socket) => resolve(socket));
        upgrade.on('error', reject);
        upgrade.end();
      },
    );
    let relayed101 = false;
    clientSocket.on('data', (chunk) => {
      if (chunk.toString().includes('101')) relayed101 = true;
    });
    const clientClosed = new Promise<void>((resolve) =>
      clientSocket.once('close', () => resolve()),
    );
    const timeout = (message: string) =>
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(message)), 5_000).unref(),
      );
    // Ensure the control-plane leg is actually established before shutdown.
    await Promise.race([
      peerReceived,
      timeout('peer never received the upgrade'),
    ]);
    await Promise.race([
      gateway!.close(),
      timeout('gateway close hung with an in-flight upgrade'),
    ]);
    // Shutdown must tear the browser end down rather than wait on the in-flight
    // upgrade, and no late 101 may be relayed to a client that no longer exists.
    await Promise.race([
      clientClosed,
      timeout('client socket survived gateway shutdown'),
    ]);
    expect(relayed101).toBe(false);
    // The control-plane leg is destroyed by shutdown; drop our reference so the
    // peer server can close cleanly.
    peerSocket?.destroy();
  });

  it('fails before listening for invalid configuration or missing, weak, shared credentials', async () => {
    for (const token of [
      undefined,
      '',
      ' \t ',
      signingKey,
      signingKey.trim(),
    ]) {
      await expect(start({ token })).rejects.toThrow(
        'non-empty browser token and an independent signing key',
      );
    }
    for (const values of [
      { apiUrl: 'http://remote.example' },
      { apiUrl: `${apiUrl}/internal` },
      { apiUrl: `${apiUrl}?secret=x` },
      { tenantId: 'bad tenant' },
      { actorId: '' },
      { signingKeyFile: 'relative-key' },
      { signingKey: 'must-not-be-in-config' },
    ]) {
      await saveConfig(values);
      await expect(start()).rejects.toThrow(/Managed Web/u);
    }
    await saveConfig();
    await writeFile(keyFile, 'weak');
    await expect(start()).rejects.toThrow(
      'non-empty browser token and an independent signing key',
    );
    await writeFile(keyFile, signingKey);
    vi.stubEnv('QWEN_SERVER_TOKEN', browserToken);
    await start({ token: undefined });
    expect((await get('/health')).ok).toBe(true);
  });
});
