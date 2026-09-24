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
  AGENT_PROGRAM_UNAVAILABLE,
  DEFAULT_RUN_LEASE_MS,
  applyHostRunResult,
  parseHostRunSteps,
  pickupRunForHost,
  renewRunLease,
  reportHostRunProgress,
} from './host-lease.js';
import {
  createThread,
  enrollAgentHost,
  issueAgentHostEnrollment,
  readThread,
  updateWorkspaceAgents,
  writeThread,
} from './store.js';
import {
  AGENT_PROGRAM_LABELS,
  type AgentProgram,
  type ThreadRun,
  type WorkspaceAgent,
} from './types.js';

const PROJECT_ROOT = '/host-lease-test';
const T0 = 1_000_000;

let runtimeDir: string;

beforeEach(async () => {
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-lease-test-'));
  Storage.setRuntimeBaseDir(runtimeDir);
});

afterEach(async () => {
  Storage.setRuntimeBaseDir(null);
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

async function host(name: string, programs: AgentProgram[]) {
  const { token } = await issueAgentHostEnrollment(PROJECT_ROOT);
  const { host: enrolled } = await enrollAgentHost(PROJECT_ROOT, {
    token,
    name,
    workspaceCwd: `/work/${name}`,
    providers: programs.map((program) => AGENT_PROGRAM_LABELS[program]),
  });
  return enrolled.id;
}

async function placeAgent(hostIds: string[], provider?: AgentProgram) {
  const agent: WorkspaceAgent = {
    id: 'ag_remote',
    name: 'remote',
    createdAt: 1,
    execution: {
      mode: 'managed-host',
      hostIds,
      ...(provider ? { provider } : {}),
    },
  };
  await updateWorkspaceAgents(PROJECT_ROOT, () => [agent]);
}

function queuedRun(): ThreadRun {
  return {
    id: 'rn_1',
    agentId: 'ag_remote',
    status: 'queued',
    triggerMessageIds: [],
    acceptedMessageIds: [],
    consumedMessageIds: [],
    usageByRound: [],
    queueSequence: 1,
    queuedAt: T0,
    attempts: 0,
  };
}

async function seedQueued(): Promise<string> {
  const created = await createThread(PROJECT_ROOT, { title: 'Build it' });
  await writeThread(PROJECT_ROOT, {
    ...created,
    status: 'in_progress',
    runs: [queuedRun()],
  });
  return created.id;
}

describe('pickupRunForHost', () => {
  it('leases a queued run to its host only, starting a new attempt', async () => {
    const mine = await host('mine', ['qwen']);
    const other = await host('other', ['qwen']);
    await placeAgent([mine]);
    const threadId = await seedQueued();

    await expect(pickupRunForHost(PROJECT_ROOT, other, T0)).resolves.toBe(
      undefined,
    );
    const assignment = await pickupRunForHost(PROJECT_ROOT, mine, T0);

    expect(assignment).toMatchObject({ threadId, runId: 'rn_1', attempt: 1 });
    expect(assignment?.lease).toMatchObject({
      hostId: mine,
      attempt: 1,
      expiresAt: T0 + DEFAULT_RUN_LEASE_MS,
    });
    const run = (await readThread(PROJECT_ROOT, threadId))?.runs[0];
    expect(run).toMatchObject({ status: 'running', attempts: 1 });
  });

  it('leaves a run for a host that has its program', async () => {
    const qwenOnly = await host('qwen-only', ['qwen']);
    const withCodex = await host('with-codex', ['qwen', 'codex']);
    await placeAgent([qwenOnly, withCodex], 'codex');
    await seedQueued();

    await expect(pickupRunForHost(PROJECT_ROOT, qwenOnly, T0)).resolves.toBe(
      undefined,
    );
    await expect(
      pickupRunForHost(PROJECT_ROOT, withCodex, T0),
    ).resolves.toMatchObject({ runId: 'rn_1' });
  });

  it('fails a run no host of its agent can run, instead of leaving it queued', async () => {
    const qwenOnly = await host('qwen-only', ['qwen']);
    await placeAgent([qwenOnly], 'codex');
    const threadId = await seedQueued();

    await expect(pickupRunForHost(PROJECT_ROOT, qwenOnly, T0)).resolves.toBe(
      undefined,
    );
    const run = (await readThread(PROJECT_ROOT, threadId))?.runs[0];
    expect(run).toMatchObject({
      status: 'failed',
      error: AGENT_PROGRAM_UNAVAILABLE,
    });
  });
});

describe('leases', () => {
  it('will not revive an expired lease', async () => {
    const mine = await host('mine', ['qwen']);
    await placeAgent([mine]);
    const threadId = await seedQueued();
    const assignment = (await pickupRunForHost(PROJECT_ROOT, mine, T0))!;

    const late = T0 + DEFAULT_RUN_LEASE_MS + 1;
    await expect(
      renewRunLease(
        PROJECT_ROOT,
        { threadId, runId: 'rn_1', leaseId: assignment.lease.leaseId },
        late,
      ),
    ).resolves.toEqual({ ok: false, reason: 'stale_lease' });
  });

  it('refuses a late result once the run was leased again', async () => {
    const mine = await host('mine', ['qwen']);
    await placeAgent([mine]);
    const threadId = await seedQueued();
    const first = (await pickupRunForHost(PROJECT_ROOT, mine, T0))!;
    const later = T0 + DEFAULT_RUN_LEASE_MS + 1;
    const second = (await pickupRunForHost(PROJECT_ROOT, mine, later))!;
    expect(second.lease.leaseId).not.toBe(first.lease.leaseId);

    await expect(
      applyHostRunResult(
        PROJECT_ROOT,
        {
          threadId,
          runId: 'rn_1',
          hostId: mine,
          leaseId: first.lease.leaseId,
          attempt: first.attempt,
          status: 'completed',
        },
        later + 1,
      ),
    ).resolves.toEqual({ ok: false, reason: 'stale_lease' });
  });
});

describe('host progress steps', () => {
  it('refuses oversized or malformed step lists from a host', () => {
    const step = { id: 's', title: 'Read a.ts', status: 'done' };
    expect(parseHostRunSteps(undefined)).toBeUndefined();
    expect(parseHostRunSteps([step])).toEqual([step]);
    expect(parseHostRunSteps(Array(9).fill(step))).toBe('invalid');
    expect(parseHostRunSteps([{ ...step, status: 'pending' }])).toBe('invalid');
    expect(parseHostRunSteps([{ ...step, title: 'x'.repeat(201) }])).toBe(
      'invalid',
    );
  });

  it('stores the steps a host reports with its progress', async () => {
    const mine = await host('mine', ['qwen']);
    await placeAgent([mine]);
    const threadId = await seedQueued();
    const assignment = (await pickupRunForHost(PROJECT_ROOT, mine))!;
    const steps: NonNullable<NonNullable<ThreadRun['progress']>['steps']> = [
      { id: 's1', title: 'Shell: npm test', status: 'running' },
    ];

    await expect(
      reportHostRunProgress(PROJECT_ROOT, {
        threadId,
        runId: 'rn_1',
        hostId: mine,
        leaseId: assignment.lease.leaseId,
        attempt: assignment.attempt,
        sequence: 2,
        stage: 'tool',
        detail: 'Shell: npm test',
        steps,
      }),
    ).resolves.toEqual({ ok: true });
    const run = (await readThread(PROJECT_ROOT, threadId))?.runs[0];
    expect(run?.progress?.steps).toEqual(steps);
  });
});
