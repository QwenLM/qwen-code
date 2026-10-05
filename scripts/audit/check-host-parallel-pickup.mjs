// Run: node --import tsx scripts/audit/check-host-parallel-pickup.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../../packages/core/src/config/storage.ts';
import { createThread, readThread, updateWorkspaceAgents } from '../../packages/core/src/agents/workspace-agents/store.ts';
import { postMessage } from '../../packages/core/src/agents/workspace-agents/thread-actions.ts';
import { pickupRunForHost, DEFAULT_RUN_LEASE_MS } from '../../packages/core/src/agents/workspace-agents/host-lease.ts';
import { HUMAN_AUTHOR_ID } from '../../packages/core/src/agents/workspace-agents/types.ts';

const expectSerial = process.argv.includes('--expect-serial');
for (const limit of [100, 1]) {
  const dir = await mkdtemp(join(tmpdir(), 'host-pickup-check-'));
  const root = '/host-pickup-check';
  const now = Date.now();
  try {
    Storage.setRuntimeBaseDir(dir);
    await updateWorkspaceAgents(root, () => [{
      id: 'ag_alice', name: 'alice', createdAt: 1,
      maxConcurrentRuns: limit,
      execution: { mode: 'managed-host', hostIds: ['host_check'] },
    }]);
    const threads = [];
    for (const title of ['first', 'second']) {
      const thread = await createThread(root, { title });
      await postMessage(root, thread.id, { from: HUMAN_AUTHOR_ID, text: '@alice work' });
      threads.push(thread.id);
    }
    const first = await pickupRunForHost(root, 'host_check', now);
    assert.ok(first);
    const second = await pickupRunForHost(root, 'host_check', now + 1, [first.runId]);
    if (expectSerial) {
      assert.equal(second?.runId, first.runId);
    } else if (limit === 100) {
      assert.ok(second);
      assert.notEqual(second.runId, first.runId);
      assert.equal(await pickupRunForHost(root, 'host_check', now + 2, [first.runId, second.runId]), undefined);
      // Active client work must not be reclaimed even when its lease expires.
      assert.equal(await pickupRunForHost(root, 'host_check', now + DEFAULT_RUN_LEASE_MS + 2, [first.runId, second.runId]), undefined);
    } else {
      assert.equal(second, undefined);
    }
    const retry = await pickupRunForHost(root, 'host_check', now + 3);
    const held = [first, second].find(run => run?.runId === retry?.runId);
    assert.ok(held);
    assert.equal(retry.lease.leaseId, held.lease.leaseId);
    const runs = (await Promise.all(threads.map(id => readThread(root, id)))).flatMap(t => t.runs);
    assert.equal(runs.length, 2);
    const running = runs.filter(run => run.status === 'running').length;
    assert.equal(running, !expectSerial && limit === 100 ? 2 : 1);
    console.log(JSON.stringify({ limit, expectSerial, first: first.runId, second: second?.runId ?? null, running, queued: 2 - running, omittedActiveIdsRetriesSameLease: true }));
  } finally {
    Storage.setRuntimeBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
}
