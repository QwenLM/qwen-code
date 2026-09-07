/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getAgentMetaPath,
  patchAgentMeta,
  readAgentMeta,
  writeAgentMeta,
} from '../agent-transcript.js';

import type { Config } from '../../config/config.js';
import {
  createMeshDispatchPort,
  inspectBody,
  meshBackgroundAgentId,
} from './dispatch-port.js';
import type { MeshAgent } from './types.js';

const ALICE: MeshAgent = { id: 'ag_alice', name: 'alice', createdAt: 1 };

function makeConfig(
  overrides: {
    entry?: { status: string } | undefined;
    continueResult?: string;
    revive?: unknown;
    resume?: unknown;
  } = {},
) {
  const registry = {
    get: vi.fn(() => overrides.entry),
    continueResidentAgent: vi.fn(() => overrides.continueResult ?? 'continued'),
  };
  const config = {
    getBackgroundTaskRegistry: () => registry,
    getSessionId: () => 'se_host',
    getProjectRoot: () => '/mesh-port-test',
    reviveCompletedBackgroundAgent: vi.fn(async () => overrides.revive),
    resumeBackgroundAgent: vi.fn(async () => overrides.resume),
  } as unknown as Config;
  return { config, registry };
}

describe('inspectBody', () => {
  it('keys the body on the identity so an agent has exactly one', () => {
    expect(meshBackgroundAgentId(ALICE)).toBe('mesh-ag_alice');
  });

  it.each([
    [undefined, 'absent'],
    [{ status: 'running' }, 'running'],
    [{ status: 'paused' }, 'paused'],
    [{ status: 'completed' }, 'completed'],
    // A cancelled or failed entry has no usable body. Reporting it absent is
    // safe because the launcher keys on the same deterministic id.
    [{ status: 'cancelled' }, 'absent'],
  ])('maps registry entry %j to %s', (entry, kind) => {
    const { config } = makeConfig({ entry: entry as { status: string } });
    expect(inspectBody(config, ALICE).kind).toBe(kind);
  });
});

describe('createMeshDispatchPort', () => {
  // The binding write is best effort by design: with no meta on disk the
  // patch is a no-op, and the turn seam then refuses to run mesh tools, which
  // is the safe direction. These tests exercise the entry-point choice.
  const start = (
    config: Config,
    action: 'launch' | 'resume' | 'continue_completed',
  ) =>
    createMeshDispatchPort(config).start({
      action,
      agent: ALICE,
      prompt: 'YOUR RUN ...',
      threadId: 'th_1',
      rootThreadId: 'th_1',
      runId: 'rn_1',
      attempt: 1,
    });

  it('continues a completed body hot without touching the transcript', async () => {
    const { config, registry } = makeConfig({ continueResult: 'continued' });

    await expect(start(config, 'continue_completed')).resolves.toEqual({
      status: 'started',
      sessionId: 'se_host',
    });
    expect(registry.continueResidentAgent).toHaveBeenCalledWith(
      'mesh-ag_alice',
      'YOUR RUN ...',
    );
    expect(config.reviveCompletedBackgroundAgent).not.toHaveBeenCalled();
  });

  it('falls back to the transcript only when the registry says the runtime is gone', async () => {
    const { config } = makeConfig({
      continueResult: 'fallback',
      revive: { id: 'x' },
    });

    await expect(start(config, 'continue_completed')).resolves.toMatchObject({
      status: 'started',
    });
    expect(config.reviveCompletedBackgroundAgent).toHaveBeenCalled();
  });

  it('reports capacity before mutating anything, so the run keeps its place', async () => {
    const { config } = makeConfig({ continueResult: 'capacity_wait' });

    await expect(start(config, 'continue_completed')).resolves.toEqual({
      status: 'capacity_wait',
    });
    expect(config.reviveCompletedBackgroundAgent).not.toHaveBeenCalled();
  });

  it('does not force a body that changed state under it', async () => {
    const { config } = makeConfig({ continueResult: 'not_completed' });

    await expect(start(config, 'continue_completed')).resolves.toMatchObject({
      status: 'launch_failed',
      failureStage: 'continue',
    });
    expect(config.reviveCompletedBackgroundAgent).not.toHaveBeenCalled();
  });

  it('treats a revive that returns nothing as a typed failure, not a start', async () => {
    const { config } = makeConfig({
      continueResult: 'fallback',
      revive: undefined,
    });

    await expect(start(config, 'continue_completed')).resolves.toMatchObject({
      status: 'launch_failed',
      failureStage: 'revive',
    });
  });

  it('resumes a restart-recovered entry through the resume engine', async () => {
    const { config } = makeConfig({
      entry: { status: 'paused' },
      resume: { id: 'x' },
    });

    await expect(start(config, 'resume')).resolves.toMatchObject({
      status: 'started',
    });
    expect(config.resumeBackgroundAgent).toHaveBeenCalledWith(
      'mesh-ag_alice',
      'YOUR RUN ...',
    );
  });

  it('turns a thrown runtime error into a typed failure', async () => {
    const { config } = makeConfig();
    (
      config.resumeBackgroundAgent as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error('registry exploded'));

    await expect(start(config, 'resume')).resolves.toMatchObject({
      status: 'launch_failed',
      error: 'registry exploded',
    });
  });
});

describe('per-turn thread binding', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-bind-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('rewrites which thread the next turn is for, without disturbing identity', () => {
    // The turn seam reads this record once per turn. A body that worked thread
    // A last turn and thread B this turn must get B; the durable identity that
    // makes it the same body across both must not move.
    const metaPath = getAgentMetaPath(projectRoot, 'se_host', 'mesh-ag_alice');
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    writeAgentMeta(metaPath, {
      agentId: 'mesh-ag_alice',
      meshAgentId: 'ag_alice',
      agentType: 'log-reader',
      description: 'reads CI logs',
      parentSessionId: 'se_host',
      parentAgentId: null,
      createdAt: new Date().toISOString(),
      status: 'running',
      meshRun: {
        workspaceId: projectRoot,
        agentId: 'ag_alice',
        runId: 'rn_first',
        threadId: 'th_a',
        rootThreadId: 'th_a',
        attempt: 1,
      },
    });

    const { config } = makeConfig();
    (config as unknown as { getProjectRoot: () => string }).getProjectRoot =
      () => projectRoot;
    createMeshDispatchPort(config);
    const next = {
      workspaceId: projectRoot,
      agentId: 'ag_alice',
      runId: 'rn_second',
      threadId: 'th_b',
      rootThreadId: 'th_b',
      attempt: 1,
    };
    // The same helper the port uses on every non-launch start.
    patchAgentMeta(metaPath, { meshRun: next });

    const stored = readAgentMeta(metaPath);
    expect(stored?.meshRun?.threadId).toBe('th_b');
    expect(stored?.meshRun?.runId).toBe('rn_second');
    expect(stored?.meshAgentId).toBe('ag_alice');
    expect(stored?.agentType).toBe('log-reader');
  });
});
