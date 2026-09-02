/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  DaemonEvent,
  DaemonWorkspaceSkillsStatus,
} from '@qwen-code/sdk/daemon';
import {
  getReplayTokenCount,
  getReplayTokenUsage,
  mapWorkspaceSkills,
  updateConnectionFromDaemonEvent,
} from './mappers.js';
import type { DaemonConnectionState } from './types.js';

function availableCommandsEvent(
  availableCommands: Array<Record<string, unknown>>,
  availableSkills: string[],
): DaemonEvent {
  return {
    id: 1,
    v: 1,
    type: 'session_update',
    data: {
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands,
        availableSkills,
      },
    },
  } as DaemonEvent;
}

function applyEvent(
  current: DaemonConnectionState,
  event: DaemonEvent,
): DaemonConnectionState {
  let next = current;
  updateConnectionFromDaemonEvent(event, (update) => {
    next = typeof update === 'function' ? update(next) : update;
  });
  return next;
}

function usageEvent(
  id: number,
  usage: Record<string, unknown>,
  text = '',
): DaemonEvent {
  return {
    id,
    v: 1,
    type: 'session_update',
    data: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
        _meta: { usage },
      },
    },
  };
}

const turnComplete: DaemonEvent = {
  id: 99,
  v: 1,
  type: 'turn_complete',
  data: { stopReason: 'end_turn' },
};

describe('getReplayTokenCount', () => {
  it('returns undefined for an empty array', () => {
    expect(getReplayTokenCount([])).toBeUndefined();
  });

  it('returns undefined when no event carries usage', () => {
    const plainChunk: DaemonEvent = {
      id: 1,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'no usage here' },
        },
      },
    };
    expect(getReplayTokenCount([plainChunk, turnComplete])).toBeUndefined();
  });

  it('returns the latest usage, not the first', () => {
    expect(
      getReplayTokenCount([
        usageEvent(1, { inputTokens: 11_000 }),
        turnComplete,
        usageEvent(3, { inputTokens: 23_000 }),
        turnComplete,
      ]),
    ).toBe(23_000);
  });

  it('returns the latest structured usage fields', () => {
    expect(
      getReplayTokenUsage([
        usageEvent(1, {
          cachedReadTokens: 10,
          inputTokens: 11_000,
          outputTokens: 100,
          thoughtTokens: 5,
          totalTokens: 11_105,
        }),
        turnComplete,
        usageEvent(3, {
          cachedReadTokens: 0,
          inputTokens: 23_279,
          outputTokens: 182,
          thoughtTokens: 0,
          totalTokens: 23_461,
        }),
      ]),
    ).toEqual({
      cachedReadTokens: 0,
      inputTokens: 23_279,
      outputTokens: 182,
      thoughtTokens: 0,
      totalTokens: 23_461,
    });
  });

  it('prefers inputTokens over totalTokens and falls back to totalTokens', () => {
    expect(
      getReplayTokenCount([
        usageEvent(1, { inputTokens: 7_000, totalTokens: 7_500 }),
      ]),
    ).toBe(7_000);
    expect(getReplayTokenCount([usageEvent(1, { totalTokens: 7_500 })])).toBe(
      7_500,
    );
  });

  it('ignores non-positive and non-numeric usage values', () => {
    expect(
      getReplayTokenCount([
        usageEvent(1, { inputTokens: 5_000 }),
        usageEvent(2, { inputTokens: 0 }),
        usageEvent(3, { inputTokens: 'NaN-ish' }),
      ]),
    ).toBe(5_000);
  });

  it('skips events with non-record payloads and keeps scanning', () => {
    const nullData = {
      id: 2,
      v: 1,
      type: 'session_update',
      data: null,
    } as unknown as DaemonEvent;
    expect(
      getReplayTokenCount([usageEvent(1, { inputTokens: 500 }), nullData]),
    ).toBe(500);
  });

  it('skips events whose payload getter throws and keeps scanning', () => {
    const throwing = {
      id: 2,
      v: 1,
      type: 'session_update',
    } as DaemonEvent;
    Object.defineProperty(throwing, 'data', {
      get() {
        throw new Error('bad replay payload');
      },
    });
    expect(
      getReplayTokenCount([usageEvent(1, { inputTokens: 500 }), throwing]),
    ).toBe(500);
  });
});

describe('mapWorkspaceSkills', () => {
  it('returns empty commands and skills for undefined status', () => {
    expect(mapWorkspaceSkills(undefined)).toEqual({ commands: [], skills: [] });
  });

  it('maps workspace skills into skill slash commands', () => {
    const status: DaemonWorkspaceSkillsStatus = {
      v: 1,
      workspaceCwd: '/ws',
      initialized: true,
      skills: [
        {
          kind: 'skill',
          status: 'ok',
          name: 'review',
          description: 'Review a GitHub pull request',
          level: 'bundled',
          modelInvocable: true,
          argumentHint: '<pr-number>',
        },
        {
          kind: 'skill',
          status: 'ok',
          name: 'deep-research',
          description: '',
          level: 'bundled',
          modelInvocable: false,
        },
        {
          kind: 'skill',
          status: 'disabled',
          name: 'disabled-skill',
          description: 'Disabled in settings',
          level: 'project',
          modelInvocable: true,
        },
      ],
    };

    const result = mapWorkspaceSkills(status);

    expect(result.skills).toEqual(['review', 'deep-research']);
    expect(result.commands).toEqual([
      {
        name: 'review',
        description: 'Review a GitHub pull request',
        argumentHint: '<pr-number>',
        raw: {
          name: 'review',
          description: 'Review a GitHub pull request',
          input: { hint: '<pr-number>' },
          _meta: { source: 'skill' },
        },
      },
      {
        name: 'deep-research',
        description: '',
        raw: {
          name: 'deep-research',
          description: '',
          input: null,
          _meta: { source: 'skill' },
        },
      },
    ]);
  });
});

describe('updateConnectionFromDaemonEvent', () => {
  it('updates and clears the current git branch', () => {
    const changed = applyEvent(
      { status: 'connected', workspaceCwd: '/workspace', gitBranch: 'main' },
      {
        v: 1,
        type: 'git_branch_changed',
        data: { workspaceCwd: '/workspace', branch: 'feature/web-shell' },
      },
    );
    expect(changed.gitBranch).toBe('feature/web-shell');

    const cleared = applyEvent(changed, {
      v: 1,
      type: 'git_branch_changed',
      data: { workspaceCwd: '/workspace', branch: null },
    });
    expect(cleared.gitBranch).toBeUndefined();
  });

  it('ignores git branch changes from a previous workspace', () => {
    const current = {
      status: 'connected' as const,
      workspaceCwd: '/workspace/current',
      gitBranch: 'main',
    };

    const next = applyEvent(current, {
      v: 1,
      type: 'git_branch_changed',
      data: { workspaceCwd: '/workspace/previous', branch: 'stale-branch' },
    });

    expect(next).toBe(current);
  });

  it('stores the enriched git status pushed for the current workspace', () => {
    const next = applyEvent(
      { status: 'connected', workspaceCwd: '/workspace' },
      {
        v: 1,
        type: 'git_status_changed',
        data: {
          v: 2,
          workspaceCwd: '/workspace',
          branch: 'main',
          staged: 2,
          computedAt: 1_700_000_000_000,
        },
      },
    );

    expect(next.gitStatus).toMatchObject({
      workspaceCwd: '/workspace',
      branch: 'main',
      staged: 2,
    });
  });

  it('ignores git status pushes from a previous workspace', () => {
    const current = {
      status: 'connected' as const,
      workspaceCwd: '/workspace/current',
    };

    const next = applyEvent(current, {
      v: 1,
      type: 'git_status_changed',
      data: {
        v: 2,
        workspaceCwd: '/workspace/previous',
        branch: 'stale-branch',
        staged: 9,
      },
    });

    expect(next).toBe(current);
  });

  it('replaces commands and skills from an available_commands_update', () => {
    const next = applyEvent(
      { status: 'connected', workspaceCwd: '/workspace' },
      availableCommandsEvent(
        [{ name: 'review', description: 'Review a PR', input: null }],
        ['review'],
      ),
    );

    expect(next.commands?.map((command) => command.name)).toEqual(['review']);
    expect(next.skills).toEqual(['review']);
  });

  it('clears stale commands when the update reports an empty list', () => {
    // The daemon snapshot is authoritative: a list that shrank to empty must
    // not leave the previous commands autocompleting. Keying on length would
    // preserve the stale entries.
    const next = applyEvent(
      {
        status: 'connected',
        workspaceCwd: '/workspace',
        commands: [
          {
            name: 'review',
            description: '',
            raw: { name: 'review', description: '', input: null },
          },
        ],
        skills: ['review'],
      },
      availableCommandsEvent([], []),
    );

    expect(next.commands).toEqual([]);
    expect(next.skills).toEqual([]);
  });
});
