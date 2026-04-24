/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { startDesktopServer } from './index.js';
import type { DesktopServer } from './types.js';
import type { AcpSessionClient } from './services/sessionService.js';

const servers: DesktopServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('DesktopServer', () => {
  it('binds to localhost and serves authenticated health checks', async () => {
    const server = await createTestServer();

    expect(server.info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(server.info.token).toBe('test-token');

    const unauthorized = await getJson(server, '/health');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body).toMatchObject({
      ok: false,
      code: 'unauthorized',
    });

    const authorized = await getJson(server, '/health', {
      Authorization: 'Bearer test-token',
    });
    expect(authorized.status).toBe(200);
    expect(authorized.body).toMatchObject({
      ok: true,
      service: 'qwen-desktop',
    });
  });

  it('rejects non-local origins before token checks', async () => {
    const server = await createTestServer();

    const response = await getJson(server, '/health', {
      Authorization: 'Bearer test-token',
      Origin: 'https://example.com',
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      ok: false,
      code: 'origin_forbidden',
    });
  });

  it('allows app preflight requests without exposing the route', async () => {
    const server = await createTestServer();

    const response = await fetch(`${server.info.url}/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:5173',
        'Access-Control-Request-Headers': 'authorization',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'http://127.0.0.1:5173',
    );
    expect(response.headers.get('access-control-allow-headers')).toContain(
      'authorization',
    );
  });

  it('serves authenticated runtime information without ACP', async () => {
    const server = await createTestServer();

    const response = await getJson(server, '/api/runtime', {
      Authorization: 'Bearer test-token',
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      desktop: {
        version: '0.15.2',
        nodeVersion: process.versions.node,
      },
      cli: {
        path: null,
        channel: 'Desktop',
        acpReady: false,
      },
      auth: {
        status: 'unknown',
        account: null,
      },
    });
  });

  it('protects runtime information with the desktop token', async () => {
    const server = await createTestServer();

    const response = await getJson(server, '/api/runtime');

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      ok: false,
      code: 'unauthorized',
    });
  });

  it('returns a typed error when session routes have no ACP client', async () => {
    const server = await createTestServer();

    const response = await getJson(server, '/api/sessions', {
      Authorization: 'Bearer test-token',
    });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      code: 'acp_unavailable',
    });
  });

  it('lists sessions through the ACP client', async () => {
    const acpClient = createAcpClient();
    const server = await createTestServer(acpClient);

    const response = await getJson(
      server,
      '/api/sessions?cwd=%2Frepo&cursor=2&size=5',
      {
        Authorization: 'Bearer test-token',
      },
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      sessions: [{ sessionId: 'session-1', title: 'Test session' }],
      nextCursor: '3',
    });
    expect(acpClient.listSessions).toHaveBeenCalledWith({
      cwd: '/repo',
      cursor: 2,
      size: 5,
    });
  });

  it('creates and loads sessions through the ACP client', async () => {
    const acpClient = createAcpClient();
    const server = await createTestServer(acpClient);

    const created = await postJson(server, '/api/sessions', { cwd: '/repo' });
    const loaded = await postJson(server, '/api/sessions/session-1/load', {
      cwd: '/repo',
    });

    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      ok: true,
      session: { sessionId: 'session-1' },
    });
    expect(loaded.status).toBe(200);
    expect(loaded.body).toMatchObject({
      ok: true,
      session: { models: [] },
    });
    expect(acpClient.newSession).toHaveBeenCalledWith('/repo');
    expect(acpClient.loadSession).toHaveBeenCalledWith('session-1', '/repo');
  });

  it('renames and deletes sessions through ACP extension methods', async () => {
    const acpClient = createAcpClient();
    const server = await createTestServer(acpClient);

    const renamed = await patchJson(server, '/api/sessions/session-1', {
      title: 'Renamed',
      cwd: '/repo',
    });
    const deleted = await deleteJson(
      server,
      '/api/sessions/session-1?cwd=%2Frepo',
    );

    expect(renamed.status).toBe(200);
    expect(deleted.status).toBe(200);
    expect(acpClient.extMethod).toHaveBeenCalledWith('renameSession', {
      sessionId: 'session-1',
      title: 'Renamed',
      cwd: '/repo',
    });
    expect(acpClient.extMethod).toHaveBeenCalledWith('deleteSession', {
      sessionId: 'session-1',
      cwd: '/repo',
    });
  });

  it('validates session JSON request bodies', async () => {
    const acpClient = createAcpClient();
    const server = await createTestServer(acpClient);

    const response = await fetch(`${server.info.url}/api/sessions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: 'not-json',
    });
    const body = (await response.json()) as unknown;

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      ok: false,
      code: 'bad_json',
    });
  });

  it('accepts authenticated session WebSocket connections', async () => {
    const server = await createTestServer(createAcpClient());
    const testSocket = await connectSocket(server, '/ws/session-1');

    expect(await testSocket.readMessage()).toMatchObject({
      type: 'connected',
      sessionId: 'session-1',
    });

    testSocket.socket.send(JSON.stringify({ type: 'ping' }));
    expect(await testSocket.readMessage()).toMatchObject({ type: 'pong' });
    testSocket.socket.close();
  });

  it('sends user messages to ACP prompt over WebSocket', async () => {
    const acpClient = createAcpClient();
    const server = await createTestServer(acpClient);
    const testSocket = await connectSocket(server, '/ws/session-1');
    await testSocket.readMessage();

    testSocket.socket.send(
      JSON.stringify({ type: 'user_message', content: 'hello' }),
    );

    expect(await testSocket.readMessage()).toMatchObject({
      type: 'message_complete',
      stopReason: 'end_turn',
    });
    expect(acpClient.prompt).toHaveBeenCalledWith('session-1', 'hello');
    testSocket.socket.close();
  });

  it('broadcasts normalized ACP session updates over WebSocket', async () => {
    const acpClient = createAcpClient();
    const server = await createTestServer(acpClient);
    const testSocket = await connectSocket(server, '/ws/session-1');
    await testSocket.readMessage();

    acpClient.emitSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'streamed text' },
        _meta: {
          usage: {
            inputTokens: 5,
            outputTokens: 3,
            totalTokens: 8,
          },
        },
      },
    } as SessionNotification);

    expect(await testSocket.readMessage()).toMatchObject({
      type: 'message_delta',
      role: 'assistant',
      text: 'streamed text',
    });
    expect(await testSocket.readMessage()).toMatchObject({
      type: 'usage',
      data: {
        usage: {
          inputTokens: 5,
          outputTokens: 3,
          totalTokens: 8,
        },
      },
    });
    testSocket.socket.close();
  });

  it('broadcasts ACP tool and plan updates only to the matching session', async () => {
    const acpClient = createAcpClient();
    const server = await createTestServer(acpClient);
    const matchingSocket = await connectSocket(server, '/ws/session-1');
    const otherSocket = await connectSocket(server, '/ws/session-2');
    await matchingSocket.readMessage();
    await otherSocket.readMessage();

    acpClient.emitSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Run command',
        kind: 'execute',
        status: 'in_progress',
      },
    } as SessionNotification);
    acpClient.emitSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Wire events', priority: 'medium', status: 'completed' },
        ],
      },
    } as SessionNotification);

    expect(await matchingSocket.readMessage()).toMatchObject({
      type: 'tool_call',
      data: {
        toolCallId: 'tool-1',
        title: 'Run command',
        kind: 'execute',
        status: 'in_progress',
      },
    });
    expect(await matchingSocket.readMessage()).toMatchObject({
      type: 'plan',
      entries: [
        { content: 'Wire events', priority: 'medium', status: 'completed' },
      ],
    });

    otherSocket.socket.send(JSON.stringify({ type: 'ping' }));
    expect(await otherSocket.readMessage()).toMatchObject({ type: 'pong' });
    matchingSocket.socket.close();
    otherSocket.socket.close();
  });

  it('cancels generation over WebSocket', async () => {
    const acpClient = createAcpClient();
    const server = await createTestServer(acpClient);
    const testSocket = await connectSocket(server, '/ws/session-1');
    await testSocket.readMessage();

    testSocket.socket.send(JSON.stringify({ type: 'stop_generation' }));

    expect(await testSocket.readMessage()).toMatchObject({
      type: 'message_complete',
      stopReason: 'cancelled',
    });
    expect(acpClient.cancel).toHaveBeenCalledWith('session-1');
    testSocket.socket.close();
  });

  it('rejects WebSocket connections without the desktop token', async () => {
    const server = await createTestServer(createAcpClient());

    await expect(
      connectSocket(server, '/ws/session-1', 'wrong-token'),
    ).rejects.toThrow();
  });

  it('returns a typed error for unknown authenticated routes', async () => {
    const server = await createTestServer();

    const response = await getJson(server, '/api/missing', {
      Authorization: 'Bearer test-token',
    });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });
});

async function createTestServer(
  acpClient?: AcpSessionClient,
): Promise<DesktopServer> {
  const server = await startDesktopServer({
    token: 'test-token',
    now: () => new Date('2026-04-25T00:00:00.000Z'),
    acpClient,
  });
  servers.push(server);
  return server;
}

async function getJson(
  server: DesktopServer,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${server.info.url}${path}`, { headers });
  return {
    status: response.status,
    body: (await response.json()) as unknown,
  };
}

async function postJson(
  server: DesktopServer,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  return writeJson(server, path, 'POST', body);
}

async function patchJson(
  server: DesktopServer,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  return writeJson(server, path, 'PATCH', body);
}

async function deleteJson(
  server: DesktopServer,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${server.info.url}${path}`, {
    method: 'DELETE',
    headers: {
      Authorization: 'Bearer test-token',
    },
  });
  return {
    status: response.status,
    body: (await response.json()) as unknown,
  };
}

async function writeJson(
  server: DesktopServer,
  path: string,
  method: 'PATCH' | 'POST',
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${server.info.url}${path}`, {
    method,
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as unknown,
  };
}

interface TestAcpClient extends AcpSessionClient {
  emitSessionUpdate(notification: SessionNotification): void;
}

function createAcpClient(): TestAcpClient {
  const client: TestAcpClient = {
    isConnected: true,
    onSessionUpdate: undefined,
    emitSessionUpdate(notification: SessionNotification): void {
      client.onSessionUpdate?.(notification);
    },
    listSessions: vi.fn().mockResolvedValue({
      sessions: [{ sessionId: 'session-1', title: 'Test session' }],
      nextCursor: '3',
    }),
    newSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
    loadSession: vi.fn().mockResolvedValue({ models: [] }),
    prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    cancel: vi.fn().mockResolvedValue(undefined),
    extMethod: vi.fn().mockResolvedValue({ success: true }),
  };
  return client;
}

async function connectSocket(
  server: DesktopServer,
  path: string,
  token = server.info.token,
): Promise<{
  socket: WebSocket;
  readMessage(): Promise<unknown>;
}> {
  const url = new URL(path, server.info.url.replace('http:', 'ws:'));
  url.searchParams.set('token', token);
  const socket = new WebSocket(url);
  const messages: unknown[] = [];
  const messageWaiters: Array<(message: unknown) => void> = [];

  socket.on('message', (data) => {
    const parsed = JSON.parse(data.toString()) as unknown;
    const waiter = messageWaiters.shift();
    if (waiter) {
      waiter(parsed);
    } else {
      messages.push(parsed);
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  return {
    socket,
    readMessage: () => {
      const message = messages.shift();
      if (message) {
        return Promise.resolve(message);
      }

      return new Promise((resolve) => {
        messageWaiters.push(resolve);
      });
    },
  };
}
