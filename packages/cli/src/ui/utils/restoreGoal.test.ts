/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetActiveGoalStoreForTests,
  getActiveGoal,
  getLastGoalTerminal,
  notifyGoalTerminal,
  setActiveGoal,
  type ChatRecord,
  type Config,
} from '@qwen-code/qwen-code-core';
import type { HistoryItem } from '../types.js';
import {
  collectGoalStatusItemsFromRecords,
  findGoalToRestore,
  findLastTerminalGoal,
  MAX_GOAL_LENGTH,
  parseGoalStatusItem,
  restoreGoalFromHistory,
} from './restoreGoal.js';

const goalItem = (
  overrides: Partial<HistoryItem & { kind: string; condition: string }>,
): HistoryItem =>
  ({
    id: 1,
    type: 'goal_status',
    kind: 'set',
    condition: 'write hello',
    ...overrides,
  }) as HistoryItem;

const userItem = (text = 'hi'): HistoryItem =>
  ({ id: 2, type: 'user', text }) as HistoryItem;

const makeConfig = (overrides: Partial<Config> = {}): Config =>
  ({
    getSessionId: vi.fn().mockReturnValue('sess-1'),
    isTrustedFolder: vi.fn().mockReturnValue(true),
    getDisableAllHooks: vi.fn().mockReturnValue(false),
    getHookSystem: vi.fn().mockReturnValue({
      addFunctionHook: vi.fn().mockReturnValue('hook-1'),
      removeFunctionHook: vi.fn().mockReturnValue(true),
    }),
    ...overrides,
  }) as unknown as Config;

describe('findGoalToRestore', () => {
  it('returns null on empty history', () => {
    expect(findGoalToRestore([])).toBeNull();
  });

  it('returns null when last goal_status is achieved', () => {
    expect(
      findGoalToRestore([
        goalItem({ kind: 'set', condition: 'do x' }),
        userItem(),
        goalItem({ kind: 'achieved', condition: 'do x' }),
      ]),
    ).toBeNull();
  });

  it('returns the condition (iterations 0) when last goal_status is set', () => {
    expect(
      findGoalToRestore([
        goalItem({ kind: 'achieved', condition: 'old goal' }),
        goalItem({ kind: 'set', condition: 'fresh goal' }),
        userItem(),
      ]),
    ).toEqual({ condition: 'fresh goal', iterations: 0 });
  });

  it('returns the condition when last goal_status is checking', () => {
    expect(
      findGoalToRestore([
        goalItem({ kind: 'set', condition: 'fresh goal' }),
        userItem(),
        goalItem({ kind: 'checking', condition: 'fresh goal' }),
      ]),
    ).toEqual({ condition: 'fresh goal', iterations: 0 });
  });

  it('carries the running iteration count from a checking item', () => {
    expect(
      findGoalToRestore([
        goalItem({ kind: 'set', condition: 'fresh goal' }),
        userItem(),
        goalItem({ kind: 'checking', condition: 'fresh goal', iterations: 7 }),
      ]),
    ).toEqual({ condition: 'fresh goal', iterations: 7 });
  });

  it('returns null when last goal_status is cleared', () => {
    expect(
      findGoalToRestore([
        goalItem({ kind: 'set', condition: 'do x' }),
        goalItem({ kind: 'cleared', condition: 'do x' }),
      ]),
    ).toBeNull();
  });

  it('returns null when last goal_status is aborted', () => {
    expect(
      findGoalToRestore([
        goalItem({ kind: 'set', condition: 'do x' }),
        goalItem({ kind: 'aborted', condition: 'do x' }),
      ]),
    ).toBeNull();
  });

  it('returns null when last goal_status is failed', () => {
    expect(
      findGoalToRestore([
        goalItem({ kind: 'set', condition: 'do x' }),
        goalItem({ kind: 'failed', condition: 'do x' }),
      ]),
    ).toBeNull();
  });
});

describe('restoreGoalFromHistory', () => {
  beforeEach(() => __resetActiveGoalStoreForTests());
  afterEach(() => __resetActiveGoalStoreForTests());

  it('restores an active goal and re-registers the hook', () => {
    const cfg = makeConfig();
    const result = restoreGoalFromHistory(
      [goalItem({ kind: 'set', condition: 'write hello' })],
      cfg,
    );
    expect(result).toEqual({ restored: true, condition: 'write hello' });
    expect(getActiveGoal('sess-1')).toMatchObject({ condition: 'write hello' });
  });

  it('resumes the iteration count so the MAX cap is not reset on resume', () => {
    const cfg = makeConfig();
    const result = restoreGoalFromHistory(
      [
        goalItem({ kind: 'set', condition: 'write hello' }),
        userItem(),
        goalItem({ kind: 'checking', condition: 'write hello', iterations: 7 }),
      ],
      cfg,
    );
    expect(result).toEqual({ restored: true, condition: 'write hello' });
    expect(getActiveGoal('sess-1')).toMatchObject({
      condition: 'write hello',
      iterations: 7,
    });
  });

  it('does nothing when no goal_status item exists', () => {
    const cfg = makeConfig();
    const result = restoreGoalFromHistory([userItem()], cfg);
    expect(result).toEqual({ restored: false });
    expect(getActiveGoal('sess-1')).toBeUndefined();
  });

  it('skips restore when workspace is no longer trusted and clears stale in-memory goal', () => {
    setActiveGoal('sess-1', {
      condition: 'stale goal',
      iterations: 0,
      setAt: 100,
      tokensAtStart: 0,
      hookId: 'stale-hook',
    });
    const cfg = makeConfig({
      isTrustedFolder: vi.fn().mockReturnValue(false),
    } as unknown as Partial<Config>);
    const result = restoreGoalFromHistory(
      [goalItem({ kind: 'set', condition: 'do x' })],
      cfg,
    );
    expect(result).toEqual({ restored: false });
    expect(getActiveGoal('sess-1')).toBeUndefined();
  });

  it('skips restore when hooks are disabled by policy', () => {
    const cfg = makeConfig({
      getDisableAllHooks: vi.fn().mockReturnValue(true),
    } as unknown as Partial<Config>);
    const result = restoreGoalFromHistory(
      [goalItem({ kind: 'set', condition: 'do x' })],
      cfg,
    );
    expect(result).toEqual({ restored: false });
  });

  it('skips restore when hook system is unavailable', () => {
    const cfg = makeConfig({
      getHookSystem: vi.fn().mockReturnValue(undefined),
    } as unknown as Partial<Config>);
    const result = restoreGoalFromHistory(
      [goalItem({ kind: 'set', condition: 'do x' })],
      cfg,
    );
    expect(result).toEqual({ restored: false });
  });

  it('rehydrates the last completed goal cache from history on resume', () => {
    const cfg = makeConfig();
    restoreGoalFromHistory(
      [
        goalItem({ kind: 'set', condition: 'goal A' }),
        goalItem({
          kind: 'achieved',
          condition: 'goal A',
          iterations: 4,
          durationMs: 30_000,
          lastReason: 'evidence in transcript',
        }),
      ],
      cfg,
    );
    expect(getLastGoalTerminal('sess-1')).toMatchObject({
      kind: 'achieved',
      condition: 'goal A',
      iterations: 4,
      durationMs: 30_000,
      lastReason: 'evidence in transcript',
    });
  });

  it('restores the terminal observer when an active goal is restored', () => {
    const recordSlashCommand = vi.fn();
    const cfg = makeConfig({
      getChatRecordingService: vi.fn().mockReturnValue({ recordSlashCommand }),
    } as unknown as Partial<Config>);
    const addItem = vi.fn();

    const result = restoreGoalFromHistory(
      [goalItem({ kind: 'checking', condition: 'do x' })],
      cfg,
      addItem,
    );

    expect(result).toEqual({ restored: true, condition: 'do x' });

    notifyGoalTerminal('sess-1', {
      kind: 'achieved',
      condition: 'do x',
      iterations: 2,
      durationMs: 12_000,
      lastReason: 'done',
    });

    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'goal_status',
        kind: 'achieved',
        condition: 'do x',
        iterations: 2,
        durationMs: 12_000,
        lastReason: 'done',
      }),
      expect.any(Number),
    );
    expect(recordSlashCommand).toHaveBeenCalledWith({
      phase: 'result',
      rawCommand: '/goal',
      outputHistoryItems: [
        expect.objectContaining({
          type: 'goal_status',
          kind: 'achieved',
          condition: 'do x',
          iterations: 2,
          durationMs: 12_000,
          lastReason: 'done',
        }),
      ],
    });
  });
});

describe('findLastTerminalGoal', () => {
  it('returns null when transcript has no terminal goal_status', () => {
    expect(findLastTerminalGoal([])).toBeNull();
    expect(
      findLastTerminalGoal([
        goalItem({ kind: 'set', condition: 'x' }),
        userItem(),
      ]),
    ).toBeNull();
  });

  it('returns the most recent achieved, skipping `set` and `cleared`', () => {
    // Aligned with Claude Code's `yjK`: sentinel-style entries (set / cleared)
    // are skipped, so a trailing `cleared` does NOT dismiss an earlier
    // achievement — subsequent empty `/goal` still surfaces it.
    const result = findLastTerminalGoal([
      goalItem({ kind: 'set', condition: 'goal A' }),
      goalItem({ kind: 'achieved', condition: 'goal A', iterations: 2 }),
      goalItem({ kind: 'set', condition: 'goal B' }),
      goalItem({ kind: 'cleared', condition: 'goal B' }),
    ]);
    expect(result).toMatchObject({ kind: 'achieved', condition: 'goal A' });
  });

  it('returns aborted when it is the most recent terminal', () => {
    const result = findLastTerminalGoal([
      goalItem({ kind: 'achieved', condition: 'goal A' }),
      goalItem({ kind: 'set', condition: 'goal B' }),
      goalItem({ kind: 'aborted', condition: 'goal B' }),
    ]);
    expect(result?.kind).toBe('aborted');
    expect(result?.condition).toBe('goal B');
  });

  it('returns failed when it is the most recent terminal', () => {
    const result = findLastTerminalGoal([
      goalItem({ kind: 'achieved', condition: 'goal A' }),
      goalItem({ kind: 'set', condition: 'goal B' }),
      goalItem({
        kind: 'failed',
        condition: 'goal B',
        lastReason: 'external service unavailable',
      }),
    ]);
    expect(result).toMatchObject({
      kind: 'failed',
      condition: 'goal B',
      lastReason: 'external service unavailable',
    });
  });
});

const slashCommandRecord = (
  outputHistoryItems: Array<Record<string, unknown>>,
  phase: 'invocation' | 'result' = 'result',
): ChatRecord =>
  ({
    uuid: 'rec-1',
    parentUuid: null,
    sessionId: 'sess-1',
    timestamp: new Date(0).toISOString(),
    type: 'system',
    subtype: 'slash_command',
    cwd: '/w',
    version: '1.0.0',
    systemPayload: { phase, rawCommand: '/goal', outputHistoryItems },
  }) as unknown as ChatRecord;

describe('parseGoalStatusItem', () => {
  it('rebuilds a goal card, dropping absent optional fields', () => {
    expect(
      parseGoalStatusItem({
        type: 'goal_status',
        kind: 'set',
        condition: 'ship it',
        setAt: 42,
      }),
    ).toEqual({
      type: 'goal_status',
      kind: 'set',
      condition: 'ship it',
      setAt: 42,
    });
  });

  it('keeps iterations, durationMs and lastReason when present', () => {
    expect(
      parseGoalStatusItem({
        type: 'goal_status',
        kind: 'achieved',
        condition: 'ship it',
        iterations: 3,
        durationMs: 1000,
        lastReason: 'tests pass',
      }),
    ).toEqual({
      type: 'goal_status',
      kind: 'achieved',
      condition: 'ship it',
      iterations: 3,
      durationMs: 1000,
      lastReason: 'tests pass',
    });
  });

  it('returns null for non-goal items', () => {
    expect(parseGoalStatusItem({ type: 'assistant', text: 'hi' })).toBeNull();
  });

  it('returns null for an unknown kind', () => {
    expect(
      parseGoalStatusItem({
        type: 'goal_status',
        kind: 'bogus',
        condition: 'x',
      }),
    ).toBeNull();
  });

  it('returns null when condition is missing or not a string', () => {
    expect(
      parseGoalStatusItem({ type: 'goal_status', kind: 'set' }),
    ).toBeNull();
    expect(
      parseGoalStatusItem({ type: 'goal_status', kind: 'set', condition: 7 }),
    ).toBeNull();
  });

  it('drops non-finite numeric fields rather than propagating NaN', () => {
    expect(
      parseGoalStatusItem({
        type: 'goal_status',
        kind: 'set',
        condition: 'x',
        setAt: Number.NaN,
        iterations: '3',
      }),
    ).toEqual({ type: 'goal_status', kind: 'set', condition: 'x' });
  });
});

describe('collectGoalStatusItemsFromRecords', () => {
  it('collects goal cards from slash_command result records, oldest first', () => {
    const items = collectGoalStatusItemsFromRecords([
      slashCommandRecord([
        { type: 'goal_status', kind: 'set', condition: 'goal A' },
      ]),
      slashCommandRecord([
        { type: 'assistant', text: 'chatter' },
        {
          type: 'goal_status',
          kind: 'checking',
          condition: 'goal A',
          iterations: 2,
        },
      ]),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['set', 'checking']);
    expect(items[1]).toMatchObject({ condition: 'goal A', iterations: 2 });
  });

  it('ignores invocation-phase records', () => {
    expect(
      collectGoalStatusItemsFromRecords([
        slashCommandRecord(
          [{ type: 'goal_status', kind: 'set', condition: 'goal A' }],
          'invocation',
        ),
      ]),
    ).toEqual([]);
  });

  it('ignores non-slash_command system records and other record types', () => {
    const compression = {
      ...slashCommandRecord([]),
      subtype: 'chat_compression',
    } as ChatRecord;
    const user = { ...slashCommandRecord([]), type: 'user' } as ChatRecord;
    expect(collectGoalStatusItemsFromRecords([compression, user])).toEqual([]);
  });

  it('feeds findGoalToRestore so a daemon transcript restores its iteration count', () => {
    const items = collectGoalStatusItemsFromRecords([
      slashCommandRecord([
        { type: 'goal_status', kind: 'set', condition: 'goal A' },
      ]),
      slashCommandRecord([
        {
          type: 'goal_status',
          kind: 'checking',
          condition: 'goal A',
          iterations: 4,
        },
      ]),
    ]);
    expect(findGoalToRestore(items)).toEqual({
      condition: 'goal A',
      iterations: 4,
    });
  });

  it('yields no restorable goal once the transcript records a terminal card', () => {
    const items = collectGoalStatusItemsFromRecords([
      slashCommandRecord([
        { type: 'goal_status', kind: 'set', condition: 'goal A' },
      ]),
      slashCommandRecord([
        {
          type: 'goal_status',
          kind: 'achieved',
          condition: 'goal A',
          iterations: 2,
          durationMs: 500,
        },
      ]),
    ]);
    expect(findGoalToRestore(items)).toBeNull();
    expect(findLastTerminalGoal(items)).toMatchObject({
      kind: 'achieved',
      condition: 'goal A',
    });
  });
});

describe('restoreGoalFromHistory condition cap', () => {
  beforeEach(() => __resetActiveGoalStoreForTests());
  afterEach(() => __resetActiveGoalStoreForTests());

  it('restores a condition exactly at the cap', () => {
    const cfg = makeConfig();
    const condition = 'x'.repeat(MAX_GOAL_LENGTH);
    expect(restoreGoalFromHistory([goalItem({ condition })], cfg)).toEqual({
      restored: true,
      condition,
    });
  });

  it('refuses a transcript whose condition exceeds the cap', () => {
    // `/goal` caps the condition at set time, but a transcript is a file on
    // disk: a corrupted or hand-edited one must not re-register an unbounded
    // condition that then rides along in every judge call.
    const cfg = makeConfig();
    const condition = 'x'.repeat(MAX_GOAL_LENGTH + 1);
    expect(restoreGoalFromHistory([goalItem({ condition })], cfg)).toEqual({
      restored: false,
    });
    expect(getActiveGoal('sess-1')).toBeUndefined();
  });

  it('drops a stale in-memory goal when the transcript condition is oversized', () => {
    setActiveGoal('sess-1', {
      condition: 'stale goal',
      iterations: 0,
      setAt: 100,
      tokensAtStart: 0,
      hookId: 'stale-hook',
    });
    const cfg = makeConfig();
    restoreGoalFromHistory(
      [goalItem({ condition: 'x'.repeat(MAX_GOAL_LENGTH + 1) })],
      cfg,
    );
    expect(getActiveGoal('sess-1')).toBeUndefined();
  });
});
