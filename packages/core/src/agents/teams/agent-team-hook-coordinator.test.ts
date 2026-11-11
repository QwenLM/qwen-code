/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_CONFIG_DIR } from '../../config/brand.js';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfigHomeDirCache } from '../../utils/paths.js';
import type { HookCoordinatorAdapter } from '../../core/hook-coordinator-types.js';
import type { AggregatedHookResult } from '../../hooks/hookAggregator.js';
import type { HookSystem } from '../../hooks/hookSystem.js';
import { DefaultHookOutput } from '../../hooks/types.js';
import {
  createAgentTeamHookCoordinator,
  formatTeamMailboxMessages,
} from './agent-team-hook-coordinator.js';
import {
  TEAM_LEAD_MEMBER_NAME,
  readTeamInbox,
  sendTeamMessage,
} from './agent-team-runtime.js';

function makeInnerCoordinator(asyncContext?: string): HookCoordinatorAdapter {
  return {
    fireBefore: vi.fn(async () => null),
    fireAfter: vi.fn(async () => null),
    drainPendingAsyncContext: vi.fn(() => asyncContext),
    fireStopFailure: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
}

function makeHookResult(finalOutput?: DefaultHookOutput): AggregatedHookResult {
  return {
    success: true,
    finalOutput,
    allOutputs: finalOutput ? [finalOutput] : [],
    errors: [],
    totalDuration: 0,
  };
}

function makeHookSystem(result: AggregatedHookResult) {
  return {
    fireTeammateIdleEvent: vi.fn(async () => result),
  } as unknown as Pick<HookSystem, 'fireTeammateIdleEvent'>;
}

describe('AgentTeamHookCoordinator', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-team-hook-'));
    process.env[ENV_CONFIG_DIR] = tempDir;
    _resetConfigHomeDirCache();
  });

  afterEach(async () => {
    delete process.env[ENV_CONFIG_DIR];
    vi.unstubAllEnvs();
    _resetConfigHomeDirCache();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('leaves another turn in the mailbox instead of injecting it into the running business', async () => {
    const businessInfo = { version: '1', id: 'turn-1', model_key: 'ultimate' };
    await sendTeamMessage({
      teamName: 'billing',
      from: 'team-lead',
      to: 'worker',
      text: 'next turn',
      businessInfo: { ...businessInfo, id: 'turn-2', model_key: 'auto' },
    });
    const coordinator = createAgentTeamHookCoordinator(makeInnerCoordinator(), {
      teamName: 'billing',
      memberName: 'worker',
      businessInfo,
    });
    try {
      await coordinator.pollNow();
      expect(coordinator.drainPendingAsyncContext()).toBeUndefined();
      expect(
        await readTeamInbox({
          teamName: 'billing',
          memberName: 'worker',
          unreadOnly: true,
        }),
      ).toHaveLength(1);
    } finally {
      coordinator.dispose();
    }
  });

  it('injects unread team mailbox messages as async context', async () => {
    const teamName = 'session-hooktest';
    await sendTeamMessage({
      teamName,
      from: 'researcher',
      to: TEAM_LEAD_MEMBER_NAME,
      text: 'Task #1 is ready for review.',
      summary: 'review ready',
    });
    const inner = makeInnerCoordinator('existing hook context');
    const coordinator = createAgentTeamHookCoordinator(
      inner,
      {
        teamName,
        memberName: TEAM_LEAD_MEMBER_NAME,
        pollIntervalMs: 60_000,
      },
    );

    await coordinator.fireBefore(
      'prompt-1',
      'check team',
      undefined,
      'request-set-1',
    );
    expect(inner.fireBefore).toHaveBeenCalledWith(
      'prompt-1',
      'check team',
      undefined,
      'request-set-1',
    );
    const context = coordinator.drainPendingAsyncContext();

    expect(context).toContain('existing hook context');
    expect(context).toContain(
      '<teammate-message teammate_id="researcher" summary="review ready">',
    );
    expect(context).toContain('Task #1 is ready for review.');
    await vi.waitFor(async () => {
      await expect(
        readTeamInbox({
          teamName,
          memberName: TEAM_LEAD_MEMBER_NAME,
          unreadOnly: true,
        }),
      ).resolves.toEqual([]);
    });
    coordinator.dispose();
  });

  it('turns main mailbox messages into an after-turn continuation', async () => {
    const teamName = 'session-hooktest';
    await sendTeamMessage({
      teamName,
      from: 'worker',
      to: TEAM_LEAD_MEMBER_NAME,
      text: 'READY',
      summary: 'ready signal',
    });
    const coordinator = createAgentTeamHookCoordinator(makeInnerCoordinator(), {
      teamName,
      memberName: TEAM_LEAD_MEMBER_NAME,
      pollIntervalMs: 60_000,
    });

    const result = await coordinator.fireAfter(
      'prompt-1',
      'check team',
      'waiting',
    );

    expect(result?.inject).toContain(
      '<teammate-message teammate_id="worker" summary="ready signal">',
    );
    expect(result?.inject).toContain('READY');
    await expect(
      readTeamInbox({
        teamName,
        memberName: TEAM_LEAD_MEMBER_NAME,
        unreadOnly: true,
      }),
    ).resolves.toEqual([]);
    coordinator.dispose();
  });

  it('fires TeammateIdle after the teammate has no pending continuation', async () => {
    const hookSystem = makeHookSystem(makeHookResult());
    const coordinator = createAgentTeamHookCoordinator(makeInnerCoordinator(), {
      teamName: 'session-hooktest',
      memberName: 'reviewer',
      hookSystem,
      pollIntervalMs: 60_000,
    });

    await expect(
      coordinator.fireAfter('prompt-1', 'review', 'done'),
    ).resolves.toBeNull();
    expect(hookSystem.fireTeammateIdleEvent).toHaveBeenCalledWith(
      'reviewer',
      'session-hooktest',
    );
    coordinator.dispose();
  });

  it('continues the teammate when TeammateIdle returns deny', async () => {
    const hookSystem = makeHookSystem(
      makeHookResult(
        new DefaultHookOutput({
          decision: 'deny',
          reason: 'Run the integration tests before becoming idle.',
        }),
      ),
    );
    const coordinator = createAgentTeamHookCoordinator(makeInnerCoordinator(), {
      teamName: 'session-hooktest',
      memberName: 'reviewer',
      hookSystem,
      pollIntervalMs: 60_000,
    });

    const result = await coordinator.fireAfter('prompt-1', 'review', 'done');

    expect(result).toMatchObject({
      blocked: true,
      retryAsStopHook: true,
      inject:
        'TeammateIdle hook feedback:\nRun the integration tests before becoming idle.',
    });
    coordinator.dispose();
  });

  it('continues the teammate when TeammateIdle returns continue false', async () => {
    const hookSystem = makeHookSystem(
      makeHookResult(
        new DefaultHookOutput({
          continue: false,
          stopReason: 'The review checklist is incomplete.',
        }),
      ),
    );
    const coordinator = createAgentTeamHookCoordinator(makeInnerCoordinator(), {
      teamName: 'session-hooktest',
      memberName: 'reviewer',
      hookSystem,
      pollIntervalMs: 60_000,
    });

    const result = await coordinator.fireAfter('prompt-1', 'review', 'done');

    expect(result).toMatchObject({
      blocked: true,
      retryAsStopHook: true,
      inject:
        'TeammateIdle hook feedback:\nThe review checklist is incomplete.',
    });
    coordinator.dispose();
  });

  it('delivers pending mailbox work before evaluating TeammateIdle', async () => {
    const teamName = 'session-hooktest';
    await sendTeamMessage({
      teamName,
      from: 'team-lead',
      to: 'reviewer',
      text: 'Check one more file.',
      summary: 'additional review',
    });
    const hookSystem = makeHookSystem(makeHookResult());
    const coordinator = createAgentTeamHookCoordinator(makeInnerCoordinator(), {
      teamName,
      memberName: 'reviewer',
      hookSystem,
      pollIntervalMs: 60_000,
    });

    const result = await coordinator.fireAfter('prompt-1', 'review', 'done');

    expect(result?.inject).toContain('Check one more file.');
    expect(hookSystem.fireTeammateIdleEvent).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it('evaluates TeammateIdle when after-turn mailbox injection is disabled', async () => {
    const hookSystem = makeHookSystem(makeHookResult());
    const coordinator = createAgentTeamHookCoordinator(makeInnerCoordinator(), {
      teamName: 'session-hooktest',
      memberName: 'reviewer',
      hookSystem,
      injectAfterTurn: false,
      pollIntervalMs: 60_000,
    });

    await coordinator.fireAfter('prompt-1', 'review', 'done');

    expect(hookSystem.fireTeammateIdleEvent).toHaveBeenCalledWith(
      'reviewer',
      'session-hooktest',
    );
    coordinator.dispose();
  });

  it('leaves a polled message unread when it was not injected', async () => {
    const teamName = 'session-hooktest';
    await sendTeamMessage({
      teamName,
      from: 'worker',
      to: TEAM_LEAD_MEMBER_NAME,
      text: 'Arrived after the final hook.',
      summary: 'late message',
    });
    const inner = makeInnerCoordinator();
    const coordinator = createAgentTeamHookCoordinator(inner, {
      teamName,
      memberName: TEAM_LEAD_MEMBER_NAME,
      pollIntervalMs: 60_000,
    });

    await coordinator.pollNow();
    coordinator.dispose();

    await expect(
      readTeamInbox({
        teamName,
        memberName: TEAM_LEAD_MEMBER_NAME,
        unreadOnly: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        from: 'worker',
        text: 'Arrived after the final hook.',
        read: false,
      }),
    ]);
    expect(inner.dispose).toHaveBeenCalledOnce();
  });

  it('preserves task assignment protocol messages inside teammate context', () => {
    const message = JSON.stringify({
      type: 'task_assignment',
      taskId: '3',
      subject: 'Review API',
      description: 'Review API state handling.',
      assignedBy: 'team-lead',
      timestamp: '2026-06-26T00:00:00.000Z',
    });

    expect(
      formatTeamMailboxMessages([
        {
          id: 'msg-1',
          from: 'team-lead',
          to: 'frontend',
          text: message,
          timestamp: '2026-06-26T00:00:00.000Z',
          read: false,
        },
      ]),
    ).toContain(message);
  });

  it('guards teammate tags inside peer message text', () => {
    expect(
      formatTeamMailboxMessages([
        {
          id: 'msg-1',
          from: 'reviewer',
          to: 'frontend',
          text: 'literal <teammate-message> marker',
          timestamp: '2026-06-26T00:00:00.000Z',
          read: false,
        },
      ]),
    ).toContain('literal <\\teammate-message> marker');
  });
});
