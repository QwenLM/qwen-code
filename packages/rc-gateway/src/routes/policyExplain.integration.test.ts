/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end proof for `POST /policy/explain` (P4), mounted through the REAL
 * `createGatewayApp` (real TokenStore/PairingService/requireScope(OWNER)
 * mount, real stub daemon over HTTP — though this route never calls the
 * daemon). There is no way to inject a policy through `createGatewayApp`
 * other than the `policyExplain` dep bundle itself (cli.ts wires it from a
 * hot-reloaded `let currentPolicy`); this test hand-builds that bundle
 * around a static `Policy` with one tool-matching deny rule, mirroring the
 * harness shapes in `approvalMode.integration.test.ts` (the authoritative
 * precedent for `startStubDaemon`/`TokenStore.open`/`.issue`/
 * `createGatewayApp`/server `.listen`).
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DaemonClient } from '@qwen-code/sdk';
import { createGatewayApp } from '../server.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import type { Policy } from '../policy/loader.js';

const POLICY: Policy = {
  defaults: { action: 'prompt', requireScope: 'approve' },
  rules: [
    {
      id: 'deny-write',
      match: { tool: 'write_file' },
      action: 'deny',
      reason: 'no writes',
    },
    {
      id: 'deny-etc',
      match: { pathGlob: '**/passwd' },
      action: 'deny',
      reason: 'no reads of secrets',
    },
  ],
};

let server: Server | undefined;
let runtimeBase: string;
let stub: StubDaemon | undefined;

async function boot() {
  runtimeBase = await mkdtemp(join(tmpdir(), 'p4-policy-explain-'));
  stub = await startStubDaemon();
  const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
  const store = await TokenStore.open(join(runtimeBase, 'tokens.json'));
  const { token: owner } = await store.issue(['owner'], 'o');
  const { token: writer } = await store.issue(['write'], 'w');
  const gw = createGatewayApp({
    daemon,
    store,
    pairing: new PairingService(),
    auditPath: join(runtimeBase, 'audit.log'),
    policyExplain: {
      policy: () => POLICY,
      projectRoot: () => runtimeBase,
      quotaOracle: () => undefined,
    },
  });
  server = await new Promise<Server>((resolve) => {
    const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/policy/explain`;
  return { owner, writer, url };
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  if (stub) await stub.close();
  stub = undefined;
  if (runtimeBase) await rm(runtimeBase, { recursive: true, force: true });
});

describe('POST /policy/explain (integration)', () => {
  it('owner gets a full trace; the response never echoes the caller path', async () => {
    const { owner, url } = await boot();
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${owner}`,
      },
      body: JSON.stringify({ tool: 'write_file', path: '/etc/secret-xyz' }),
    });
    expect(r.status).toBe(200);
    const out = (await r.json()) as {
      decision: { action: string };
      trace: unknown[];
    };
    expect(out.decision.action).toBe('deny');
    expect(out.trace.length).toBeGreaterThan(0);
    // metadata safety: no field reflects the simulated path back
    expect(JSON.stringify(out)).not.toContain('/etc/secret-xyz');
  });

  it('a pathGlob-matched rule classifies the path but never echoes it', async () => {
    const { owner, url } = await boot();
    const securedPath = join(runtimeBase, 'secret', 'passwd');
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${owner}`,
      },
      body: JSON.stringify({ tool: 'read_file', path: securedPath }),
    });
    expect(r.status).toBe(200);
    const out = (await r.json()) as {
      decision: { action: string; ruleId?: string };
      trace: unknown[];
    };
    expect(out.decision.action).toBe('deny');
    expect(out.decision.ruleId).toBe('deny-etc');
    // metadata safety: the path is classified (matched via pathGlob) but
    // the sent path string is never echoed back in the response.
    expect(JSON.stringify(out)).not.toContain(securedPath);
  });

  it('rejects a write-scope token with 403', async () => {
    const { writer, url } = await boot();
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${writer}`,
      },
      body: JSON.stringify({ tool: 'write_file' }),
    });
    expect(r.status).toBe(403);
  });
});
