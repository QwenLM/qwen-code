/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  buildDiscordHealthReport,
  initialDiscordHealthState,
  startDiscordHealthServer,
  type DiscordHealthServer,
} from './health.js';

describe('buildDiscordHealthReport', () => {
  it('ok is true only when BOTH daemonReachable AND gatewayConnected', () => {
    const ctx = { startedAtMs: 0, nowMs: 5_000 };

    const both = buildDiscordHealthReport(
      {
        registeredId: 'discord',
        daemonReachable: true,
        gatewayConnected: true,
      },
      ctx,
    );
    expect(both.ok).toBe(true);

    const onlyDaemon = buildDiscordHealthReport(
      {
        registeredId: 'discord',
        daemonReachable: true,
        gatewayConnected: false,
      },
      ctx,
    );
    expect(onlyDaemon.ok).toBe(false);

    const onlyGateway = buildDiscordHealthReport(
      {
        registeredId: 'discord',
        daemonReachable: false,
        gatewayConnected: true,
      },
      ctx,
    );
    expect(onlyGateway.ok).toBe(false);

    const neither = buildDiscordHealthReport(initialDiscordHealthState(), ctx);
    expect(neither.ok).toBe(false);
  });

  it('returns the spec shape with computed uptime', () => {
    const r = buildDiscordHealthReport(
      {
        registeredId: 'discord',
        daemonReachable: true,
        gatewayConnected: true,
      },
      { startedAtMs: 1_000, nowMs: 8_500 },
    );
    expect(r).toEqual({
      ok: true,
      daemonReachable: true,
      gatewayConnected: true,
      registeredId: 'discord',
      uptimeSec: 7, // floor((8500-1000)/1000)
    });
  });

  it('initialDiscordHealthState starts with all flags false', () => {
    const s = initialDiscordHealthState();
    expect(s.daemonReachable).toBe(false);
    expect(s.gatewayConnected).toBe(false);
    expect(s.registeredId).toBeNull();
  });
});

describe('startDiscordHealthServer (live loopback server)', () => {
  let server: DiscordHealthServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('serves GET /healthz as JSON and reflects live state changes', async () => {
    const state = initialDiscordHealthState();
    state.registeredId = 'discord';
    state.daemonReachable = true;
    server = await startDiscordHealthServer(0, () =>
      buildDiscordHealthReport(state, { startedAtMs: 0, nowMs: 5_000 }),
    );
    expect(server.port).toBeGreaterThan(0);
    const url = `http://127.0.0.1:${server.port}/healthz`;

    const r1 = await fetch(url);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('content-type')).toContain('application/json');
    const body1 = await r1.json();
    expect(body1).toMatchObject({
      ok: false, // gatewayConnected still false
      daemonReachable: true,
      gatewayConnected: false,
      registeredId: 'discord',
    });

    // Gateway connects → ok flips true.
    state.gatewayConnected = true;
    const body2 = await (await fetch(url)).json();
    expect(body2.ok).toBe(true);
    expect(body2.gatewayConnected).toBe(true);
  });

  it('returns 404 for any non-/healthz path', async () => {
    server = await startDiscordHealthServer(0, () =>
      buildDiscordHealthReport(initialDiscordHealthState(), {
        startedAtMs: 0,
        nowMs: 0,
      }),
    );
    const r = await fetch(`http://127.0.0.1:${server.port}/nope`);
    expect(r.status).toBe(404);
  });

  it('does NOT crash when the port is already taken (returns a no-op handle)', async () => {
    const report = () =>
      buildDiscordHealthReport(initialDiscordHealthState(), {
        startedAtMs: 0,
        nowMs: 0,
      });
    server = await startDiscordHealthServer(0, report);
    const taken = server.port;
    const second = await startDiscordHealthServer(taken, report);
    expect(second.port).toBe(0);
    await second.close(); // no-op, must not throw
  });
});
