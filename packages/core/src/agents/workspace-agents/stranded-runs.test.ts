/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../../config/storage.js';
import {
  createThread,
  getAgentsDir,
  readThread,
  updateWorkspaceAgents,
  writeThread,
} from './store.js';
import { STRANDED_FAILURE_STAGE, strandLocalRuns } from './stranded-runs.js';
import type { ThreadRun } from './types.js';

const PROJECT_ROOT = '/stranded-runs-test';

function run(overrides: Partial<ThreadRun>): ThreadRun {
  return {
    id: 'rn_1',
    agentId: 'ag_alice',
    status: 'running',
    triggerMessageIds: [],
    acceptedMessageIds: [],
    consumedMessageIds: [],
    usageByRound: [],
    queueSequence: 100,
    queuedAt: 1,
    attempts: 1,
    ...overrides,
  };
}

describe('strandLocalRuns', () => {
  let runtimeDir: string;

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stranded-runs-'));
    Storage.setRuntimeBaseDir(runtimeDir);
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  it('writes nothing into a workspace that never used collaboration', async () => {
    await expect(strandLocalRuns(PROJECT_ROOT)).resolves.toEqual({
      threadsChanged: 0,
      runsStranded: 0,
    });
    await expect(fs.stat(getAgentsDir(PROJECT_ROOT))).rejects.toThrow();
  });

  it('strands live runs, settles the thread status, and is idempotent', async () => {
    await updateWorkspaceAgents(PROJECT_ROOT, () => [
      { id: 'ag_alice', name: 'alice', createdAt: 1 },
    ]);
    const parked = await createThread(PROJECT_ROOT, { title: 'Parked' });
    await writeThread(PROJECT_ROOT, {
      ...parked,
      status: 'in_progress',
      runs: [run({})],
    });
    const waiting = await createThread(PROJECT_ROOT, { title: 'Waiting' });
    await writeThread(PROJECT_ROOT, {
      ...waiting,
      status: 'in_progress',
      runs: [run({ id: 'rn_2', status: 'queued', queueSequence: 101 })],
    });

    await expect(strandLocalRuns(PROJECT_ROOT)).resolves.toEqual({
      threadsChanged: 1,
      runsStranded: 1,
    });
    const stored = await readThread(PROJECT_ROOT, parked.id);
    // Left `in_progress`, nothing would ever tell a person a decision is owed.
    expect(stored?.status).toBe('blocked');
    expect(stored?.runs[0]).toMatchObject({
      status: 'failed',
      closeKind: 'stranded',
      failureStage: STRANDED_FAILURE_STAGE,
    });
    // A queued run has no orphaned body; it waits for the opt-in to return.
    const untouched = await readThread(PROJECT_ROOT, waiting.id);
    expect(untouched?.runs[0]?.status).toBe('queued');

    await expect(strandLocalRuns(PROJECT_ROOT)).resolves.toEqual({
      threadsChanged: 0,
      runsStranded: 0,
    });
  });

  it('settles a run that was being cancelled as cancelled', async () => {
    await updateWorkspaceAgents(PROJECT_ROOT, () => [
      { id: 'ag_alice', name: 'alice', createdAt: 1 },
    ]);
    const created = await createThread(PROJECT_ROOT, { title: 'Withdrawn' });
    await writeThread(PROJECT_ROOT, {
      ...created,
      status: 'in_progress',
      runs: [run({ status: 'cancelling' })],
    });

    await expect(strandLocalRuns(PROJECT_ROOT)).resolves.toEqual({
      threadsChanged: 1,
      runsStranded: 0,
    });
    const stored = await readThread(PROJECT_ROOT, created.id);
    expect(stored?.runs[0]?.status).toBe('cancelled');
    expect(stored?.runs[0]?.closeKind).toBeUndefined();
  });
});
