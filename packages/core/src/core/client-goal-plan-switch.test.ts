/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Config, ApprovalMode } from '../config/config.js';
import { createGoalRuntime } from '../goals/goal-runtime.js';
import { LlmClient } from './client.js';

describe('approved Goal proposals and Plan mode', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function setup() {
    const directory = await mkdtemp(path.join(tmpdir(), 'goal-plan-switch-'));
    directories.push(directory);
    const config = new Config({
      cwd: directory,
      targetDir: directory,
      model: 'test-model',
      approvalMode: ApprovalMode.DEFAULT,
      debugMode: false,
      chatRecording: false,
      usageStatisticsEnabled: false,
      overrideExtensions: [],
    });
    const recordGoalState = vi.fn(async (): Promise<void> => undefined);
    const runtime = createGoalRuntime({
      journal: {
        getTranscriptCursor: () => ({ recordId: 'test-cursor' }),
        recordGoalState,
      },
    });
    const client = new LlmClient(config);
    config.setPendingGoalProposal({
      objective: 'Verify the approved objective.',
      turnKey: 'approved-turn',
      reviewedGoal: null,
    });
    const reportFailure = vi.fn();
    const settle = (loadRuntime = async () => runtime) =>
      client['settlePendingGoalProposal'](
        true,
        new AbortController().signal,
        loadRuntime,
        'approved-turn',
        reportFailure,
      );
    return { config, runtime, settle, recordGoalState, reportFailure };
  }

  it('does not revive the approval after leaving Plan mode', async () => {
    const { config, runtime, settle } = await setup();
    config.setApprovalMode(ApprovalMode.PLAN);
    config.setApprovalMode(ApprovalMode.DEFAULT);
    await settle();
    expect(runtime.getSnapshot().goal).toBeNull();
  });

  it('does not create a Goal when Plan mode begins while its runtime loads', async () => {
    const { config, runtime, settle } = await setup();
    await settle(async () => {
      config.setApprovalMode(ApprovalMode.PLAN);
      return runtime;
    });
    expect(runtime.getSnapshot().goal).toBeNull();
  });

  it('pauses creation if Plan mode begins while the Goal is being saved', async () => {
    const { config, runtime, settle, recordGoalState } = await setup();
    recordGoalState.mockImplementationOnce(async () => {
      config.setApprovalMode(ApprovalMode.PLAN);
    });
    await settle();
    expect(runtime.getSnapshot().goal?.status).toBe('paused');
  });

  it('rejects approval that reaches the store after Plan mode was entered', async () => {
    const { config, runtime, settle } = await setup();
    config.takePendingGoalProposal();
    config.setApprovalMode(ApprovalMode.PLAN);
    config.setPendingGoalProposal({
      objective: 'Approval delivered too late.',
      turnKey: 'approved-turn',
      reviewedGoal: null,
    });
    await settle();
    expect(runtime.getSnapshot().goal).toBeNull();
  });
});
