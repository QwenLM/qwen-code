/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fold tests for the premature-done fix: `segment-end` (core `finished`)
 * closes the streaming assistant block but keeps tools running and the turn
 * in flight; only `done` settles open tools.
 */

import { describe, it, expect } from 'vitest';
import {
  describeGoalCard,
  describeLegacyGoalCard,
  foldLiveEvent,
  type LiveHistoryItem,
  type LiveToolItem,
} from './live-session-model.js';
import type { GoalSnapshotLike } from './event-adapter.js';
import { ICON } from '../constants.js';

const assistant = (text: string): LiveHistoryItem => ({
  kind: 'assistant',
  id: 'as1',
  text,
  streaming: true,
});

const runningTool = (id = 'tool1'): LiveToolItem => ({
  kind: 'tool',
  id,
  tool: 'run_shell_command',
  title: 'run_shell_command',
  output: '',
  done: false,
});

const waitingTool = (id = 'tool1'): LiveToolItem => ({
  ...runningTool(id),
  confirm: 'pending',
});

describe('foldLiveEvent segment-end (finished parity)', () => {
  it('closes the streaming assistant block', () => {
    const items = foldLiveEvent([assistant('hello')], { type: 'segment-end' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'assistant', streaming: false });
  });

  it('does NOT settle running tools', () => {
    const items = foldLiveEvent([assistant('x'), runningTool()], {
      type: 'segment-end',
    });
    const tool = items.find((i) => i.kind === 'tool');
    expect(tool).toMatchObject({ done: false });
  });

  it('does NOT settle pending approvals', () => {
    const items = foldLiveEvent([waitingTool()], { type: 'segment-end' });
    expect(items[0]).toMatchObject({ done: false, confirm: 'pending' });
  });

  it('lets the next text delta start a fresh assistant block', () => {
    let items = foldLiveEvent([assistant('first')], { type: 'segment-end' });
    items = foldLiveEvent(items, { type: 'text', delta: 'second' });
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({
      kind: 'assistant',
      text: 'second',
      streaming: true,
    });
  });
});

describe('foldLiveEvent tool-description (invocation getDescription, R1-104)', () => {
  it('overlays the real description onto the running tool item', () => {
    const items = foldLiveEvent([runningTool('t9')], {
      type: 'tool-description',
      id: 't9',
      description: 'Running `npm test` in ./pkg',
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'tool',
      id: 't9',
      description: 'Running `npm test` in ./pkg',
    });
  });

  it('ignores descriptions for unknown call ids', () => {
    const items = foldLiveEvent([runningTool('t1')], {
      type: 'tool-description',
      id: 'missing',
      description: 'orphan',
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 't1' });
    expect((items[0] as LiveToolItem).description).toBeUndefined();
  });
});

describe('foldLiveEvent done (turn end)', () => {
  it('settles open tools as skipped at true turn end', () => {
    const items = foldLiveEvent([runningTool()], { type: 'done' });
    expect(items[0]).toMatchObject({
      kind: 'tool',
      done: true,
      summary: 'skipped',
    });
  });

  it('marks pending approvals rejected', () => {
    const items = foldLiveEvent([waitingTool()], { type: 'done' });
    expect(items[0]).toMatchObject({ done: true, confirm: 'rejected' });
  });
});

describe('foldLiveEvent user (promptId/sentToModel parity)', () => {
  it('carries promptId and sentToModel onto the user item (R1-16)', () => {
    const items = foldLiveEvent([assistant('hi')], {
      type: 'user',
      text: '/help',
      promptId: 'session-1########0',
      sentToModel: false,
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'assistant', streaming: false });
    expect(items[1]).toMatchObject({
      kind: 'user',
      text: '/help',
      promptId: 'session-1########0',
      sentToModel: false,
    });
  });
});

describe('foldLiveEvent image', () => {
  it('pushes an image item and closes the streaming assistant', () => {
    const items = foldLiveEvent([assistant('caption')], {
      type: 'image',
      mimeType: 'image/png',
      data: 'aW1hZ2U=',
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'assistant', streaming: false });
    expect(items[1]).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      data: 'aW1hZ2U=',
    });
  });
});

describe('foldLiveEvent thinking (interleaved thought bursts)', () => {
  it('settles the trailing streaming assistant before a second thought burst', () => {
    let items = foldLiveEvent([], { type: 'text', delta: 'answer start' });
    items = foldLiveEvent(items, { type: 'thinking', delta: 'reconsider' });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'assistant', streaming: false });
    expect(items[1]).toMatchObject({ kind: 'thinking', done: false });
  });

  it('appends to an open thinking block without touching earlier items', () => {
    let items = foldLiveEvent([assistant('x')], {
      type: 'thinking',
      delta: 't1',
    });
    items = foldLiveEvent(items, { type: 'thinking', delta: ' t2' });
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ kind: 'thinking', text: 't1 t2' });
  });

  it('ends the interleaved turn with every assistant block settled', () => {
    // Adapter sequence for text → thought → text (thoughtClosed resets so
    // the second burst is a fresh thinking block): `done` settles only the
    // last item, so the first assistant block must already be closed.
    let items = foldLiveEvent([], { type: 'text', delta: 'before' });
    items = foldLiveEvent(items, { type: 'thinking', delta: 'think' });
    items = foldLiveEvent(items, { type: 'thinking-end' });
    items = foldLiveEvent(items, { type: 'text', delta: 'after' });
    items = foldLiveEvent(items, { type: 'done' });
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ kind: 'assistant', streaming: false });
    expect(items[1]).toMatchObject({ kind: 'thinking', done: true });
    expect(items[2]).toMatchObject({ kind: 'assistant', streaming: false });
  });
});

describe('foldLiveEvent tool-result diff', () => {
  it('stores the structured diff without touching text output', () => {
    let items = foldLiveEvent([], {
      type: 'tool-start',
      id: 'tool1',
      tool: 'edit',
      title: 'edit',
    });
    items = foldLiveEvent(items, {
      type: 'tool-result',
      id: 'tool1',
      display: '',
      diff: { fileDiff: '@@ -1,1 +1,1 @@\n-old\n+new', fileName: 'a.txt' },
    });
    const tool = items[0];
    if (tool.kind !== 'tool') throw new Error('expected tool item');
    expect(tool.output).toBe('');
    expect(tool.diff).toEqual({
      fileDiff: '@@ -1,1 +1,1 @@\n-old\n+new',
      fileName: 'a.txt',
    });
  });
});

describe('foldLiveEvent tool-result ansi', () => {
  it('stores the structured token grid without touching text output', () => {
    let items = foldLiveEvent([], {
      type: 'tool-start',
      id: 'tool1',
      tool: 'run_shell_command',
      title: 'run_shell_command',
    });
    const grid = [
      [
        {
          text: 'ok',
          bold: false,
          italic: false,
          underline: false,
          dim: false,
          inverse: false,
          fg: 'green',
          bg: '',
        },
      ],
    ];
    items = foldLiveEvent(items, {
      type: 'tool-result',
      id: 'tool1',
      display: '',
      ansi: { grid, totalLines: 30, totalBytes: 4096 },
    });
    const tool = items[0];
    if (tool.kind !== 'tool') throw new Error('expected tool item');
    expect(tool.output).toBe('');
    expect(tool.ansi).toEqual({
      grid,
      totalLines: 30,
      totalBytes: 4096,
    });
  });
});

describe('foldLiveEvent compaction', () => {
  it('pushes the compression row as its own history item', () => {
    const compression = {
      isPending: false,
      originalTokenCount: 1000,
      newTokenCount: 200,
      compressionStatus: 1,
    };
    const items = foldLiveEvent([assistant('hi')], {
      type: 'compaction',
      compression,
    });
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({
      kind: 'compaction',
      compression,
    });
  });
});

describe('foldLiveEvent info (chat_compressed parity)', () => {
  it('pushes the info row and settles a streaming assistant block', () => {
    const items = foldLiveEvent([assistant('partial')], {
      type: 'info',
      text: 'IMPORTANT: This conversation approached the input token limit.',
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'assistant', streaming: false });
    expect(items[1]).toMatchObject({
      kind: 'info',
      text: 'IMPORTANT: This conversation approached the input token limit.',
    });
  });
});

describe('foldLiveEvent status rows (ink StatusMessage parity)', () => {
  it('pushes an error row carrying the retry hint', () => {
    const items = foldLiveEvent([assistant('x')], {
      type: 'error',
      text: 'API 429',
      hint: 'Press Ctrl+Y to retry',
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'assistant', streaming: false });
    expect(items[1]).toMatchObject({
      kind: 'error',
      text: 'API 429',
      hint: 'Press Ctrl+Y to retry',
    });
  });

  it('pushes a warning row and a retry row as their own items', () => {
    let items = foldLiveEvent([], {
      type: 'warning',
      text: '✕ blocked',
    });
    items = foldLiveEvent(items, {
      type: 'retry-countdown',
      attempt: 2,
      maxRetries: 3,
      delayMs: 4200,
      message: 'rate limited',
    });
    expect(items).toEqual([
      { kind: 'warning', id: expect.any(String), text: '✕ blocked' },
      {
        kind: 'retry',
        id: expect.any(String),
        attempt: 2,
        maxRetries: 3,
        delayMs: 4200,
        message: 'rate limited',
        startedAt: expect.any(Number),
      },
    ]);
  });

  it('restarts the countdown in place on a second retry event', () => {
    let items = foldLiveEvent([], {
      type: 'retry-countdown',
      attempt: 1,
      maxRetries: 3,
      delayMs: 1000,
    });
    items = foldLiveEvent(items, {
      type: 'retry-countdown',
      attempt: 2,
      maxRetries: 3,
      delayMs: 5000,
      message: 'still limited',
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'retry',
      attempt: 2,
      maxRetries: 3,
      delayMs: 5000,
      message: 'still limited',
    });
  });

  it('clears the retry row on retry-countdown-clear (ink clearRetryCountdown)', () => {
    let items = foldLiveEvent([], {
      type: 'retry-countdown',
      attempt: 1,
      maxRetries: 3,
      delayMs: 1000,
    });
    items = foldLiveEvent(items, { type: 'retry-countdown-clear' });
    expect(items).toEqual([]);
    // No retry row → no-op.
    expect(foldLiveEvent(items, { type: 'retry-countdown-clear' })).toEqual([]);
  });

  it('clears the retry row before pushing an error item (ink handleErrorEvent)', () => {
    let items = foldLiveEvent([], {
      type: 'retry-countdown',
      attempt: 1,
      maxRetries: 3,
      delayMs: 1000,
    });
    items = foldLiveEvent(items, {
      type: 'error',
      text: 'boom',
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'error', text: 'boom' });
  });

  it('clears the retry row when the turn ends (done)', () => {
    let items = foldLiveEvent([], {
      type: 'retry-countdown',
      attempt: 1,
      maxRetries: 3,
      delayMs: 1000,
    });
    items = foldLiveEvent(items, { type: 'done' });
    expect(items).toEqual([]);
  });

  it('pushes a goal card with the snapshot and cause', () => {
    const snapshot = {
      goal: { objective: 'ship it', status: 'active', turnCount: 2 },
      activity: 'running',
    };
    const items = foldLiveEvent([assistant('g')], {
      type: 'goal',
      snapshot,
      cause: 'create',
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'assistant', streaming: false });
    expect(items[1]).toEqual({
      kind: 'goal',
      id: expect.any(String),
      snapshot,
      cause: 'create',
    });
  });

  it('pushes a stop-hook row with the raw message', () => {
    const items = foldLiveEvent([assistant('y')], {
      type: 'stop-hook-message',
      message: 'run the tests',
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'assistant', streaming: false });
    expect(items[1]).toMatchObject({
      kind: 'stop-hook',
      message: 'run the tests',
    });
  });
});

describe('foldLiveEvent tool-output', () => {
  it('appends live output to the running tool card', () => {
    let items = foldLiveEvent([], {
      type: 'tool-start',
      id: 'tool1',
      tool: 'run_shell_command',
      title: 'run_shell_command',
    });
    items = foldLiveEvent(items, {
      type: 'tool-output',
      id: 'tool1',
      delta: 'line1\n',
    });
    items = foldLiveEvent(items, {
      type: 'tool-output',
      id: 'tool1',
      delta: 'line2\n',
    });
    expect(items[0]).toMatchObject({
      kind: 'tool',
      done: false,
      output: 'line1\nline2\n',
    });
  });
});

describe('foldLiveEvent retry-countdown fresh restart (ink parity)', () => {
  it('discards a trailing streaming assistant on a fresh retry', () => {
    const items = foldLiveEvent([assistant('half')], {
      type: 'retry-countdown',
      attempt: 1,
      maxRetries: 3,
      delayMs: 1000,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'retry' });
  });

  it('discards trailing open tools too', () => {
    const items = foldLiveEvent([assistant('x'), runningTool()], {
      type: 'retry-countdown',
      attempt: 1,
      maxRetries: 3,
      delayMs: 1000,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'retry' });
  });

  it('keeps the streamed content on a continuation retry', () => {
    const items = foldLiveEvent([assistant('kept')], {
      type: 'retry-countdown',
      attempt: 1,
      maxRetries: 3,
      delayMs: 1000,
      isContinuation: true,
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: 'assistant',
      text: 'kept',
      streaming: false,
    });
  });

  it('supersedes a just-pushed error row with the countdown', () => {
    let items = foldLiveEvent([], {
      type: 'error',
      text: 'API 429',
      hint: 'Press Ctrl+Y to retry',
    });
    items = foldLiveEvent(items, {
      type: 'retry-countdown',
      attempt: 1,
      maxRetries: 3,
      delayMs: 1000,
      message: 'rate limited',
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'retry',
      message: 'rate limited',
    });
  });
});

describe('foldLiveEvent goal-legacy (/goal command parity)', () => {
  it('pushes a legacy goal card with the kind-form fields', () => {
    const items = foldLiveEvent([assistant('g')], {
      type: 'goal-legacy',
      kind: 'achieved',
      condition: 'tests green',
      iterations: 2,
      durationMs: 5000,
      lastReason: 'all passed',
    });
    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({
      kind: 'goal',
      id: expect.any(String),
      legacy: {
        kind: 'achieved',
        condition: 'tests green',
        iterations: 2,
        durationMs: 5000,
        lastReason: 'all passed',
      },
    });
  });
});

describe('describeGoalCard (ink GoalStateCard)', () => {
  const snap = (
    goal: Record<string, unknown> | null,
    activity = 'idle',
  ): GoalSnapshotLike => ({ goal, activity }) as GoalSnapshotLike;

  it('renders every lifecycle state', () => {
    expect(
      describeGoalCard(snap({ objective: 'o', status: 'active' })),
    ).toMatchObject({
      state: 'card',
      icon: ICON.BULLSEYE,
      color: 'accent',
      title: 'Goal active',
    });
    expect(
      describeGoalCard(snap({ objective: 'o', status: 'active' }, 'verifying')),
    ).toMatchObject({
      state: 'card',
      icon: ICON.CIRCLE_EMPTY,
      color: 'secondary',
      title: 'Goal checking',
    });
    expect(
      describeGoalCard(snap({ objective: 'o', status: 'active' }, 'running')),
    ).toMatchObject({ title: 'Goal running' });
    expect(
      describeGoalCard(snap({ objective: 'o', status: 'paused' })),
    ).toMatchObject({
      icon: '!',
      color: 'warning',
      title: 'Goal paused',
    });
    expect(
      describeGoalCard(snap({ objective: 'o', status: 'blocked' })),
    ).toMatchObject({
      icon: ICON.CROSS,
      color: 'error',
      title: 'Goal blocked',
    });
    expect(
      describeGoalCard(snap({ objective: 'o', status: 'usage_limited' })),
    ).toMatchObject({
      icon: '!',
      color: 'warning',
      title: 'Goal usage limited',
    });
    expect(
      describeGoalCard(snap({ objective: 'o', status: 'complete' })),
    ).toMatchObject({
      icon: ICON.CHECK,
      color: 'success',
      title: 'Goal complete',
    });
  });

  it('builds the subtitle from turns and active time', () => {
    expect(
      describeGoalCard(
        snap({
          objective: 'o',
          status: 'complete',
          turnCount: 2,
          activeTimeMs: 61000,
        }),
      ),
    ).toMatchObject({ subtitle: '2 turns · 1m 1s' });
  });

  it('shows the reason only off-active or verifying', () => {
    expect(
      describeGoalCard(
        snap({ objective: 'o', status: 'complete', lastReason: 'done' }),
      ),
    ).toMatchObject({ reason: 'done' });
    expect(
      describeGoalCard(snap({ objective: 'o', status: 'active' }, 'running')),
    ).toMatchObject({ reason: undefined });
  });

  it('clears only on cause=clear and hides otherwise', () => {
    expect(describeGoalCard(snap(null), 'clear')).toEqual({ state: 'cleared' });
    expect(describeGoalCard(snap(null))).toEqual({ state: 'hidden' });
  });
});

describe('describeLegacyGoalCard (ink kind form)', () => {
  it('renders the checking form with turn label and judge reason', () => {
    expect(
      describeLegacyGoalCard({
        kind: 'checking',
        condition: 'tests green',
        iterations: 3,
        lastReason: ' not met yet ',
      }),
    ).toEqual({
      state: 'checking',
      title: 'Goal check · turn 3 · not yet met',
      condition: 'tests green',
      judgeReason: 'not met yet',
    });
  });

  it('renders every card kind with icon, color, and title', () => {
    const cases: Array<[string, string, string, string]> = [
      ['set', ICON.BULLSEYE, 'accent', 'Goal set'],
      ['achieved', ICON.CHECK, 'success', 'Goal achieved'],
      ['cleared', ICON.CIRCLE_EMPTY, 'secondary', 'Goal cleared'],
      ['failed', ICON.CROSS, 'error', 'Goal could not be achieved'],
      ['aborted', '!', 'warning', 'Goal aborted'],
      ['paused', '!', 'warning', 'Goal paused'],
    ];
    for (const [kind, icon, color, title] of cases) {
      expect(describeLegacyGoalCard({ kind, condition: 'c' })).toMatchObject({
        state: 'card',
        icon,
        color,
        title,
      });
    }
  });

  it('builds the subtitle and surfaces lastCheck on terminal kinds', () => {
    expect(
      describeLegacyGoalCard({
        kind: 'achieved',
        condition: 'c',
        iterations: 1,
        durationMs: 5000,
        lastReason: 'done',
      }),
    ).toEqual({
      state: 'card',
      icon: ICON.CHECK,
      color: 'success',
      title: 'Goal achieved',
      subtitle: '1 turn · 5s',
      condition: 'c',
      lastCheck: 'done',
    });
    // Non-terminal kinds never show lastCheck.
    expect(
      describeLegacyGoalCard({
        kind: 'set',
        condition: 'c',
        lastReason: 'nope',
      }),
    ).toMatchObject({ lastCheck: undefined });
  });
});
