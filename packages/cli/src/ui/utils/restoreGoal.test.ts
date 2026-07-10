/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import {
  __resetActiveGoalStoreForTests,
  getActiveGoal,
  getLastGoalTerminal,
  notifyGoalTerminal,
  setActiveGoal,
  setGoalTerminalObserver,
  type ChatRecord,
  type Config,
} from '@qwen-code/qwen-code-core';
import type { HistoryItem } from '../types.js';
import {
  collectGoalStatusItemsFromRecords,
  findGoalToRestore,
  findLastTerminalGoal,
  MAX_GOAL_LENGTH,
  goalTerminalEventToHistoryItem,
  parseGoalStatusItem,
  recordGoalStatusItem,
  restoreGoalFromHistory,
  type GoalStatusItem,
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
    expect(result).toEqual({
      restored: false,
      blockedBy: 'untrusted-folder',
    });
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
    expect(result).toEqual({ restored: false, blockedBy: 'hooks-disabled' });
  });

  it('skips restore when hook system is unavailable', () => {
    const cfg = makeConfig({
      getHookSystem: vi.fn().mockReturnValue(undefined),
    } as unknown as Partial<Config>);
    const result = restoreGoalFromHistory(
      [goalItem({ kind: 'set', condition: 'do x' })],
      cfg,
    );
    expect(result).toEqual({ restored: false, blockedBy: 'no-hook-system' });
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

  it.each([
    ['an active goal is restored', 'checking' as const],
    ['there is no goal to restore', 'achieved' as const],
  ])(
    'tears down an existing terminal observer when %s and no addItem is given',
    (_label, kind) => {
      // The ACP path calls restore without `addItem` and relies on this: every
      // exit re-enters `unregisterGoalHook`, which clears the observer table.
      // `acpAgent.#restoreGoalOnResume` reinstalls the Session's observer
      // afterwards. If that ever stops being true, a restored goal reaches its
      // terminal state with nobody listening — this pins the reason why.
      const observer = vi.fn();
      setGoalTerminalObserver('sess-1', observer);

      restoreGoalFromHistory(
        [goalItem({ kind, condition: 'do x' })],
        makeConfig(),
      );

      notifyGoalTerminal('sess-1', {
        kind: 'achieved',
        condition: 'do x',
        iterations: 1,
        durationMs: 10,
      });
      expect(observer).not.toHaveBeenCalled();
    },
  );
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
      blockedBy: 'condition-invalid',
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

describe('goalTerminalEventToHistoryItem', () => {
  it('keeps lastReason when the judge produced one', () => {
    expect(
      goalTerminalEventToHistoryItem({
        kind: 'achieved',
        condition: 'ship it',
        iterations: 2,
        durationMs: 900,
        lastReason: 'tests pass',
      }),
    ).toMatchObject({ kind: 'achieved', lastReason: 'tests pass' });
  });

  it('falls back to systemMessage when the judge never ran', () => {
    // `aborted` events carry the cap message in systemMessage, not lastReason.
    expect(
      goalTerminalEventToHistoryItem({
        kind: 'aborted',
        condition: 'ship it',
        iterations: 50,
        durationMs: 900,
        systemMessage: 'Goal max iterations reached; cleared.',
      }),
    ).toMatchObject({
      kind: 'aborted',
      lastReason: 'Goal max iterations reached; cleared.',
    });
  });

  it('prefers lastReason over systemMessage when both are present', () => {
    // Known lossy collapse: HistoryItemGoalStatus has no systemMessage field.
    expect(
      goalTerminalEventToHistoryItem({
        kind: 'aborted',
        condition: 'ship it',
        iterations: 50,
        durationMs: 900,
        lastReason: 'two tests still fail',
        systemMessage: 'Goal max iterations reached; cleared.',
      }).lastReason,
    ).toBe('two tests still fail');
  });
});

describe('parseGoalStatusItem keeps oversized cards so ordering survives', () => {
  beforeEach(() => __resetActiveGoalStoreForTests());
  afterEach(() => __resetActiveGoalStoreForTests());

  const oversized = 'x'.repeat(MAX_GOAL_LENGTH + 1);

  it('parses an oversized card rather than dropping it', () => {
    // Rejecting at parse time looks like a tidy shared gate, but the scanners
    // below decide on the LAST goal card. Dropping one silently promotes the
    // card before it.
    expect(
      parseGoalStatusItem({
        type: 'goal_status',
        kind: 'cleared',
        condition: oversized,
      }),
    ).toMatchObject({ kind: 'cleared' });
  });

  it('lets an oversized cleared card still cancel an earlier goal', () => {
    // If parse dropped the `cleared` card, findGoalToRestore would walk past it
    // to `set` and resurrect a goal the user explicitly cleared — the exact bug
    // persisting `cleared` exists to prevent.
    const items = collectGoalStatusItemsFromRecords([
      slashCommandRecord([
        { type: 'goal_status', kind: 'set', condition: 'goal A' },
      ]),
      slashCommandRecord([
        { type: 'goal_status', kind: 'cleared', condition: oversized },
      ]),
    ]);

    expect(findGoalToRestore(items)).toBeNull();
    expect(restoreGoalFromHistory(items, makeConfig())).toEqual({
      restored: false,
    });
    expect(getActiveGoal('sess-1')).toBeUndefined();
  });

  it('fails closed on an oversized set card instead of restoring an older goal', () => {
    const items = collectGoalStatusItemsFromRecords([
      slashCommandRecord([
        { type: 'goal_status', kind: 'set', condition: 'goal A' },
      ]),
      slashCommandRecord([
        { type: 'goal_status', kind: 'set', condition: oversized },
      ]),
    ]);

    // The newest card wins the scan, and the length gate then refuses it. Goal
    // A must NOT come back to life.
    expect(findGoalToRestore(items)?.condition).toBe(oversized);
    expect(restoreGoalFromHistory(items, makeConfig())).toEqual({
      restored: false,
      blockedBy: 'condition-invalid',
    });
    expect(getActiveGoal('sess-1')).toBeUndefined();
  });
});

describe('transcript payloads are untrusted', () => {
  // A transcript is a file on disk. Anything in it may have been hand-edited,
  // truncated, or written by an older version. A throw here is not contained:
  // `#restoreGoalOnResume` catches it and skips the hook, leaving a replayed
  // `set` card on screen with nothing driving it.

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', []],
    ['a string', 'goal_status'],
    ['a number', 7],
  ])('parseGoalStatusItem returns null for %s', (_label, value) => {
    expect(parseGoalStatusItem(value)).toBeNull();
  });

  it('collectGoalStatusItemsFromRecords skips a non-array outputHistoryItems', () => {
    const record = {
      type: 'system',
      subtype: 'slash_command',
      systemPayload: {
        phase: 'result',
        // A plain object, not an array: `for..of` would throw.
        outputHistoryItems: { type: 'goal_status', kind: 'set' },
      },
    } as unknown as ChatRecord;
    expect(collectGoalStatusItemsFromRecords([record])).toEqual([]);
  });

  it('collectGoalStatusItemsFromRecords skips null entries and keeps later valid cards', () => {
    const record = {
      type: 'system',
      subtype: 'slash_command',
      systemPayload: {
        phase: 'result',
        outputHistoryItems: [
          null,
          'not an object',
          { type: 'goal_status', kind: 'set', condition: 'survives' },
        ],
      },
    } as unknown as ChatRecord;
    expect(collectGoalStatusItemsFromRecords([record])).toEqual([
      { type: 'goal_status', kind: 'set', condition: 'survives' },
    ]);
  });
});

describe('restoreGoalFromHistory carries the original start time', () => {
  beforeEach(() => __resetActiveGoalStoreForTests());
  afterEach(() => __resetActiveGoalStoreForTests());

  it('restores setAt from the set card rather than restarting the clock', () => {
    const cfg = makeConfig();
    restoreGoalFromHistory(
      [goalItem({ kind: 'set', condition: 'do x', setAt: 1000 })],
      cfg,
    );
    expect(getActiveGoal('sess-1')).toMatchObject({ setAt: 1000 });
  });

  it('finds setAt on the set card when the newest card is a checking card', () => {
    // `checking` cards written before this change carry no setAt at all, so the
    // scan has to walk back to the `set` card that opened the run.
    const cfg = makeConfig();
    restoreGoalFromHistory(
      [
        goalItem({ kind: 'set', condition: 'do x', setAt: 1000 }),
        userItem(),
        goalItem({ kind: 'checking', condition: 'do x', iterations: 3 }),
      ],
      cfg,
    );
    expect(getActiveGoal('sess-1')).toMatchObject({
      setAt: 1000,
      iterations: 3,
    });
  });

  it('does not borrow setAt from a previous, already-finished goal', () => {
    const cfg = makeConfig();
    const now = Date.now();
    restoreGoalFromHistory(
      [
        goalItem({ kind: 'set', condition: 'goal A', setAt: 1000 }),
        goalItem({ kind: 'achieved', condition: 'goal A', durationMs: 5 }),
        // Goal B's own `set` card is gone (truncated transcript).
        goalItem({ kind: 'checking', condition: 'goal B', iterations: 1 }),
      ],
      cfg,
    );
    const goal = getActiveGoal('sess-1');
    expect(goal).toMatchObject({ condition: 'goal B' });
    expect(goal!.setAt).not.toBe(1000);
    expect(goal!.setAt).toBeGreaterThanOrEqual(now);
  });

  it('ignores a non-positive setAt from a corrupted transcript', () => {
    const cfg = makeConfig();
    const now = Date.now();
    restoreGoalFromHistory(
      [goalItem({ kind: 'set', condition: 'do x', setAt: 0 })],
      cfg,
    );
    expect(getActiveGoal('sess-1')!.setAt).toBeGreaterThanOrEqual(now);
  });
});

describe('restoreGoalFromHistory refuses an empty condition', () => {
  beforeEach(() => __resetActiveGoalStoreForTests());
  afterEach(() => __resetActiveGoalStoreForTests());

  it('does not register a hook for a blank condition', () => {
    // `/goal` never sets one — a bare `/goal` reports status. Only a corrupted
    // transcript gets here, and a blank condition makes every judge call ask
    // the model to check nothing.
    const cfg = makeConfig();
    expect(
      restoreGoalFromHistory([goalItem({ kind: 'set', condition: '' })], cfg),
    ).toEqual({ restored: false, blockedBy: 'condition-invalid' });
    expect(getActiveGoal('sess-1')).toBeUndefined();
  });
});

describe('recordGoalStatusItem', () => {
  let stderr: MockInstance<typeof process.stderr.write>;
  beforeEach(() => {
    stderr = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true) as MockInstance<typeof process.stderr.write>;
  });
  afterEach(() => stderr.mockRestore());

  const item = {
    type: 'goal_status',
    kind: 'set',
    condition: 'do x',
  } as GoalStatusItem;

  it('warns when there is no chat recording service to persist the card', () => {
    // Optional chaining used to swallow this: the goal then works for the rest
    // of the session and silently fails to come back on resume.
    recordGoalStatusItem(
      makeConfig({
        getChatRecordingService: vi.fn().mockReturnValue(undefined),
      } as unknown as Partial<Config>),
      item,
    );
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('no chat recording service'),
    );
  });

  it('warns but does not throw when the recording write fails', () => {
    const cfg = makeConfig({
      getChatRecordingService: vi.fn().mockReturnValue({
        recordSlashCommand: vi.fn().mockImplementation(() => {
          throw new Error('disk full');
        }),
      }),
    } as unknown as Partial<Config>);
    expect(() => recordGoalStatusItem(cfg, item)).not.toThrow();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('failed to record goal_status'),
    );
  });
});
