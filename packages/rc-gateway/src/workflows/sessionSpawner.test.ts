/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { AgentRegistry } from '../agents/agentRegistry.js';
import { SessionSpawner } from './sessionSpawner.js';

let stub: StubDaemon | undefined;
afterEach(async () => {
  if (stub) await stub.close();
  stub = undefined;
});

describe('SessionSpawner', () => {
  it('spawns a real session per agent and tags workflowRunId', async () => {
    stub = await startStubDaemon({});
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await AgentRegistry.open(join(dir, 'agents.json'));
    const map: Array<{ agentId: string; sessionId: string }> = [];
    const spawner = new SessionSpawner({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
      onAgentSpawned: (agentId, sessionId) => map.push({ agentId, sessionId }),
    });
    const out = await spawner.spawn({
      prompt: 'do a thing',
      systemContext: '',
    });
    expect(typeof out.tokens).toBe('number');
    expect(map).toHaveLength(1);
    expect(registry.list({ workflowRunId: 'run-1' })).toHaveLength(1);
    expect(stub!.createdSessionCount).toBe(1);
  });
});
