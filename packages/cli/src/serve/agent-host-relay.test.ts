/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openAgentHostRelayRun,
  registerAgentHostRelayRoutes,
  relayBaseUrl,
  resetAgentHostRelayForTests,
} from './agent-host-relay.js';

afterEach(() => resetAgentHostRelayForTests());

describe('relayBaseUrl', () => {
  it('reaches the daemon over loopback for loopback and wildcard binds', () => {
    expect(
      relayBaseUrl({ hostname: '127.0.0.1', port: 4170, tls: false }),
    ).toBe('http://127.0.0.1:4170');
    expect(
      relayBaseUrl({ hostname: 'localhost', port: 4170, tls: false }),
    ).toBe('http://127.0.0.1:4170');
    expect(relayBaseUrl({ hostname: '0.0.0.0', port: 4170, tls: false })).toBe(
      'http://127.0.0.1:4170',
    );
    expect(relayBaseUrl({ hostname: '::', port: 4170, tls: false })).toBe(
      'http://[::1]:4170',
    );
  });

  it('offers no relay on a single non-loopback bind, before listen, or under TLS', () => {
    expect(
      relayBaseUrl({ hostname: '192.168.1.5', port: 4170, tls: false }),
    ).toBeUndefined();
    expect(
      relayBaseUrl({ hostname: '127.0.0.1', port: 0, tls: false }),
    ).toBeUndefined();
    expect(
      relayBaseUrl({ hostname: '127.0.0.1', port: 4170, tls: true }),
    ).toBeUndefined();
  });
});

describe('session_send relay route', () => {
  function app() {
    const server = express();
    registerAgentHostRelayRoutes(server, {
      hostname: '127.0.0.1',
      getPort: () => 4170,
      tls: false,
    });
    return server;
  }

  it('pushes the text into the run with the per-run token', async () => {
    const server = app();
    const push = vi.fn();
    const relay = openAgentHostRelayRun('run-1', push)!;
    expect(relay.url).toBe(
      'http://127.0.0.1:4170/agent-host-relay/runs/run-1/send',
    );

    const response = await request(server)
      .post('/agent-host-relay/runs/run-1/send')
      .set('Authorization', `Bearer ${relay.token}`)
      .send({ text: '@codex-mac please check' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(push).toHaveBeenCalledWith('@codex-mac please check');
  });

  it('refuses a wrong token, another run, an empty text and a closed run', async () => {
    const server = app();
    const push = vi.fn();
    const relay = openAgentHostRelayRun('run-1', push)!;
    openAgentHostRelayRun('run-2', vi.fn());
    const send = (runId: string, token: string, text: unknown) =>
      request(server)
        .post(`/agent-host-relay/runs/${runId}/send`)
        .set('Authorization', `Bearer ${token}`)
        .send({ text });

    expect((await send('run-1', 'x'.repeat(43), 'hi')).status).toBe(401);
    expect((await send('run-2', relay.token, 'hi')).status).toBe(401);
    expect((await send('run-1', relay.token, '  ')).status).toBe(400);
    // Longer than the record writer takes: refused here, not reported as sent.
    expect((await send('run-1', relay.token, 'x'.repeat(65_537))).status).toBe(
      400,
    );
    relay.close();
    expect((await send('run-1', relay.token, 'hi')).status).toBe(401);
    expect(push).not.toHaveBeenCalled();
  });

  it('has no relay before the route is mounted', () => {
    expect(openAgentHostRelayRun('run-1', vi.fn())).toBeUndefined();
  });
});
