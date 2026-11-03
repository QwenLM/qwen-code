/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import * as os from 'node:os';
import { RemoteAccessService } from './remote-access.js';
import { CredentialStore } from './local-control/credentials.js';
import {
  allowOriginCors,
  bearerAuth,
  hostAllowlist,
  MutableOriginAllowlist,
  parseAllowOriginPatterns,
} from './auth.js';
import { registerRemoteAccessRoutes } from './routes/remote-access.js';

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  networkInterfaces: vi.fn(),
}));

let primary: Server;
let service: RemoteAccessService;
let local: string;
const session = { id: 'existing-session', progress: 0 };

beforeEach(async () => {
  vi.mocked(os.networkInterfaces).mockReturnValue({
    test: [
      {
        address: '127.0.0.1',
        family: 'IPv4',
        internal: false,
        netmask: '255.0.0.0',
        mac: '00:00:00:00:00:00',
        cidr: '127.0.0.1/8',
      },
    ],
  });
  const app = express();
  const credentials = new CredentialStore();
  primary = createServer(app);
  await new Promise<void>((resolve) => primary.listen(0, '127.0.0.1', resolve));
  const port = (primary.address() as { port: number }).port;
  local = `http://127.0.0.1:${port}`;
  app.use(hostAllowlist('127.0.0.1', () => port));
  app.use(
    allowOriginCors(new MutableOriginAllowlist(parseAllowOriginPatterns([]))),
  );
  app.use(bearerAuth(credentials));
  app.use(express.json());
  app.get('/session', (_req, res) => res.json(session));
  service = new RemoteAccessService({
    app,
    credentials,
    getPort: () => port,
    attachWebSocket: () => {},
    detachWebSocket: () => {},
  });
  registerRemoteAccessRoutes(app, {
    service,
    primaryHostname: '127.0.0.1',
    trustedLoopbackMode: true,
    mutate: () => (_req, _res, next) => next(),
  });
});

afterEach(async () => {
  await service.dispose();
  primary.closeAllConnections();
  await new Promise<void>((resolve) => primary.close(() => resolve()));
  vi.restoreAllMocks();
});

async function manage(action: string, body: object = {}) {
  return fetch(`${local}/remote-access/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

it('enables the same application through local management and revokes only remote access', async () => {
  expect(service.status().active).toBe(false);
  const enabled = await (await manage('enable', { port: 0 })).json();
  expect(enabled.active).toBe(true);
  expect(enabled.token).toBeUndefined();
  const { token } = await (await manage('reveal')).json();
  const origin = 'http://localhost:5273';
  const remote = (secret: string) =>
    fetch(`${enabled.url}/session`, {
      headers: { Origin: origin, Authorization: `Bearer ${secret}` },
    });
  expect((await remote('wrong')).status).toBe(401);
  const response = await remote(token);
  expect(response.headers.get('access-control-allow-origin')).toBe(origin);
  expect(await response.json()).toEqual(session);
  const denied = await fetch(`${enabled.url}/remote-access/disable`, {
    method: 'POST',
    headers: { Origin: origin, Authorization: `Bearer ${token}` },
  });
  expect(denied.status).toBe(403);
  const reset = await (await manage('reset-token')).json();
  expect(reset.token).not.toBe(token);
  expect((await remote(token)).status).toBe(401);
  expect((await remote(reset.token)).status).toBe(200);
  await manage('disable');
  expect(service.status().active).toBe(false);
  session.progress += 1;
  expect(await (await fetch(`${local}/session`)).json()).toEqual(session);
  await expect(remote(reset.token)).rejects.toThrow();
});

it('refuses collisions without changing the local listener or selecting another port', async () => {
  const response = await manage('enable');
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe('EADDRINUSE');
  expect(service.status().active).toBe(false);
  expect((await fetch(`${local}/session`)).status).toBe(200);
});

it('handles preflight and exact custom origins without allowing unrelated pages', async () => {
  const { url } = await (await manage('enable', { port: 0 })).json();
  const { token } = await (await manage('reveal')).json();
  const probe = (origin: string) =>
    fetch(`${url}/session`, {
      headers: { Origin: origin, Authorization: `Bearer ${token}` },
    });
  const preflight = await fetch(`${url}/session`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://127.0.0.1:54321',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers':
        'authorization, acp-connection-id, acp-session-id',
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-methods')).toContain(
    'PUT',
  );
  expect(preflight.headers.get('access-control-allow-headers')).toContain(
    'Acp-Connection-Id',
  );
  expect(preflight.headers.get('access-control-allow-headers')).toContain(
    'Acp-Session-Id',
  );
  expect((await probe('https://shell.example')).status).toBe(403);
  await manage('origins', { origins: ['https://shell.example'] });
  expect((await probe('https://shell.example')).status).toBe(200);
  expect((await probe('https://unrelated.example')).status).toBe(403);
  expect((await probe('null')).status).toBe(403);
  expect((await manage('origins', { origins: ['*'] })).status).toBe(409);
});
