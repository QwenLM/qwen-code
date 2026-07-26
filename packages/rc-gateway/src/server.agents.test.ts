/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@qwen-code/sdk';
import { createGatewayApp, type GatewayApp } from './server.js';
import { TokenStore } from './tokenStore.js';
import { PairingService } from './pairing.js';
import { AgentRegistry } from './agents/agentRegistry.js';
import { PromptEventBroadcaster } from './routes/promptEventBroadcaster.js';
import { startStubDaemon, type StubDaemon } from './testing/stubDaemon.js';
import { BRIDGE, expandScopes } from './scopes.js';

let server: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (stub) await stub.close();
  server = undefined;
  stub = undefined;
});

async function setup(subActorCap?: number) {
  stub = await startStubDaemon({ promptDelayMs: 2000 });
  const dir = await mkdtemp(join(tmpdir(), 'srv-agents-'));
  const store = await TokenStore.open(join(dir, 'tokens.json'));
  const writeTok = (await store.issue(['write', 'session:read'], 'w')).token;
  const readTok = (await store.issue(['session:read'], 'r')).token;
  const ownerTok = (await store.issue(['owner'], 'o')).token;
  // Bridge scope materializes to {bridge, session:read, approve, write} —
  // the concrete bundle a real bridge redeems (pair.ts/tokens.ts apply
  // expandScopes at issue time; TokenStore.issue itself does not, so it's
  // applied explicitly here to mirror a real bridge token's scope set).
  const bridgeTok = (await store.issue(expandScopes([BRIDGE]), 'bridge-1'))
    .token;
  const registry = await AgentRegistry.open(join(dir, 'agents.json'));
  const gw: GatewayApp = createGatewayApp({
    daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
    store,
    pairing: new PairingService(),
    auditPath: join(dir, 'audit.log'),
    agents: { registry, costFor: () => 7777, promptAcceptWindowMs: 25 },
    subActorCap,
  });
  server = await new Promise((resolve) => {
    const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server!.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    gw,
    registry,
    writeTok,
    readTok,
    ownerTok,
    bridgeTok,
  };
}

/** Ban `subActor` on the bridge identified by `bridgeId` (owner-only route). */
async function banSubActor(
  url: string,
  ownerTok: string,
  bridgeId: string,
  subActor: string,
): Promise<void> {
  const res = await fetch(`${url}/rc/bridges/${bridgeId}/ban`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ subActor }),
  });
  expect(res.status).toBe(200);
}

describe('agent observability wiring', () => {
  it('mounts the /rc/agents routes with scope gates and cost rollup', async () => {
    const { url, registry, writeTok, readTok } = await setup();

    // No token → 401 from bearerResolve.
    expect((await fetch(`${url}/rc/agents`)).status).toBe(401);

    // read-scope token cannot spawn → 403 scope_required.
    const denied = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${readTok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ task: 't' }),
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe(
      'scope_required',
    );

    // write-scope spawn → 201, registered.
    const spawn = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${writeTok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ task: 't' }),
    });
    expect(spawn.status).toBe(201);
    const { agentId } = (await spawn.json()) as { agentId: string };
    expect(registry.get(agentId)?.status).toBe('running');

    // read-scope list → 200 with the read-time cost rollup.
    const list = await fetch(`${url}/rc/agents`, {
      headers: { Authorization: `Bearer ${readTok}` },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      agents: Array<{ costMicrocents?: number }>;
    };
    expect(body.agents[0].costMicrocents).toBe(7777);
  });

  it('returns promptEvents and agentLifecycle on the GatewayApp handle', async () => {
    const { gw } = await setup();
    expect(gw.promptEvents).toBeInstanceOf(PromptEventBroadcaster);
    expect(gw.agentLifecycle).toBeDefined();
  });
});

// Defense-in-depth (latent hardening, not a live exploit — a leaked bridge
// token or a future feature could reach these): every bridge-token-reachable
// mutation route must enforce the owner's sub-actor ban, not just prompt/vote.
// /rc/agents (spawn, a resource-creating route) also gets the per-sub-actor
// rate limiter; /rc/agents/:id/cancel (a stop route) gets ban only — a user
// must always be able to stop runaway work even under rate pressure.
describe('sub-actor ban on the agent routes', () => {
  it('403s sub_actor_banned for a banned sub-actor spawning via POST /rc/agents', async () => {
    const { url, ownerTok, bridgeTok } = await setup();
    await banSubActor(url, ownerTok, 'telegram', 'telegram:evil');

    const res = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bridgeTok}`,
        'Content-Type': 'application/json',
        'X-RC-SubActor': 'telegram:evil',
      },
      body: JSON.stringify({ task: 't' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      'sub_actor_banned',
    );
  });

  it('still spawns for a non-banned bridge sub-actor and a plain write token (no regression)', async () => {
    const { url, writeTok, ownerTok, bridgeTok } = await setup();
    // Ban a DIFFERENT sub-actor — must not affect anyone else.
    await banSubActor(url, ownerTok, 'telegram', 'telegram:evil');

    const okBridge = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bridgeTok}`,
        'Content-Type': 'application/json',
        'X-RC-SubActor': 'telegram:alice',
      },
      body: JSON.stringify({ task: 't' }),
    });
    expect(okBridge.status).toBe(201);

    // A plain write token (no sub-actor asserted) is never sub-actor-gated.
    const okWrite = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${writeTok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ task: 't' }),
    });
    expect(okWrite.status).toBe(201);
  });

  it('403s sub_actor_banned for a banned sub-actor on POST /rc/agents/:id/cancel (ban applies; never rate-limited)', async () => {
    const { url, writeTok, ownerTok, bridgeTok } = await setup();
    // Spawn with an unbanned/no sub-actor caller so the cancel target exists.
    const spawn = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${writeTok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ task: 't' }),
    });
    expect(spawn.status).toBe(201);
    const { agentId } = (await spawn.json()) as { agentId: string };

    await banSubActor(url, ownerTok, 'telegram', 'telegram:evil');
    const cancel = await fetch(`${url}/rc/agents/${agentId}/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bridgeTok}`,
        'Content-Type': 'application/json',
        'X-RC-SubActor': 'telegram:evil',
      },
    });
    expect(cancel.status).toBe(403);
    expect(((await cancel.json()) as { code: string }).code).toBe(
      'sub_actor_banned',
    );
  });

  it('still cancels for a plain write token on POST /rc/agents/:id/cancel (no regression)', async () => {
    const { url, writeTok } = await setup();
    const spawn = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${writeTok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ task: 't' }),
    });
    const { agentId } = (await spawn.json()) as { agentId: string };

    const cancel = await fetch(`${url}/rc/agents/${agentId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${writeTok}` },
    });
    expect(cancel.status).toBe(200);
  });
});

// The 9 routes now sharing enforceSubActorRateLimit (2 pre-existing + 7 newly
// mounted here) all draw from ONE per-sub-actor SubActorRateLimiter instance
// (server.ts's subActorLimiter). A small injected cap makes the interaction
// observable without 30 real requests (DEFAULT_SUB_ACTOR_CAP).
describe('sub-actor rate limit on the agent routes', () => {
  it('429s sub_actor_rate_limited on POST /rc/agents once a bridge sub-actor exceeds the cap', async () => {
    const { url, bridgeTok } = await setup(1);
    const spawnAs = () =>
      fetch(`${url}/rc/agents`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bridgeTok}`,
          'Content-Type': 'application/json',
          'X-RC-SubActor': 'telegram:alice',
        },
        body: JSON.stringify({ task: 't' }),
      });
    const first = await spawnAs();
    expect(first.status).toBe(201);
    const second = await spawnAs();
    expect(second.status).toBe(429);
    expect(((await second.json()) as { code: string }).code).toBe(
      'sub_actor_rate_limited',
    );
  });

  it('still cancels via POST /rc/agents/:id/cancel for a bridge sub-actor who has exhausted the rate budget (design intent: stopping is never rate-limited)', async () => {
    const { url, writeTok, bridgeTok } = await setup(1);
    // Spawn with a plain write token (uncapped) so the agent exists...
    const spawn = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${writeTok}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ task: 't' }),
    });
    const { agentId } = (await spawn.json()) as { agentId: string };

    // ...then exhaust telegram:bob's cap=1 budget on a rate-limited route.
    const spend = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bridgeTok}`,
        'Content-Type': 'application/json',
        'X-RC-SubActor': 'telegram:bob',
      },
      body: JSON.stringify({ task: 't' }),
    });
    expect(spend.status).toBe(201);
    const overCap = await fetch(`${url}/rc/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bridgeTok}`,
        'Content-Type': 'application/json',
        'X-RC-SubActor': 'telegram:bob',
      },
      body: JSON.stringify({ task: 't' }),
    });
    expect(overCap.status).toBe(429); // confirms the budget is actually spent

    // Cancel (never rate-limited by design) still succeeds for the SAME
    // exhausted sub-actor.
    const cancel = await fetch(`${url}/rc/agents/${agentId}/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bridgeTok}`,
        'X-RC-SubActor': 'telegram:bob',
      },
    });
    expect(cancel.status).toBe(200);
  });
});
