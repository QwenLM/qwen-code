/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  AgentStatus,
  type SwarmTask,
  type TeamManager,
} from '@qwen-code/qwen-code-core';
import { buildTeamAgentRosterEntries } from './use-team-agent-roster.js';

describe('buildTeamAgentRosterEntries', () => {
  it('keeps idle distinct and uses the assigned shared task as activity', () => {
    const manager = {
      getTeamFile: () => ({
        name: 'review-team',
        createdAt: 1,
        leadAgentId: 'leader',
        members: [
          {
            agentId: 'reviewer@review-team',
            name: 'reviewer',
            joinedAt: 1_000,
            cwd: '/work/qwen-code',
            tmuxPaneId: '',
            subscriptions: [],
          },
        ],
      }),
      getAgentFromBackend: () => ({ getStatus: () => AgentStatus.IDLE }),
    } as unknown as TeamManager;
    const tasks: SwarmTask[] = [
      {
        id: '1',
        subject: 'Review authentication flow',
        description: 'Inspect auth changes',
        activeForm: 'Reviewing authentication flow',
        owner: 'reviewer',
        status: 'in_progress',
        blocks: [],
        blockedBy: [],
      },
    ];

    expect(
      buildTeamAgentRosterEntries(
        manager,
        tasks,
        new Map(),
        new Set(['reviewer@review-team']),
        4_000,
      ),
    ).toEqual([
      expect.objectContaining({
        agentId: 'reviewer@review-team',
        description: 'Reviewing authentication flow',
        startTime: 1_000,
        status: 'paused',
        teamStatus: AgentStatus.IDLE,
        teamTask: tasks[0],
      }),
    ]);
  });

  it('omits teammates that have no Agent tab in the in-process UI', () => {
    const manager = {
      getTeamFile: () => ({
        name: 'review-team',
        createdAt: 1,
        leadAgentId: 'leader',
        members: [
          {
            agentId: 'reviewer@review-team',
            name: 'reviewer',
            joinedAt: 1_000,
            cwd: '/work/qwen-code',
            tmuxPaneId: '',
            subscriptions: [],
          },
        ],
      }),
      getAgentFromBackend: () => ({ getStatus: () => AgentStatus.RUNNING }),
    } as unknown as TeamManager;

    expect(
      buildTeamAgentRosterEntries(manager, [], new Map(), new Set(), 4_000),
    ).toEqual([]);
  });
});
