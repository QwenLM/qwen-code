/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goalCommand } from './goalCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  __resetActiveGoalStoreForTests,
  clearActiveGoal,
  notifyGoalTerminal,
} from '@qwen-code/qwen-code-core';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    getSessionId: vi.fn().mockReturnValue('sess-1'),
    isTrustedFolder: vi.fn().mockReturnValue(true),
    getDisableAllHooks: vi.fn().mockReturnValue(false),
    getHookSystem: vi.fn().mockReturnValue({
      addFunctionHook: vi.fn().mockReturnValue('hook-1'),
      removeFunctionHook: vi.fn().mockReturnValue(true),
    }),
    ...overrides,
  } as unknown as Config;
}

describe('goalCommand', () => {
  beforeEach(() => __resetActiveGoalStoreForTests());
  afterEach(() => __resetActiveGoalStoreForTests());

  it('is currently limited to interactive mode', () => {
    expect(goalCommand.supportedModes).toEqual(['interactive']);
  });

  it('rejects when config is missing', async () => {
    const ctx = createMockCommandContext();
    const result = await goalCommand.action!(ctx, 'do x');
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
    });
  });

  it('shows status (no goal) for empty args', async () => {
    const ctx = createMockCommandContext({
      services: { config: makeConfig() as unknown as Config },
    });
    const result = await goalCommand.action!(ctx, '');
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
    });
    expect((result as { content: string }).content).toMatch(/no goal set/i);
  });

  it('blocks /goal in untrusted folder', async () => {
    const ctx = createMockCommandContext({
      services: {
        config: makeConfig({
          isTrustedFolder: vi.fn().mockReturnValue(false),
        } as unknown as Partial<Config>),
      },
    });
    const result = await goalCommand.action!(ctx, 'do x');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect((result as { content: string }).content).toMatch(/trusted/i);
  });

  it('blocks /goal when hooks are disabled by policy', async () => {
    const ctx = createMockCommandContext({
      services: {
        config: makeConfig({
          getDisableAllHooks: vi.fn().mockReturnValue(true),
        } as unknown as Partial<Config>),
      },
    });
    const result = await goalCommand.action!(ctx, 'do x');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect((result as { content: string }).content).toMatch(/disabled/i);
  });

  it('rejects oversized conditions', async () => {
    const ctx = createMockCommandContext({
      services: { config: makeConfig() as unknown as Config },
    });
    const result = await goalCommand.action!(ctx, 'x'.repeat(4001));
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect((result as { content: string }).content).toMatch(/limited/i);
  });

  it('clears existing goal on clear keyword and emits a cleared card', async () => {
    const cfg = makeConfig();
    const ctx = createMockCommandContext({
      services: { config: cfg as unknown as Config },
    });
    await goalCommand.action!(ctx, 'write hello');
    const before = (ctx.ui.addItem as ReturnType<typeof vi.fn>).mock.calls
      .length;
    const result = await goalCommand.action!(ctx, 'clear');
    expect(result).toBeUndefined();
    const after = (ctx.ui.addItem as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(after).toBe(before + 1);
    const lastItem = (ctx.ui.addItem as ReturnType<typeof vi.fn>).mock.calls[
      after - 1
    ][0];
    expect(lastItem).toMatchObject({
      type: 'goal_status',
      kind: 'cleared',
      condition: 'write hello',
    });
  });

  it('returns info when clearing a non-existent goal', async () => {
    const ctx = createMockCommandContext({
      services: { config: makeConfig() as unknown as Config },
    });
    const result = await goalCommand.action!(ctx, 'cancel');
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
      content: 'No goal set.',
    });
  });

  it('registers the hook and submits an instructional prompt on set', async () => {
    const ctx = createMockCommandContext({
      services: { config: makeConfig() as unknown as Config },
    });
    const result = await goalCommand.action!(ctx, 'write a hello world script');
    expect(result).toMatchObject({ type: 'submit_prompt' });
    const submit = result as { content: Array<{ text: string }> };
    expect(submit.content[0].text).toMatch(/Stop hook is now active/i);
    expect(submit.content[0].text).toMatch(/write a hello world script/);

    const setCall = (ctx.ui.addItem as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(setCall).toMatchObject({
      type: 'goal_status',
      kind: 'set',
      condition: 'write a hello world script',
    });
  });

  it('shows active goal status when re-invoked with empty args', async () => {
    const ctx = createMockCommandContext({
      services: { config: makeConfig() as unknown as Config },
    });
    await goalCommand.action!(ctx, 'do x');
    const result = await goalCommand.action!(ctx, '');
    expect((result as { content: string }).content).toMatch(
      /Goal active: do x/,
    );
  });

  it('forwards core terminal events into a goal_status history item', async () => {
    const ctx = createMockCommandContext({
      services: { config: makeConfig() as unknown as Config },
    });
    await goalCommand.action!(ctx, 'do x');
    const addItem = ctx.ui.addItem as ReturnType<typeof vi.fn>;
    const beforeCount = addItem.mock.calls.length;

    notifyGoalTerminal('sess-1', {
      kind: 'achieved',
      condition: 'do x',
      iterations: 3,
      durationMs: 12_345,
      lastReason: 'quoted evidence from transcript',
    });

    expect(addItem.mock.calls.length).toBe(beforeCount + 1);
    const lastItem = addItem.mock.calls.at(-1)![0];
    expect(lastItem).toMatchObject({
      type: 'goal_status',
      kind: 'achieved',
      condition: 'do x',
      iterations: 3,
      durationMs: 12_345,
      lastReason: 'quoted evidence from transcript',
    });
  });

  it('records terminal events through the chat recording service', async () => {
    const recordSlashCommand = vi.fn();
    const ctx = createMockCommandContext({
      services: {
        config: makeConfig({
          getChatRecordingService: vi.fn().mockReturnValue({
            recordSlashCommand,
          }),
        } as unknown as Partial<Config>) as unknown as Config,
      },
    });

    await goalCommand.action!(ctx, 'do x');

    notifyGoalTerminal('sess-1', {
      kind: 'achieved',
      condition: 'do x',
      iterations: 3,
      durationMs: 12_345,
      lastReason: 'quoted evidence from transcript',
    });

    expect(recordSlashCommand).toHaveBeenCalledWith({
      phase: 'result',
      rawCommand: '/goal',
      outputHistoryItems: [
        expect.objectContaining({
          type: 'goal_status',
          kind: 'achieved',
          condition: 'do x',
          iterations: 3,
          durationMs: 12_345,
          lastReason: 'quoted evidence from transcript',
        }),
      ],
    });
  });

  it('after achievement, empty /goal shows the last completed summary', async () => {
    const ctx = createMockCommandContext({
      services: { config: makeConfig() as unknown as Config },
    });
    await goalCommand.action!(ctx, 'do x');
    // Real flow: hook callback clears active goal BEFORE notifying.
    clearActiveGoal('sess-1');
    notifyGoalTerminal('sess-1', {
      kind: 'achieved',
      condition: 'do x',
      iterations: 3,
      durationMs: 24_000,
      lastReason: 'transcript shows completion',
    });
    const result = await goalCommand.action!(ctx, '');
    const content = (result as { content: string }).content;
    expect(content).toMatch(/Goal achieved/);
    expect(content).toMatch(/3 turns/);
    expect(content).toMatch(/24s/);
    expect(content).toMatch(/Goal: do x/);
    // `Last check:` line is preserved on the achieved summary so the
    // empty-`/goal` re-display matches the inline terminal history card.
    expect(content).toMatch(/Last check: transcript shows completion/);
  });

  it('strict claude alignment: `/goal clear` with no active goal does NOT dismiss the achievement summary', async () => {
    // Claude Code's `woH` bails (`q.length===0 → return null`) when no active
    // goal exists — it does NOT write a dismissal sentinel and does NOT wipe
    // the cache. Subsequent empty `/goal` still surfaces the previous
    // achievement via `findLastTerminalGoal`. We pin this behavior to prevent
    // accidental divergence; users who want a true "forget" will need a
    // separate dedicated keyword (out of scope for this alignment).
    const ctx = createMockCommandContext({
      services: { config: makeConfig() as unknown as Config },
    });
    await goalCommand.action!(ctx, 'do x');
    clearActiveGoal('sess-1');
    notifyGoalTerminal('sess-1', {
      kind: 'achieved',
      condition: 'do x',
      iterations: 3,
      durationMs: 1_000,
    });

    const addItem = ctx.ui.addItem as ReturnType<typeof vi.fn>;
    const beforeClearCount = addItem.mock.calls.length;

    // /goal clear with no active goal: pure no-op informational message
    const clearResult = await goalCommand.action!(ctx, 'clear');
    expect(clearResult).toMatchObject({
      type: 'message',
      messageType: 'info',
      content: 'No goal set.',
    });
    expect(addItem.mock.calls.length).toBe(beforeClearCount);

    // Cache survives — empty /goal still shows the achievement card.
    const afterClear = await goalCommand.action!(ctx, '');
    expect((afterClear as { content: string }).content).toMatch(
      /Goal achieved/,
    );
  });

  it('after abort, empty /goal shows the aborted summary', async () => {
    const ctx = createMockCommandContext({
      services: { config: makeConfig() as unknown as Config },
    });
    await goalCommand.action!(ctx, 'do x');
    clearActiveGoal('sess-1');
    notifyGoalTerminal('sess-1', {
      kind: 'aborted',
      condition: 'do x',
      iterations: 50,
      durationMs: 60_000,
      systemMessage: 'Goal max iterations reached',
    });
    const result = await goalCommand.action!(ctx, '');
    const content = (result as { content: string }).content;
    expect(content).toMatch(/Goal aborted/);
    expect(content).toMatch(/Goal: do x/);
    // No more `Last check:` line — the `systemMessage`/`lastReason` content
    // lives on the goal_status history item (see test below) but is dropped
    // from the empty-/goal summary.
    expect(content).not.toMatch(/Last check/);
  });

  it('falls back to systemMessage as lastReason on aborted events', async () => {
    const ctx = createMockCommandContext({
      services: { config: makeConfig() as unknown as Config },
    });
    await goalCommand.action!(ctx, 'do x');
    const addItem = ctx.ui.addItem as ReturnType<typeof vi.fn>;

    notifyGoalTerminal('sess-1', {
      kind: 'aborted',
      condition: 'do x',
      iterations: 50,
      durationMs: 60_000,
      systemMessage: 'Goal max iterations reached',
    });

    const lastItem = addItem.mock.calls.at(-1)![0];
    expect(lastItem).toMatchObject({
      kind: 'aborted',
      lastReason: 'Goal max iterations reached',
    });
  });
});
