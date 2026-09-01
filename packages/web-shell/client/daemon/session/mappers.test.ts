/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  DaemonEvent,
  DaemonWorkspaceProvidersStatus,
  DaemonWorkspaceSkillsStatus,
} from '@qwen-code/sdk/daemon';
import {
  getReplayTokenCount,
  getReplayTokenUsage,
  mapProviderStatus,
  mapReasoningControls,
  mapWorkspaceSkills,
  selectGoalState,
  selectGoalStateFromRead,
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

describe('mapReasoningControls', () => {
  it('maps toggle-only reasoning without exposing an effort list', () => {
    expect(
      mapReasoningControls([
        {
          id: 'reasoning_effort',
          currentValue: 'default',
          options: [{ value: 'none' }, { value: 'default' }],
          _meta: {
            'qwenCode/reasoning': { toggleOnly: true },
          },
        },
      ]),
    ).toEqual({
      enabled: true,
      effort: 'default',
      efforts: [],
    });
  });

  it('maps mandatory reasoning tiers without an off option', () => {
    expect(
      mapReasoningControls([
        {
          id: 'reasoning_effort',
          currentValue: 'max',
          options: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
          _meta: {
            'qwenCode/reasoning': {
              defaultEffort: 'max',
              canDisable: false,
            },
          },
        },
      ]),
    ).toEqual({
      enabled: true,
      canDisable: false,
      defaultEffort: 'max',
      effort: 'max',
      efforts: ['low', 'high', 'max'],
    });
  });

  it('rejects tiers without an off option or mandatory metadata', () => {
    expect(
      mapReasoningControls([
        {
          id: 'reasoning_effort',
          currentValue: 'high',
          options: [{ value: 'low' }, { value: 'high' }],
        },
      ]),
    ).toBeUndefined();
  });

  it('maps runtime-mandatory reasoning without inventing Thinking off', () => {
    expect(
      mapReasoningControls([
        {
          id: 'reasoning_effort',
          currentValue: 'xhigh',
          options: [{ value: 'low' }, { value: 'medium' }, { value: 'xhigh' }],
          _meta: {
            'qwenCode/reasoning': {
              defaultEffort: 'xhigh',
              thinkingMandatory: true,
            },
          },
        },
      ]),
    ).toEqual({
      enabled: true,
      effort: 'xhigh',
      efforts: ['low', 'medium', 'xhigh'],
      defaultEffort: 'xhigh',
      canDisable: false,
    });
  });

  it('does not restore a dormant effort when the daemon confirms default', () => {
    expect(
      mapReasoningControls([
        {
          id: 'reasoning_effort',
          currentValue: 'default',
          options: [
            { value: 'none', name: 'Thinking off' },
            { value: 'default', name: 'Provider default' },
            { value: 'low', name: 'Daemon Low' },
            { value: 'max', name: 'Daemon Max' },
          ],
        },
      ]),
    ).toEqual({
      enabled: true,
      effort: 'default',
      efforts: ['low', 'max'],
    });
  });
});

describe('mapProviderStatus reasoning preview', () => {
  it('maps a valid preview onto its model entry', () => {
    const result = mapProviderStatus(
      workspaceProvidersWithConfigOptions([
        {
          id: 'reasoning_effort',
          currentValue: 'xhigh',
          options: [
            { value: 'none' },
            { value: 'low' },
            { value: 'medium' },
            { value: 'xhigh' },
          ],
          _meta: {
            'qwenCode/reasoning': { defaultEffort: 'xhigh' },
          },
        },
      ]),
    );

    expect(result.models[0]?.reasoningPreview).toEqual({
      enabled: true,
      effort: 'xhigh',
      efforts: ['low', 'medium', 'xhigh'],
      defaultEffort: 'xhigh',
    });
  });

  it.each([
    { name: 'absent', configOptions: undefined },
    { name: 'empty', configOptions: [] },
    {
      name: 'missing Thinking off',
      configOptions: [
        {
          id: 'reasoning_effort',
          currentValue: 'xhigh',
          options: [{ value: 'default' }, { value: 'xhigh' }],
        },
      ],
    },
    {
      name: 'unknown current value',
      configOptions: [
        {
          id: 'reasoning_effort',
          currentValue: 'bogus',
          options: [{ value: 'none' }, { value: 'low' }],
        },
      ],
    },
  ])('ignores $name preview', ({ configOptions }) => {
    const result = mapProviderStatus(
      workspaceProvidersWithConfigOptions(configOptions),
    );
    expect(result.models[0]?.reasoningPreview).toBeUndefined();
  });
});

function workspaceProvidersWithConfigOptions(
  configOptions: unknown[] | undefined,
): DaemonWorkspaceProvidersStatus {
  return {
    v: 1,
    workspaceCwd: '/workspace',
    initialized: true,
    current: { modelId: 'qwen3.8-max' },
    providers: [
      {
        kind: 'model_provider',
        status: 'ok',
        authType: 'qwen-oauth',
        current: true,
        models: [
          {
            modelId: 'qwen3.8-max',
            baseModelId: 'qwen3.8-max',
            name: 'Qwen 3.8 Max',
            isCurrent: true,
            isRuntime: false,
            ...(configOptions ? { configOptions } : {}),
          },
        ],
      },
    ],
  };
}

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
  it('updates and clears the authoritative Goal snapshot', () => {
    const goal = {
      goalId: 'goal-1',
      revision: 2,
      objective: 'ship safely',
      status: 'active',
      evidenceCursor: { recordId: 'record-1' },
      turnCount: 3,
      activeTimeMs: 4_000,
      createdAt: 10,
      updatedAt: 20,
    };
    const active = applyEvent(
      { status: 'connected', workspaceCwd: '/workspace' },
      {
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            _meta: { goalState: { v: 2, goal, activity: 'running' } },
          },
        },
      } as DaemonEvent,
    );
    expect(active.goalState).toEqual({
      v: 2,
      goal,
      activity: 'running',
    });

    const cleared = applyEvent(active, {
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          _meta: { goalState: { v: 2, goal: null, activity: 'idle' } },
        },
      },
    } as DaemonEvent);
    expect(cleared.goalState).toEqual({
      v: 2,
      goal: null,
      activity: 'idle',
    });
  });

  it('does not regress the same Goal to an older revision', () => {
    const goal = {
      goalId: 'goal-1',
      revision: 7,
      objective: 'newer objective',
      status: 'paused' as const,
      evidenceCursor: { recordId: 'record-1' },
      turnCount: 3,
      activeTimeMs: 4_000,
      createdAt: 10,
      updatedAt: 30,
    };
    const current: DaemonConnectionState = {
      status: 'connected',
      workspaceCwd: '/workspace',
      goalState: { v: 2, goal, activity: 'idle' },
    };
    const next = applyEvent(current, {
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          _meta: {
            goalState: {
              v: 2,
              activity: 'running',
              goal: { ...goal, revision: 6, status: 'active', updatedAt: 20 },
            },
          },
        },
      },
    } as DaemonEvent);

    expect(next.goalState).toBe(current.goalState);
  });

  it('orders equal-revision Goal snapshots by updatedAt', () => {
    const current = {
      v: 2 as const,
      activity: 'idle' as const,
      goal: {
        goalId: 'goal-1',
        revision: 7,
        objective: 'ship safely',
        status: 'paused' as const,
        evidenceCursor: { recordId: 'record-1' },
        turnCount: 3,
        activeTimeMs: 4_000,
        createdAt: 10,
        updatedAt: 30,
      },
    };
    const stale = {
      ...current,
      activity: 'running' as const,
      goal: { ...current.goal, status: 'active' as const, updatedAt: 20 },
    };

    expect(selectGoalState(current, stale)).toBe(current);
  });

  it('holds a bare-null Goal read back from the Goal it never observed', () => {
    // The stamp is what separates "the daemon cleared the goal I read" from
    // "the daemon answered before the goal I now hold existed".
    const created = {
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: 'goal-new',
        revision: 1,
        objective: 'ship safely',
        status: 'active' as const,
        evidenceCursor: { recordId: 'record-1' },
        turnCount: 0,
        activeTimeMs: 0,
        createdAt: 10,
        updatedAt: 20,
      },
    };
    const bareNull = { v: 2 as const, goal: null, activity: 'idle' as const };

    // Issued while goal-less: cannot clear the goal that landed meanwhile...
    expect(selectGoalStateFromRead(created, bareNull, undefined)).toBe(created);
    // ...and leaves no tombstone, so the goal's own later frames still apply.
    expect(selectGoalState(created, { ...created, activity: 'idle' })).toEqual({
      ...created,
      activity: 'idle',
    });
    // Issued while holding this goal: the clear is authoritative.
    expect(
      selectGoalStateFromRead(created, bareNull, 'goal-new').goal,
    ).toBeNull();
    // A tombstoned clear is authoritative whatever the read observed.
    expect(
      selectGoalStateFromRead(
        created,
        {
          ...bareNull,
          clearedGoal: { goalId: 'goal-new', revision: 2, updatedAt: 30 },
        },
        undefined,
      ).goal,
    ).toBeNull();
  });

  it('does not resurrect a cleared Goal from a stale snapshot', () => {
    const active = {
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: 'goal-1',
        revision: 7,
        objective: 'ship safely',
        status: 'active' as const,
        evidenceCursor: { recordId: 'record-1' },
        turnCount: 3,
        activeTimeMs: 4_000,
        createdAt: 10,
        updatedAt: 30,
      },
    };
    const cleared = selectGoalState(active, {
      v: 2,
      goal: null,
      activity: 'idle',
    });

    expect(selectGoalState(cleared, active)).toBe(cleared);
  });

  it('does not resurrect a replaced Goal from a stale snapshot', () => {
    // A replacement mints a new goalId and `goal-runtime` sends no
    // `clearedGoal` tombstone for it, so the replaced goal's ordering identity
    // is the only thing that can reject its late frames.
    const replaced = {
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: 'goal-a',
        revision: 4,
        objective: 'first objective',
        status: 'active' as const,
        evidenceCursor: { recordId: 'record-a' },
        turnCount: 2,
        activeTimeMs: 2_000,
        createdAt: 10,
        updatedAt: 30,
      },
    };
    const replacement = {
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: 'goal-b',
        revision: 1,
        objective: 'replacement objective',
        status: 'active' as const,
        evidenceCursor: { recordId: 'record-b' },
        turnCount: 0,
        activeTimeMs: 0,
        createdAt: 40,
        updatedAt: 50,
      },
    };

    const current = selectGoalState(replaced, replacement);
    expect(current).toBe(replacement);
    expect(selectGoalState(current, replaced)).toBe(current);
  });

  it('keeps rejecting a replaced Goal across further replacements', () => {
    const first = {
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: 'goal-a',
        revision: 4,
        objective: 'first objective',
        status: 'active' as const,
        evidenceCursor: { recordId: 'record-a' },
        turnCount: 2,
        activeTimeMs: 2_000,
        createdAt: 10,
        updatedAt: 30,
      },
    };
    const second = {
      ...first,
      goal: {
        ...first.goal,
        goalId: 'goal-b',
        revision: 1,
        objective: 'second objective',
        updatedAt: 50,
      },
    };
    const third = {
      ...first,
      goal: {
        ...first.goal,
        goalId: 'goal-c',
        revision: 1,
        objective: 'third objective',
        updatedAt: 70,
      },
    };

    const current = selectGoalState(selectGoalState(first, second), third);
    expect(current).toBe(third);
    expect(selectGoalState(current, first)).toBe(current);
    expect(selectGoalState(current, second)).toBe(current);
  });

  it('does not resurrect a cleared Goal after a new Goal starts', () => {
    const active = {
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: 'goal-1',
        revision: 7,
        objective: 'ship safely',
        status: 'active' as const,
        evidenceCursor: { recordId: 'record-1' },
        turnCount: 3,
        activeTimeMs: 4_000,
        createdAt: 10,
        updatedAt: 30,
      },
    };
    const cleared = selectGoalState(active, {
      v: 2,
      goal: null,
      activity: 'idle',
    });
    const next = selectGoalState(cleared, {
      ...active,
      goal: {
        ...active.goal,
        goalId: 'goal-2',
        revision: 1,
        objective: 'next objective',
        updatedAt: 60,
      },
    });

    // The cleared goal's identity survives the new goal, so a frame the daemon
    // emitted before the clear cannot come back over it.
    expect(selectGoalState(next, active)).toBe(next);
  });

  it('accepts a superseded Goal again when the daemon advances its revision', () => {
    const first = {
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: 'goal-a',
        revision: 4,
        objective: 'first objective',
        status: 'active' as const,
        evidenceCursor: { recordId: 'record-a' },
        turnCount: 2,
        activeTimeMs: 2_000,
        createdAt: 10,
        updatedAt: 30,
      },
    };
    const second = {
      ...first,
      goal: {
        ...first.goal,
        goalId: 'goal-b',
        revision: 1,
        objective: 'second objective',
        updatedAt: 50,
      },
    };
    const revived = {
      ...first,
      goal: { ...first.goal, revision: 5, updatedAt: 80 },
    };

    const current = selectGoalState(first, second);
    expect(selectGoalState(current, revived)).toBe(revived);
  });

  it('does not apply a delayed clear tombstone to a replacement Goal', () => {
    const replacement = {
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: 'goal-h',
        revision: 1,
        objective: 'replacement',
        status: 'active' as const,
        evidenceCursor: { recordId: 'record-h' },
        turnCount: 0,
        activeTimeMs: 0,
        createdAt: 40,
        updatedAt: 50,
      },
    };
    const current: DaemonConnectionState = {
      status: 'connected',
      workspaceCwd: '/workspace',
      goalState: replacement,
    };
    const next = applyEvent(current, {
      id: 2,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          _meta: {
            goalState: {
              v: 2,
              goal: null,
              activity: 'idle',
              clearedGoal: {
                goalId: 'goal-g',
                revision: 4,
                updatedAt: 30,
              },
            },
          },
        },
      },
    } as DaemonEvent);

    expect(next.goalState).toBe(replacement);
  });

  it('carries limitKind through from the wire', () => {
    // The mapper rebuilds the Goal record field-by-field after validating it,
    // which is exactly how a newly added field gets dropped in silence. No
    // client logic keys off `limitKind` any more (resumability is decided by
    // status alone; the reducer resumes an evidence-limited Goal by restarting
    // its window), but the wire copy is the client's only copy of the record
    // -- the pin is that mapping does not quietly narrow it.
    const next = applyEvent(
      { status: 'connected', workspaceCwd: '/workspace' },
      {
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            _meta: {
              goalState: {
                v: 2,
                activity: 'idle',
                goal: {
                  goalId: 'goal-1',
                  revision: 3,
                  objective: 'ship it',
                  status: 'usage_limited',
                  evidenceCursor: { recordId: 'record-1' },
                  turnCount: 2,
                  activeTimeMs: 10,
                  createdAt: 1,
                  updatedAt: 2,
                  lastReason: 'evidence catalog exhausted',
                  limitKind: 'evidence_catalog',
                },
              },
            },
          },
        },
      } as DaemonEvent,
    );

    expect(next.goalState?.goal).toMatchObject({
      status: 'usage_limited',
      limitKind: 'evidence_catalog',
    });
  });

  it('carries a token_budget limitKind through from the wire', () => {
    const next = applyEvent(
      { status: 'connected', workspaceCwd: '/workspace' },
      {
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            _meta: {
              goalState: {
                v: 2,
                activity: 'idle',
                goal: {
                  goalId: 'goal-1',
                  revision: 3,
                  objective: 'ship it',
                  status: 'usage_limited',
                  evidenceCursor: { recordId: 'record-1' },
                  turnCount: 2,
                  activeTimeMs: 10,
                  createdAt: 1,
                  updatedAt: 2,
                  lastReason: 'The Goal spent its autonomous token budget.',
                  limitKind: 'token_budget',
                },
              },
            },
          },
        },
      } as DaemonEvent,
    );

    expect(next.goalState?.goal).toMatchObject({
      status: 'usage_limited',
      limitKind: 'token_budget',
    });
  });

  it('drops an unknown limitKind rather than passing it through', () => {
    const next = applyEvent(
      { status: 'connected', workspaceCwd: '/workspace' },
      {
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            _meta: {
              goalState: {
                v: 2,
                activity: 'idle',
                goal: {
                  goalId: 'goal-1',
                  revision: 3,
                  objective: 'ship it',
                  status: 'paused',
                  evidenceCursor: { recordId: 'record-1' },
                  turnCount: 2,
                  activeTimeMs: 10,
                  createdAt: 1,
                  updatedAt: 2,
                  limitKind: 'not-a-kind',
                },
              },
            },
          },
        },
      } as DaemonEvent,
    );

    expect(next.goalState?.goal?.limitKind).toBeUndefined();
  });

  it('ignores malformed Goal snapshots', () => {
    const current: DaemonConnectionState = {
      status: 'connected',
      workspaceCwd: '/workspace',
      goalState: { v: 2, goal: null, activity: 'idle' },
    };
    const next = applyEvent(current, {
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          _meta: { goalState: { v: 2, goal: {}, activity: 'running' } },
        },
      },
    } as DaemonEvent);

    expect(next.goalState).toBe(current.goalState);
  });

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

  it('ignores git branch changes for standalone sessions', () => {
    const current: DaemonConnectionState = {
      status: 'connected',
      sessionContext: { kind: 'standalone' },
    };

    const next = applyEvent(current, {
      v: 1,
      type: 'git_branch_changed',
      data: { branch: 'internal-runtime-branch' },
    });

    expect(next).toBe(current);
  });

  it('ignores git branch changes for Live sessions', () => {
    const current: DaemonConnectionState = {
      status: 'connected',
      sessionContext: { kind: 'live' },
    };

    const next = applyEvent(current, {
      v: 1,
      type: 'git_branch_changed',
      data: { branch: 'internal-runtime-branch' },
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

  it('ignores git status pushes for standalone sessions', () => {
    const current: DaemonConnectionState = {
      status: 'connected',
      sessionContext: { kind: 'standalone' },
    };

    const next = applyEvent(current, {
      v: 1,
      type: 'git_status_changed',
      data: { v: 2, branch: 'main', staged: 3 },
    });

    expect(next).toBe(current);
  });

  it('ignores git status pushes for Live sessions', () => {
    const current: DaemonConnectionState = {
      status: 'connected',
      sessionContext: { kind: 'live' },
    };

    const next = applyEvent(current, {
      v: 1,
      type: 'git_status_changed',
      data: {
        v: 2,
        branch: 'internal-runtime-branch',
        staged: 1,
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

  it('reads nested availableSkills from the daemon wire shape', () => {
    const next = applyEvent(
      { status: 'connected', workspaceCwd: '/workspace' },
      {
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              { name: 'review', description: 'Review a PR', input: null },
            ],
            _meta: { availableSkills: ['review'] },
          },
        },
      } as DaemonEvent,
    );

    expect(next.skills).toEqual(['review']);
  });

  it('prefers flat availableSkills when both wire shapes are present', () => {
    const next = applyEvent(
      { status: 'connected', workspaceCwd: '/workspace' },
      {
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [],
            availableSkills: ['flat-skill'],
            _meta: { availableSkills: ['nested-skill'] },
          },
        },
      } as DaemonEvent,
    );

    expect(next.skills).toEqual(['flat-skill']);
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
