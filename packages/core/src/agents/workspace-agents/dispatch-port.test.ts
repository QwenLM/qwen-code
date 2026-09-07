/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import type { Config } from '../../config/config.js';
import {
  createAgentDispatchPort,
  inspectBody,
  agentBodyId,
} from './dispatch-port.js';
import type { WorkspaceAgent } from './types.js';

vi.mock('../agent-transcript.js', () => ({
  getAgentMetaPath: () => '/agent-body.meta.json',
  patchAgentMeta: () => {},
  readAgentMeta: () => ({
    agentRun: {
      workspaceId: 'ws_1',
      threadId: 'th_1',
      runId: 'rn_1',
      attempt: 1,
    },
  }),
}));

const ALICE: WorkspaceAgent = { id: 'ag_alice', name: 'alice', createdAt: 1 };

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
    getProjectRoot: () => '/workspace',
    getBackgroundTaskRegistry: () => registry,
    getSessionId: () => 'se_host',
    reviveCompletedBackgroundAgent: vi.fn(async () => overrides.revive),
    resumeBackgroundAgent: vi.fn(async () => overrides.resume),
  } as unknown as Config;
  return { config, registry };
}

describe('inspectBody', () => {
  it('keys the body on the identity so an agent has exactly one', () => {
    expect(agentBodyId(ALICE)).toBe('agent-ag_alice');
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

describe('createAgentDispatchPort', () => {
  const start = (
    config: Config,
    action: 'launch' | 'resume' | 'continue_completed',
  ) =>
    createAgentDispatchPort(config).start({
      action,
      agent: ALICE,
      prompt: 'YOUR RUN ...',
      workspaceId: 'ws_1',
      threadId: 'th_1',
      rootThreadId: 'th_1',
      runId: 'rn_1',
      attempt: 1,
      contextThroughSequence: 1,
    });

  it('continues a completed body hot without touching the transcript', async () => {
    const { config, registry } = makeConfig({ continueResult: 'continued' });

    await expect(start(config, 'continue_completed')).resolves.toEqual({
      status: 'started',
      sessionId: 'se_host',
      consumedOnStart: false,
    });
    expect(registry.continueResidentAgent).toHaveBeenCalledWith(
      'agent-ag_alice',
      'YOUR RUN ...',
      'rn_1',
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
      'agent-ag_alice',
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
