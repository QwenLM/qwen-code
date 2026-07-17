/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from './agentRegistry.js';

describe('AgentRegistry workflowRunId', () => {
  it('stores and filters by workflowRunId', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wf-reg-'));
    const reg = await AgentRegistry.open(join(dir, 'agents.json'));
    const a = await reg.register({
      sessionId: 's1',
      parentSessionId: null,
      agentType: 'general',
      task: 't',
      spawnedByTokenId: 'tk',
      workflowRunId: 'run-1',
    });
    await reg.register({
      sessionId: 's2',
      parentSessionId: null,
      agentType: 'general',
      task: 't',
      spawnedByTokenId: 'tk',
    });
    expect(reg.get(a.agentId)?.workflowRunId).toBe('run-1');
    expect(reg.list({ workflowRunId: 'run-1' }).map((r) => r.agentId)).toEqual([
      a.agentId,
    ]);
  });
});
