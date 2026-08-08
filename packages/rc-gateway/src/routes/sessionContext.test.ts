/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { createSessionContextRoute } from './sessionContext.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

async function mountGateway(daemon: DaemonClient): Promise<string> {
  const app = express();
  app.get('/session/:id/context', createSessionContextRoute(daemon));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const SID = '11111111-1111-1111-1111-111111111111';

describe('GET /session/:id/context', () => {
  it('relays the daemon context status (current model + contextLimit + mode)', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/context`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaceCwd: string;
      state: {
        models: {
          providers: Array<{ models: Array<Record<string, unknown>> }>;
        };
        modes: { currentModeId: string };
      };
    };
    expect(body.workspaceCwd).toBe('/proj');
    const current = body.state.models.providers
      .flatMap((p) => p.models)
      .find((m) => m['isCurrent'] === true);
    expect(current).toMatchObject({
      name: 'Qwen3 Coder 30B',
      contextLimit: 262144,
    });
    expect(body.state.modes.currentModeId).toBe('default');
  });

  it('404s a malformed session id before any daemon call', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/zzz-not-a-valid-id/context`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('session_not_found');
  });

  it('returns 502 when the daemon errors', async () => {
    stub = await startStubDaemon({ contextStatusCode: 500 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/context`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('daemon_unavailable');
  });
});
