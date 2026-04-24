/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { startDesktopServer } from './index.js';
import type { DesktopServer } from './types.js';

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

async function createTestServer(): Promise<DesktopServer> {
  const server = await startDesktopServer({
    token: 'test-token',
    now: () => new Date('2026-04-25T00:00:00.000Z'),
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
