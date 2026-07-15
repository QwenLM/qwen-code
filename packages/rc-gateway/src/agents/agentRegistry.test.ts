/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry, TERMINAL_AGENT_STATUSES } from './agentRegistry.js';

async function tmpStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agents-'));
  return join(dir, 'agents.json');
}

describe('AgentRegistry', () => {
  it('registers a running agent with a uuid and truncated task', async () => {
    const reg = await AgentRegistry.open(await tmpStorePath());
    const rec = await reg.register({
      sessionId: 's1',
      parentSessionId: null,
      agentType: 'general',
      task: 'x'.repeat(3000),
      spawnedByTokenId: 'tkn1',
    });
    expect(rec.agentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec.status).toBe('running');
    expect(rec.task.length).toBe(2000);
    expect(rec.finishedAt).toBeNull();
    expect(reg.get(rec.agentId)).toEqual(rec);
  });

  it('persists across reopen', async () => {
    const path = await tmpStorePath();
    const reg = await AgentRegistry.open(path);
    const rec = await reg.register({
      sessionId: 's1',
      parentSessionId: 'p1',
      agentType: 'general',
      task: 'do a thing',
      spawnedByTokenId: 'tkn1',
    });
    const reopened = await AgentRegistry.open(path);
    expect(reopened.get(rec.agentId)?.sessionId).toBe('s1');
    expect(reopened.get(rec.agentId)?.parentSessionId).toBe('p1');
  });

  it('setStatus stamps finishedAt on terminal and refuses re-transition', async () => {
    const reg = await AgentRegistry.open(await tmpStorePath());
    const rec = await reg.register({
      sessionId: 's1',
      parentSessionId: null,
      agentType: 'general',
      task: 't',
      spawnedByTokenId: 'tkn1',
    });
    expect(await reg.setStatus(rec.agentId, 'blocked')).toBe(true);
    expect(reg.get(rec.agentId)?.finishedAt).toBeNull();
    expect(await reg.setStatus(rec.agentId, 'cancelled')).toBe(true);
    expect(reg.get(rec.agentId)?.finishedAt).not.toBeNull();
    // Terminal → any further transition is a no-op.
    expect(await reg.setStatus(rec.agentId, 'failed')).toBe(false);
    expect(reg.get(rec.agentId)?.status).toBe('cancelled');
    expect(TERMINAL_AGENT_STATUSES.has('cancelled')).toBe(true);
  });

  it('list filters by status and parent', async () => {
    const reg = await AgentRegistry.open(await tmpStorePath());
    const a = await reg.register({
      sessionId: 's1',
      parentSessionId: 'p1',
      agentType: 'general',
      task: 'a',
      spawnedByTokenId: 'tkn1',
    });
    await reg.register({
      sessionId: 's2',
      parentSessionId: null,
      agentType: 'general',
      task: 'b',
      spawnedByTokenId: 'tkn1',
    });
    await reg.setStatus(a.agentId, 'completed');
    expect(reg.list({ status: 'completed' }).map((r) => r.agentId)).toEqual([
      a.agentId,
    ]);
    expect(reg.list({ parent: 'p1' })).toHaveLength(1);
    expect(reg.list()).toHaveLength(2);
  });

  it('reconcile orphans running/blocked records whose session is gone', async () => {
    const reg = await AgentRegistry.open(await tmpStorePath());
    const gone = await reg.register({
      sessionId: 's-gone',
      parentSessionId: null,
      agentType: 'general',
      task: 't',
      spawnedByTokenId: 'tkn1',
    });
    const live = await reg.register({
      sessionId: 's-live',
      parentSessionId: null,
      agentType: 'general',
      task: 't',
      spawnedByTokenId: 'tkn1',
    });
    const done = await reg.register({
      sessionId: 's-done',
      parentSessionId: null,
      agentType: 'general',
      task: 't',
      spawnedByTokenId: 'tkn1',
    });
    await reg.setStatus(done.agentId, 'completed');

    const orphaned = await reg.reconcile(['s-live']);
    expect(orphaned).toEqual([gone.agentId]);
    expect(reg.get(gone.agentId)?.status).toBe('orphaned');
    expect(reg.get(live.agentId)?.status).toBe('running');
    // Terminal records are untouched even though their session is gone.
    expect(reg.get(done.agentId)?.status).toBe('completed');
  });

  it('findBySessionId prefers the non-terminal record', async () => {
    const reg = await AgentRegistry.open(await tmpStorePath());
    const old = await reg.register({
      sessionId: 's1',
      parentSessionId: null,
      agentType: 'general',
      task: 't',
      spawnedByTokenId: 'tkn1',
    });
    await reg.setStatus(old.agentId, 'failed');
    const fresh = await reg.register({
      sessionId: 's1',
      parentSessionId: null,
      agentType: 'general',
      task: 't2',
      spawnedByTokenId: 'tkn1',
    });
    expect(reg.findBySessionId('s1')?.agentId).toBe(fresh.agentId);
  });
});
