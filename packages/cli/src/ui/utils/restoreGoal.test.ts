/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ChatRecord } from '@qwen-code/qwen-code-core';
import type { HistoryItem } from '../types.js';
import {
  collectGoalStatusItemsFromRecords,
  findGoalToRestore,
  parseGoalStatusItem,
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
  });
});

describe('findGoalToRestore has no condition cap', () => {
  it('returns a condition far longer than the old 4,000-char cap', () => {
    // `/goal` accepts a condition of any length (#6665). A cap here would
    // refuse, on reload, a goal the user legitimately set — and the replay
    // drops the card too, so they would never see why it vanished.
    const condition = 'x'.repeat(10_000);
    expect(findGoalToRestore([goalItem({ condition })])).toEqual({
      condition,
      iterations: 0,
    });
  });
});

describe('parseGoalStatusItem keeps refusable cards so ordering survives', () => {
  it('parses a card whose condition is empty rather than dropping it', () => {
    // Rejecting at parse time looks like a tidy shared gate, but the scanners
    // below decide on the LAST goal card. Dropping one silently promotes the
    // card before it.
    expect(
      parseGoalStatusItem({
        type: 'goal_status',
        kind: 'cleared',
        condition: '',
      }),
    ).toMatchObject({ kind: 'cleared' });
  });

  it('lets a card with an empty condition still cancel an earlier goal', () => {
    // If parse dropped the `cleared` card, findGoalToRestore would walk past it
    // to `set` and resurrect a goal the user explicitly cleared — the exact bug
    // persisting `cleared` exists to prevent.
    const items = collectGoalStatusItemsFromRecords([
      slashCommandRecord([
        { type: 'goal_status', kind: 'set', condition: 'goal A' },
      ]),
      slashCommandRecord([
        { type: 'goal_status', kind: 'cleared', condition: '' },
      ]),
    ]);

    expect(findGoalToRestore(items)).toBeNull();
  });

  it('fails closed on an empty set card instead of restoring an older goal', () => {
    const items = collectGoalStatusItemsFromRecords([
      slashCommandRecord([
        { type: 'goal_status', kind: 'set', condition: 'goal A' },
      ]),
      slashCommandRecord([{ type: 'goal_status', kind: 'set', condition: '' }]),
    ]);

    // The newest card wins the scan, so goal A must NOT come back to life;
    // the empty condition is reported as-is for the caller to refuse.
    expect(findGoalToRestore(items)?.condition).toBe('');
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

describe('findGoalToRestore carries the original start time', () => {
  it('reads setAt off the set card rather than restarting the clock', () => {
    expect(
      findGoalToRestore([
        goalItem({ kind: 'set', condition: 'do x', setAt: 1000 }),
      ]),
    ).toMatchObject({ setAt: 1000 });
  });

  it('finds setAt on the set card when the newest card is a checking card', () => {
    // `checking` cards written before this change carry no setAt at all, so the
    // scan has to walk back to the `set` card that opened the run.
    expect(
      findGoalToRestore([
        goalItem({ kind: 'set', condition: 'do x', setAt: 1000 }),
        userItem(),
        goalItem({ kind: 'checking', condition: 'do x', iterations: 3 }),
      ]),
    ).toEqual({ condition: 'do x', iterations: 3, setAt: 1000 });
  });

  it('does not borrow setAt from a previous, already-finished goal', () => {
    const goal = findGoalToRestore([
      goalItem({ kind: 'set', condition: 'goal A', setAt: 1000 }),
      goalItem({ kind: 'achieved', condition: 'goal A', durationMs: 5 }),
      // Goal B's own `set` card is gone (truncated transcript).
      goalItem({ kind: 'checking', condition: 'goal B', iterations: 1 }),
    ]);
    expect(goal).toEqual({ condition: 'goal B', iterations: 1 });
    expect(goal).not.toHaveProperty('setAt');
  });

  it('does not borrow setAt from a previous goal that has no terminal card', () => {
    // The run-boundary scan cannot rely on a terminal card being there: a
    // truncated or hand-edited transcript can put two goals back to back. The
    // condition is what identifies the run, so goal B must not inherit goal A's
    // clock just because nothing separates them.
    const goal = findGoalToRestore([
      goalItem({ kind: 'set', condition: 'goal A', setAt: 1000 }),
      goalItem({ kind: 'checking', condition: 'goal A', iterations: 2 }),
      // Goal B's own `set` card survived but lost its setAt, and no terminal
      // card was ever written for goal A.
      goalItem({ kind: 'set', condition: 'goal B' }),
      goalItem({ kind: 'checking', condition: 'goal B', iterations: 1 }),
    ]);
    expect(goal).toEqual({ condition: 'goal B', iterations: 1 });
    expect(goal).not.toHaveProperty('setAt');
  });
});
