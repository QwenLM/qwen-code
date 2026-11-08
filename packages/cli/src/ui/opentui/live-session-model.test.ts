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

import { describe, it, expect, vi } from 'vitest';
import {
  describeGoalCard,
  describeLegacyGoalCard,
  foldLiveEvent,
  snapshotCanonicalHistory,
  allocateCanonicalHistoryId,
  type LiveAssistantItem,
  type LiveHistoryItem,
  type LiveToolItem,
} from './live-session-model.js';
import type { OpenTuiStreamEvent, GoalSnapshotLike } from './event-adapter.js';
import { ICON } from '../constants.js';
import { AgentStatus } from '@qwen-code/qwen-code-core/agents/runtime/agent-types.js';
import { ToolCallStatus } from '../types.js';
import { projectHistoryToStreamEvents } from './item-projection.js';
import type { HistoryItem as CanonicalHistoryItem } from '../types.js';

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

describe('identified user history', () => {
  it('updates an invocation in place even after its command output', () => {
    let items = foldLiveEvent([], {
      type: 'user',
      text: '/x',
      historyId: 7,
      sentToModel: false,
    });
    const id = items[0].id;
    items = foldLiveEvent(items, { type: 'info', text: 'Preparing' });
    items = foldLiveEvent(items, {
      type: 'user',
      text: '/x',
      historyId: 7,
      promptId: 'p1',
      sentToModel: true,
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      kind: 'user',
      id,
      historyId: 7,
      text: '/x',
      promptId: 'p1',
      sentToModel: true,
      canonicalHistoryItem: {
        id: 7,
        type: 'user',
        text: '/x',
        promptId: 'p1',
        sentToModel: true,
      },
      canonicalPending: false,
    });
    expect(items[1]).toMatchObject({ kind: 'info', text: 'Preparing' });
  });

  it('retains equal text from distinct turns but deduplicates a repeated echo', () => {
    let items = foldLiveEvent([], {
      type: 'user',
      text: 'again',
      promptId: 'p1',
    });
    items = foldLiveEvent(items, {
      type: 'user',
      text: 'again',
      promptId: 'p2',
    });
    expect(items).toHaveLength(2);
    expect(
      foldLiveEvent(items, { type: 'user', text: 'again', promptId: 'p2' }),
    ).toBe(items);
  });
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

describe('foldLiveEvent confirm-resolved (outcome parity, R1-18)', () => {
  it('records a rejected resolution and clears the pending marker', () => {
    const items = foldLiveEvent([waitingTool()], {
      type: 'confirm-resolved',
      id: 'tool1',
      outcome: 'rejected',
    });
    expect(items[0]).toMatchObject({ confirm: 'rejected', done: false });
  });

  it('records an approved resolution and clears the pending marker', () => {
    const items = foldLiveEvent([waitingTool()], {
      type: 'confirm-resolved',
      id: 'tool1',
      outcome: 'approved',
    });
    expect(items[0]).toMatchObject({ confirm: 'approved', done: false });
  });

  it('leaves an already-resolved card untouched', () => {
    const items = foldLiveEvent([{ ...waitingTool(), confirm: 'approved' }], {
      type: 'confirm-resolved',
      id: 'tool1',
      outcome: 'rejected',
    });
    expect(items[0]).toMatchObject({ confirm: 'approved' });
  });
});

describe('foldLiveEvent tool-queued (approved but not started)', () => {
  it('records the queued status and clears it again', () => {
    const queued = foldLiveEvent([{ ...waitingTool(), confirm: 'approved' }], {
      type: 'tool-queued',
      id: 'tool1',
      queued: true,
    });
    expect(queued[0]).toMatchObject({ confirm: 'approved', queued: true });
    const running = foldLiveEvent(queued, {
      type: 'tool-queued',
      id: 'tool1',
      queued: false,
    });
    expect(running[0]).toMatchObject({ queued: false });
  });

  it('ignores a status for a call with no card', () => {
    const items = foldLiveEvent([assistant('hi')], {
      type: 'tool-queued',
      id: 'tool1',
      queued: true,
    });
    expect(items).toHaveLength(1);
  });
});

describe('foldLiveEvent task card (subagent roster parity)', () => {
  const started = foldLiveEvent([assistant('hi')], {
    type: 'task-start',
    id: 's1',
    name: 'researcher',
    description: 'bench frames',
  });

  it('opens a card and appends progress lines', () => {
    const items = foldLiveEvent(started, {
      type: 'task-progress',
      id: 's1',
      line: '↳ grep',
    });
    expect(items[1]).toMatchObject({
      kind: 'task',
      name: 'researcher',
      progress: ['↳ grep'],
    });
  });

  it('drops the card once the subagent settles', () => {
    const items = foldLiveEvent(started, { type: 'task-end', id: 's1' });
    expect(items).toEqual([{ ...assistant('hi'), streaming: false }]);
  });

  it('ignores task-end for a card that is not there', () => {
    const items = foldLiveEvent([assistant('hi')], {
      type: 'task-end',
      id: 'ghost',
    });
    expect(items).toHaveLength(1);
  });
});

describe('foldLiveEvent user (promptId/sentToModel parity)', () => {
  it('preserves separate recall content when displayed paste placeholders match', () => {
    const event = {
      type: 'user',
      text: '[Pasted Content 1200 chars]',
      recallText: 'first body'.padEnd(1200, 'x'),
    } as const;
    let items = foldLiveEvent([], event);
    items = foldLiveEvent(items, event);
    expect(items).toHaveLength(1);
    items = foldLiveEvent(items, {
      ...event,
      recallText: 'second body'.padEnd(1200, 'y'),
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      text: event.text,
      recallText: event.recallText,
    });
    expect(items[1]).toMatchObject({
      text: event.text,
      recallText: 'second body'.padEnd(1200, 'y'),
    });
  });

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

  it('collapses the same user text folded twice in a row', () => {
    // ink's addItem drops a user item identical to its predecessor; steering
    // the same text twice mid-turn reaches this fold as two events.
    const steer = {
      type: 'user',
      text: 'continue',
      sentToModel: false,
    } as const;
    let items = foldLiveEvent([], steer);
    items = foldLiveEvent(items, steer);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'user', text: 'continue' });
  });

  it('keeps two different user texts folded in a row', () => {
    let items = foldLiveEvent([], {
      type: 'user',
      text: 'first',
      sentToModel: false,
    });
    items = foldLiveEvent(items, {
      type: 'user',
      text: 'second',
      sentToModel: false,
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'user', text: 'first' });
    expect(items[1]).toMatchObject({ kind: 'user', text: 'second' });
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

  it('carries the vision-bridge egress disclosure onto the tool item (R2-3)', () => {
    let items = foldLiveEvent([], {
      type: 'tool-start',
      id: 'tool1',
      tool: 'read_file',
      title: 'read_file',
    });
    items = foldLiveEvent(items, {
      type: 'tool-result',
      id: 'tool1',
      display: '',
      visionBridgeNotice:
        'Content was sent to the vision model — your data left this machine.',
    });
    const tool = items[0];
    if (tool.kind !== 'tool') throw new Error('expected tool item');
    expect(tool.visionBridgeNotice).toBe(
      'Content was sent to the vision model — your data left this machine.',
    );
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

  it('drops the grid when a later chunk carries plain text', () => {
    // A shell run that streams ANSI and then trips binary detection replaces
    // the grid with a plain string, and ToolCardBody prefers the grid
    // unconditionally — a stale one would hide the notice for good, including
    // in the settled card.
    const grid = [
      [
        {
          text: 'partial',
          bold: false,
          italic: false,
          underline: false,
          dim: false,
          inverse: false,
          fg: '',
          bg: '',
        },
      ],
    ];
    let items = foldLiveEvent([], {
      type: 'tool-start',
      id: 'tool1',
      tool: 'run_shell_command',
      title: 'run_shell_command',
    });
    items = foldLiveEvent(items, {
      type: 'tool-result',
      id: 'tool1',
      display: '',
      ansi: { grid },
    });
    items = foldLiveEvent(items, {
      type: 'tool-output',
      id: 'tool1',
      output: '[Binary output detected. Halting stream...]',
    });
    const tool = items[0];
    if (tool.kind !== 'tool') throw new Error('expected tool item');
    expect(tool.ansi).toBeUndefined();
    expect(tool.output).toBe('[Binary output detected. Halting stream...]');
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
  it('preserves meaningful classification without a canonical history id', () => {
    expect(
      foldLiveEvent([], {
        type: 'info',
        text: 'Status',
        historyIsSynthetic: false,
      }),
    ).toEqual([
      {
        kind: 'info',
        id: expect.any(String),
        text: 'Status',
        historyIsSynthetic: false,
        canonicalHistoryItem: {
          id: expect.any(Number),
          type: 'info',
          text: 'Status',
        },
        canonicalPending: false,
      },
    ]);
    expect(foldLiveEvent([], { type: 'info', text: 'Preparing' })).toEqual([
      {
        kind: 'info',
        id: expect.any(String),
        text: 'Preparing',
        canonicalHistoryItem: {
          id: expect.any(Number),
          type: 'info',
          text: 'Preparing',
        },
        canonicalPending: false,
      },
    ]);
  });

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
      {
        kind: 'warning',
        id: expect.any(String),
        text: '✕ blocked',
        canonicalHistoryItem: {
          id: expect.any(Number),
          type: 'warning',
          text: '✕ blocked',
        },
        canonicalPending: false,
      },
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

  it('pushes the U-33 user shell row after settling a streaming assistant', () => {
    const items = foldLiveEvent([assistant('thinking')], {
      type: 'user-shell',
      text: 'ls',
    });
    expect(items).toMatchObject([
      { kind: 'assistant', streaming: false },
      { kind: 'user-shell', text: 'ls' },
    ]);
  });

  it('pushes the U-34 command cards structurally, settling the stream first', () => {
    const agent = {
      label: 'left',
      status: 'completed',
      durationMs: 1200,
      totalTokens: 10,
      inputTokens: 4,
      outputTokens: 6,
      toolCalls: 2,
      successfulToolCalls: 2,
      failedToolCalls: 0,
      rounds: 1,
    } as never;
    const recap = foldLiveEvent([assistant('thinking')], {
      type: 'away-recap',
      text: 'did X',
    });
    expect(recap).toMatchObject([
      { kind: 'assistant', streaming: false },
      { kind: 'away-recap', text: 'did X' },
    ]);

    const advisor = foldLiveEvent([assistant('thinking')], {
      type: 'advisor',
      text: 'Looks good',
      model: 'qwen3-max',
    });
    expect(advisor).toMatchObject([
      { kind: 'assistant', streaming: false },
      { kind: 'advisor', text: 'Looks good', model: 'qwen3-max' },
    ]);

    const arenaAgent = foldLiveEvent([assistant('thinking')], {
      type: 'arena-agent',
      agent,
    });
    expect(arenaAgent).toMatchObject([
      { kind: 'assistant', streaming: false },
      { kind: 'arena-agent', agent },
    ]);

    const arenaSession = foldLiveEvent([assistant('thinking')], {
      type: 'arena-session',
      sessionStatus: 'completed',
      task: 'do it',
      totalDurationMs: 2000,
      agents: [agent],
    });
    expect(arenaSession).toMatchObject([
      { kind: 'assistant', streaming: false },
      {
        kind: 'arena-session',
        sessionStatus: 'completed',
        task: 'do it',
        totalDurationMs: 2000,
        agents: [agent],
      },
    ]);
  });
});

describe('foldLiveEvent tool-output', () => {
  const started = () =>
    foldLiveEvent([], {
      type: 'tool-start',
      id: 'tool1',
      tool: 'run_shell_command',
      title: 'run_shell_command',
    });

  it('replaces the running card output with each snapshot', () => {
    let items = foldLiveEvent(started(), {
      type: 'tool-output',
      id: 'tool1',
      output: 'line1\n',
    });
    items = foldLiveEvent(items, {
      type: 'tool-output',
      id: 'tool1',
      output: 'line1\nline2\n',
    });
    expect(items[0]).toMatchObject({
      kind: 'tool',
      done: false,
      output: 'line1\nline2\n',
    });
  });

  it('holds one copy when the result repeats the streamed output', () => {
    let items = foldLiveEvent(started(), {
      type: 'tool-output',
      id: 'tool1',
      output: 'ACCEPT_TOOL_RAN\n',
    });
    items = foldLiveEvent(items, {
      type: 'tool-result',
      id: 'tool1',
      display: 'ACCEPT_TOOL_RAN\n',
    });
    expect(items[0]).toMatchObject({
      kind: 'tool',
      output: 'ACCEPT_TOOL_RAN\n',
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

  it.each([
    [3, 20, 723_000, 1_800_000, '3/20 turns · 12m 3s/30m'],
    [1, 20, 0, undefined, '1/20 turns'],
    [1, 1, 0, undefined, '1/1 turn'],
    [3, undefined, 723_000, undefined, '3 turns · 12m 3s'],
  ])(
    'shows turn and active-time budgets (%s/%s)',
    (turnCount, turnBudget, activeTimeMs, activeTimeBudgetMs, expected) => {
      expect(
        describeGoalCard(
          snap({
            objective: 'o',
            status: 'paused',
            turnCount,
            turnBudget,
            activeTimeMs,
            activeTimeBudgetMs,
          }),
        ),
      ).toMatchObject({ subtitle: expected });
    },
  );

  it('hides unused turn and active-time budgets', () => {
    expect(
      describeGoalCard(
        snap({
          objective: 'o',
          status: 'active',
          turnCount: 0,
          turnBudget: 20,
          activeTimeMs: 0,
          activeTimeBudgetMs: 1_800_000,
        }),
      ),
    ).toMatchObject({ subtitle: null });
  });

  it('carries spend in the subtitle, matching the ink card', () => {
    expect(
      describeGoalCard(
        snap({
          objective: 'o',
          status: 'active',
          turnCount: 2,
          activeTimeMs: 61000,
          tokensUsed: 1234,
          tokenBudget: 30_000_000,
        }),
      ),
    ).toMatchObject({ subtitle: '2 turns · 1m 1s · 1.2k/30.0m tokens' });
  });

  it('carries spend alone when the Goal has no budget', () => {
    expect(
      describeGoalCard(
        snap({
          objective: 'o',
          status: 'active',
          turnCount: 1,
          tokensUsed: 900,
        }),
      ),
    ).toMatchObject({ subtitle: '1 turn · 900 tokens' });
  });

  it('says nothing about spend before a turn has billed', () => {
    expect(
      describeGoalCard(
        snap({
          objective: 'o',
          status: 'active',
          turnCount: 2,
          tokenBudget: 30_000_000,
        }),
      ),
    ).toMatchObject({ subtitle: '2 turns' });
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

describe('foldLiveEvent assistant timestamps (#76)', () => {
  const stampOf = (items: readonly LiveHistoryItem[]): number | undefined =>
    (items[0] as LiveAssistantItem).timestamp;

  it('opens the block at the replayed record time', () => {
    const items = foldLiveEvent([], {
      type: 'text',
      delta: 'hi',
      timestamp: 1_700_000_000_000,
    });
    expect(items[0]).toMatchObject({
      kind: 'assistant',
      text: 'hi',
      timestamp: 1_700_000_000_000,
    });
  });

  it('keeps the opening stamp as later deltas append to the same block', () => {
    let items = foldLiveEvent([], {
      type: 'text',
      delta: 'a',
      timestamp: 1_700_000_000_000,
    });
    items = foldLiveEvent(items, {
      type: 'text',
      delta: 'b',
      timestamp: 1_800_000_000_000,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ text: 'ab' });
    expect(stampOf(items)).toBe(1_700_000_000_000);
  });

  it('falls back to the fold time for a live delta', () => {
    const before = Date.now();
    const items = foldLiveEvent([], { type: 'text', delta: 'live' });
    expect(stampOf(items)).toBeGreaterThanOrEqual(before);
    expect(stampOf(items)).toBeLessThanOrEqual(Date.now());
  });
});

describe('replayed canonical source ownership', () => {
  it('keeps text and image fanout owned by the original complete source', () => {
    const source: CanonicalHistoryItem = {
      id: 91,
      type: 'gemini',
      text: 'original',
      timestamp: 123,
      images: [{ mimeType: 'image/png', data: 'aW1hZ2U=' }],
    };
    const items = projectHistoryToStreamEvents([source], {}).reduce<
      readonly LiveHistoryItem[]
    >(foldLiveEvent, []);
    expect(items.filter((item) => item.kind === 'assistant')).toHaveLength(1);
    expect(items.filter((item) => item.kind === 'image')).toHaveLength(1);
    expect(items.every((item) => item.canonicalHistoryItem === source)).toBe(
      true,
    );
  });
  it('replaces only the original source fanout without replacing its successor', () => {
    const source: CanonicalHistoryItem = { id: 91, type: 'info', text: 'old' };
    const next: CanonicalHistoryItem = {
      id: 92,
      type: 'info',
      text: 'successor',
    };
    const items = projectHistoryToStreamEvents([source, next], {}).reduce<
      readonly LiveHistoryItem[]
    >(foldLiveEvent, []);
    const updated: CanonicalHistoryItem = { ...source, text: 'new' };
    const replaced = foldLiveEvent(items, {
      type: 'canonical-history-replace',
      item: updated,
      events: projectHistoryToStreamEvents([updated], {}),
    });
    expect(replaced.map((item) => item.canonicalHistoryItem)).toEqual([
      updated,
      next,
    ]);
    expect(replaced[1]).toBe(items[1]);
  });
});

describe('canonical source retention for checkpoints', () => {
  const replay = (history: CanonicalHistoryItem[]) =>
    projectHistoryToStreamEvents(history, {}).reduce<
      readonly LiveHistoryItem[]
    >((items, event) => foldLiveEvent(items, event), []);

  it('retains one exact source across assistant text and image fanout', () => {
    const source: CanonicalHistoryItem = {
      id: 101,
      type: 'gemini',
      text: 'answer',
      timestamp: 123,
      images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }],
    };
    const items = replay([source]);
    expect(items.filter((item) => !item.canonicalOnly)).toHaveLength(2);
    expect(snapshotCanonicalHistory(items)).toEqual([source]);
    expect(snapshotCanonicalHistory(items)[0]).toBe(source);
  });

  it('does not merge adjacent streaming text from distinct canonical sources', () => {
    const first: CanonicalHistoryItem = {
      id: 102,
      type: 'gemini_content',
      text: 'first',
    };
    const second: CanonicalHistoryItem = {
      id: 103,
      type: 'gemini_content',
      text: 'second',
    };
    const items = replay([first, second]);
    expect(
      items
        .filter((item) => item.kind === 'assistant')
        .map((item) => item.text),
    ).toEqual(['first', 'second']);
    expect(
      items
        .filter((item) => item.kind === 'assistant')
        .every((item) => !item.streaming),
    ).toBe(true);
    expect(snapshotCanonicalHistory(items)).toEqual([first, second]);
  });

  it('retains zero-render source without a visible row', () => {
    const source: CanonicalHistoryItem = {
      id: 104,
      type: 'gemini_content',
      text: '',
    };
    const items = replay([source]);
    expect(items.filter((item) => !item.canonicalOnly)).toEqual([]);
    expect(snapshotCanonicalHistory(items)).toEqual([source]);
    expect(items[0]).toMatchObject({
      kind: 'info',
      canonicalOnly: true,
      historyIsSynthetic: false,
    });
    // The existing live-turn rollback scans info.historyIsSynthetic.
    const synthetic = foldLiveEvent([], {
      type: 'canonical-history',
      canonicalHistoryItem: { id: 109, type: 'info', text: '' },
    });
    expect(
      synthetic.every(
        (item) => item.kind === 'info' && (item.historyIsSynthetic ?? true),
      ),
    ).toBe(true);
    expect(
      items.every(
        (item) => item.kind === 'info' && (item.historyIsSynthetic ?? true),
      ),
    ).toBe(false);
  });

  it('replaces all old fanout on host update while retaining transcript position', () => {
    const before: CanonicalHistoryItem = {
      id: 105,
      type: 'gemini',
      text: 'old',
      images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }],
    };
    const following: CanonicalHistoryItem = {
      id: 106,
      type: 'info',
      text: 'later',
    };
    const replacement: CanonicalHistoryItem = {
      id: 105,
      type: 'gemini',
      text: 'updated',
    };
    const items = foldLiveEvent(replay([before, following]), {
      type: 'canonical-history-replace',
      item: replacement,
      events: projectHistoryToStreamEvents([replacement], {}).filter(
        (event) => event.type !== 'done',
      ),
    });
    expect(snapshotCanonicalHistory(items)).toEqual([replacement, following]);
    expect(items.some((item) => item.kind === 'image')).toBe(false);
    expect(
      items
        .filter((item) => item.kind === 'assistant')
        .map((item) => item.text),
    ).toEqual(['updated']);
  });

  it('keeps reset and rollback snapshots local to their actual item arrays', () => {
    const original: CanonicalHistoryItem = {
      id: 107,
      type: 'gemini_content',
      text: '',
    };
    const saved = replay([original]);
    const next = replay([{ id: 108, type: 'info', text: 'new session' }]);
    expect(snapshotCanonicalHistory([])).toEqual([]);
    expect(snapshotCanonicalHistory(next).map((item) => item.id)).toEqual([
      108,
    ]);
    expect(snapshotCanonicalHistory(saved)).toEqual([original]);
  });

  it('fails closed on a committed row whose native source has not been wired', () => {
    expect(() => snapshotCanonicalHistory([assistant('unowned')])).toThrow(
      'missing canonical assistant',
    );
  });

  it('captures expanded history without restoring its old suppression flag', () => {
    const source: CanonicalHistoryItem = {
      id: 109,
      type: 'gemini',
      text: 'restored answer',
      display: { suppressOnRestore: true },
    };
    const items = foldLiveEvent(replay([source]), { type: 'history-expanded' });
    expect(items.every((item) => !item.display?.suppressOnRestore)).toBe(true);
    expect(snapshotCanonicalHistory(items)).toEqual([
      { ...source, display: undefined },
    ]);
    expect(source.display?.suppressOnRestore).toBe(true);
  });
});

describe('native canonical checkpoint source', () => {
  const committed = (items: readonly LiveHistoryItem[]) =>
    snapshotCanonicalHistory(items.filter((item) => !item.canonicalPending));

  it('keeps raw text, image bytes, continuation types and the first timestamp', () => {
    let items = foldLiveEvent([], {
      type: 'user',
      text: 'typed',
      promptId: 'actual#0',
      sentToModel: true,
    });
    items = foldLiveEvent(items, {
      type: 'text',
      delta: '\nfirst',
      timestamp: 11,
    });
    items = foldLiveEvent(items, { type: 'text', delta: ' answer' });
    expect(committed(items)).toHaveLength(1);
    items = foldLiveEvent(items, {
      type: 'image',
      mimeType: 'image/png',
      data: 'raw-base64',
    });
    items = foldLiveEvent(items, { type: 'text', delta: 'after image' });
    items = foldLiveEvent(items, { type: 'segment-end' });
    expect(committed(items)).toEqual([
      {
        id: expect.any(Number),
        type: 'user',
        text: 'typed',
        promptId: 'actual#0',
        sentToModel: true,
      },
      {
        id: expect.any(Number),
        type: 'gemini',
        text: 'first answer',
        timestamp: 11,
      },
      {
        id: expect.any(Number),
        type: 'gemini_content',
        text: '',
        images: [{ mimeType: 'image/png', data: 'raw-base64' }],
      },
      { id: expect.any(Number), type: 'gemini_content', text: 'after image' },
    ]);
  });

  it('retains image overflow count once per canonical source', () => {
    let items = foldLiveEvent([], { type: 'user', text: 'images' });
    for (let i = 0; i < 6; i++)
      items = foldLiveEvent(items, {
        type: 'image',
        mimeType: 'image/png',
        data: `raw-${i}`,
      });
    items = foldLiveEvent(items, { type: 'done' });
    const history = committed(items);
    expect(history).toHaveLength(6);
    expect(history.at(-1)).toEqual({
      id: expect.any(Number),
      type: 'gemini_content',
      text: '',
      omittedImageCount: 2,
    });
    expect(
      history
        .slice(1, 5)
        .map((item) => ('images' in item ? item.images?.[0]?.data : undefined)),
    ).toEqual(['raw-0', 'raw-1', 'raw-2', 'raw-3']);
  });

  it('keeps completed thought duration and does not mutate the pending source', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const pending = foldLiveEvent([], {
        type: 'thinking',
        delta: 'raw reasoning',
      });
      expect(committed(pending)).toEqual([]);
      clock.mockReturnValue(1250);
      const complete = foldLiveEvent(pending, { type: 'thinking-end' });
      expect(committed(complete)).toEqual([
        {
          id: expect.any(Number),
          type: 'gemini_thought',
          text: 'raw reasoning',
          durationMs: 250,
        },
      ]);
      expect(pending[0].canonicalPending).toBe(true);
      expect(pending[0].canonicalHistoryItem).toMatchObject({ durationMs: 0 });
    } finally {
      clock.mockRestore();
    }
  });

  it('preserves native structural fields instead of reconstructing display strings', () => {
    const agent = {
      label: 'left',
      status: AgentStatus.COMPLETED,
      durationMs: 10,
      totalTokens: 8,
      inputTokens: 3,
      outputTokens: 5,
      toolCalls: 2,
      successfulToolCalls: 1,
      failedToolCalls: 1,
      rounds: 2,
      error: 'raw error',
      diff: 'raw diff',
      modifiedFiles: ['a'],
      approachSummary: 'raw approach',
    };
    const compression = {
      isPending: false,
      originalTokenCount: 1000,
      newTokenCount: 200,
      compressionStatus: 1,
    };
    const entries: Array<[OpenTuiStreamEvent, object]> = [
      [
        { type: 'info', text: 'raw info' },
        { type: 'info', text: 'raw info' },
      ],
      [
        { type: 'error', text: 'raw error', hint: 'raw hint' },
        { type: 'error', text: 'raw error', hint: 'raw hint' },
      ],
      [
        { type: 'warning', text: 'raw warning' },
        { type: 'warning', text: 'raw warning' },
      ],
      [
        { type: 'compaction', compression },
        { type: 'compression', compression },
      ],
      [
        { type: 'stop-hook-message', message: 'raw hook' },
        { type: 'stop_hook_system_message', message: 'raw hook' },
      ],
      [
        { type: 'away-recap', text: 'raw recap' },
        { type: 'away_recap', text: 'raw recap' },
      ],
      [
        { type: 'user-shell', text: 'raw shell' },
        { type: 'user_shell', text: 'raw shell' },
      ],
      [
        { type: 'advisor', text: 'raw advice', model: 'model-id' },
        { type: 'advisor', text: 'raw advice', model: 'model-id' },
      ],
      [
        { type: 'arena-agent', agent },
        { type: 'arena_agent_complete', agent },
      ],
      [
        {
          type: 'arena-session',
          sessionStatus: 'completed',
          task: 'raw task',
          totalDurationMs: 12,
          agents: [agent],
        },
        {
          type: 'arena_session_complete',
          sessionStatus: 'completed',
          task: 'raw task',
          totalDurationMs: 12,
          agents: [agent],
        },
      ],
    ];
    for (const [event, original] of entries)
      expect(committed(foldLiveEvent([], event))).toEqual([
        { ...original, id: expect.any(Number) },
      ]);
  });

  it('allocates negative IDs below restored native IDs without host collisions', () => {
    expect(
      allocateCanonicalHistoryId([
        { kind: 'info', id: 'old', text: '', historyId: -10000 },
      ]),
    ).toBeLessThan(-10000);
    const items = foldLiveEvent([], { type: 'info', text: 'native' });
    expect(items[0].canonicalHistoryItem!.id).toBeLessThan(-10000);
  });
});

describe('canonical response and terminal boundaries', () => {
  const committed = (items: readonly LiveHistoryItem[]) =>
    snapshotCanonicalHistory(items.filter((item) => !item.canonicalPending));

  it('starts a new gemini after actual finished without requiring another user', () => {
    let items = foldLiveEvent([], { type: 'user', text: 'one user' });
    items = foldLiveEvent(items, {
      type: 'text',
      delta: 'first',
      timestamp: 10,
    });
    items = foldLiveEvent(items, { type: 'segment-end' });
    items = foldLiveEvent(items, {
      type: 'text',
      delta: 'second',
      timestamp: 20,
    });
    items = foldLiveEvent(items, { type: 'segment-end' });
    expect(committed(items).filter((item) => item.type === 'gemini')).toEqual([
      { id: expect.any(Number), type: 'gemini', text: 'first', timestamp: 10 },
      { id: expect.any(Number), type: 'gemini', text: 'second', timestamp: 20 },
    ]);
  });

  it('resets the image cap after actual finished and preserves the next raw image', () => {
    let items = foldLiveEvent([], { type: 'user', text: 'one user' });
    for (let i = 0; i < 4; i++)
      items = foldLiveEvent(items, {
        type: 'image',
        mimeType: 'image/png',
        data: `first-${i}`,
      });
    items = foldLiveEvent(items, { type: 'segment-end' });
    items = foldLiveEvent(items, {
      type: 'image',
      mimeType: 'image/png',
      data: 'next-response-raw',
    });
    items = foldLiveEvent(items, { type: 'segment-end' });
    expect(committed(items).at(-1)).toEqual({
      id: expect.any(Number),
      type: 'gemini',
      text: '',
      timestamp: expect.any(Number),
      images: [{ mimeType: 'image/png', data: 'next-response-raw' }],
    });
    expect(
      committed(items).some(
        (item) => 'omittedImageCount' in item && item.omittedImageCount,
      ),
    ).toBe(false);
  });

  it('settles native thought duration after a canonical-source branch, preserving replay duration', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      let items = foldLiveEvent([], {
        type: 'thinking',
        delta: 'native pending',
      });
      clock.mockReturnValue(1250);
      items = foldLiveEvent(items, {
        type: 'info',
        text: 'source branch',
        canonicalHistoryItem: { id: 1701, type: 'info', text: 'source branch' },
      });
      items = foldLiveEvent(items, {
        type: 'confirm',
        id: 'approval',
        tool: 'edit',
        title: 'approve',
      });
      const thought = items.find((item) => item.kind === 'thinking');
      expect(thought?.canonicalPending).toBe(false);
      expect(thought?.canonicalHistoryItem).toMatchObject({
        type: 'gemini_thought',
        text: 'native pending',
        durationMs: 250,
      });
      const replayed: CanonicalHistoryItem = {
        id: 1702,
        type: 'gemini_thought',
        text: 'saved',
        durationMs: 789,
      };
      let replay = projectHistoryToStreamEvents([replayed], {}).reduce<
        readonly LiveHistoryItem[]
      >((items, event) => foldLiveEvent(items, event), []);
      replay = foldLiveEvent(replay, {
        type: 'confirm',
        id: 'later',
        tool: 'edit',
        title: 'approve',
      });
      expect(
        replay.find((item) => item.kind === 'thinking')?.canonicalHistoryItem,
      ).toBe(replayed);
      expect(replayed.durationMs).toBe(789);
    } finally {
      clock.mockRestore();
    }
  });

  const rawGroup = (): Extract<
    CanonicalHistoryItem,
    { type: 'tool_group' }
  > => ({
    id: 1801,
    type: 'tool_group',
    batchId: 'original-batch',
    memoryReadCount: 2,
    tools: ['first', 'second'].map((callId) => ({
      callId,
      name: 'read_file',
      description: `raw ${callId}`,
      args: { file_path: `${callId}.txt`, nested: { preserve: true } },
      status: ToolCallStatus.Pending,
      resultDisplay: 'original display',
      confirmationDetails: undefined,
      images: [{ mimeType: 'image/png', data: 'original-tool-image' }],
    })),
  });
  const pendingCards = (
    group: Extract<CanonicalHistoryItem, { type: 'tool_group' }>,
  ) => {
    let items = foldLiveEvent([], {
      type: 'tool-start',
      id: 'first',
      tool: 'read_file',
      title: 'first',
    });
    items = foldLiveEvent(items, {
      type: 'tool-start',
      id: 'second',
      tool: 'read_file',
      title: 'second',
    });
    return foldLiveEvent(items, {
      type: 'tool-history',
      item: group,
      pending: true,
    });
  };

  it('settles a pre-published group when rejection supplies only tool-end events', () => {
    const group = rawGroup();
    let items = pendingCards(group);
    items = foldLiveEvent(items, {
      type: 'tool-end',
      id: 'first',
      success: false,
      summary: 'cancelled',
    });
    expect(items.every((item) => item.canonicalPending)).toBe(true);
    expect(items[0].canonicalHistoryItem).toMatchObject({
      tools: [
        { status: ToolCallStatus.Canceled },
        { status: ToolCallStatus.Pending },
      ],
    });
    items = foldLiveEvent(items, {
      type: 'tool-end',
      id: 'second',
      success: false,
      summary: 'error',
    });
    expect(items.every((item) => item.canonicalPending === false)).toBe(true);
    const expected = {
      ...group,
      tools: [
        { ...group.tools[0], status: ToolCallStatus.Canceled },
        { ...group.tools[1], status: ToolCallStatus.Error },
      ],
    };
    expect(committed(items)).toEqual([expected]);
    expect(items[0].canonicalHistoryItem).toBe(items[1].canonicalHistoryItem);
    expect(
      group.tools.every((tool) => tool.status === ToolCallStatus.Pending),
    ).toBe(true);
    expect(expected.tools[0].args).toBe(group.tools[0].args);
    expect(expected.tools[0].images).toBe(group.tools[0].images);
  });

  it('does not replace an already-terminal real scheduler source with fallback metadata', () => {
    const group = rawGroup();
    const terminal = {
      ...group,
      tools: group.tools.map((tool) => ({
        ...tool,
        status: ToolCallStatus.Success,
      })),
    };
    let items = pendingCards(group);
    items = foldLiveEvent(items, {
      type: 'tool-history',
      item: terminal,
      pending: false,
    });
    items = foldLiveEvent(items, {
      type: 'tool-end',
      id: 'first',
      success: false,
      summary: 'cancelled',
    });
    expect(committed(items)).toEqual([terminal]);
    expect(items.every((item) => item.canonicalHistoryItem === terminal)).toBe(
      true,
    );
  });
});
