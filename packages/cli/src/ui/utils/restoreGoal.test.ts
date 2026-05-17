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
  type Config,
} from '@qwen-code/qwen-code-core';
import type { HistoryItem } from '../types.js';
import {
  findGoalToRestore,
  findLastTerminalGoal,
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

  it('returns the condition when last goal_status is set', () => {
    expect(
      findGoalToRestore([
        goalItem({ kind: 'achieved', condition: 'old goal' }),
        goalItem({ kind: 'set', condition: 'fresh goal' }),
        userItem(),
      ]),
    ).toBe('fresh goal');
  });

  it('returns the condition when last goal_status is checking', () => {
    expect(
      findGoalToRestore([
        goalItem({ kind: 'set', condition: 'fresh goal' }),
        userItem(),
        goalItem({ kind: 'checking', condition: 'fresh goal' }),
      ]),
    ).toBe('fresh goal');
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
});
