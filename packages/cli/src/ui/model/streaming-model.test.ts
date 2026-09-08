/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  initialStreamingModelState,
  reduceStreamEvent,
  reduceStreamEvents,
  selectIsDone,
  selectIsStreaming,
  selectItemById,
  selectItems,
} from './streaming-model.js';
import type {
  HistoryItem,
  StreamingModelState,
  StreamEvent,
} from './streaming-model.js';

function reduceAll(events: StreamEvent[]): StreamingModelState {
  return reduceStreamEvents(initialStreamingModelState, events);
}

describe('streamingModel', () => {
  describe('text merging', () => {
    it('merges consecutive text deltas into one streaming assistant item', () => {
      const state = reduceAll([
        { type: 'text', delta: 'Hello ' },
        { type: 'text', delta: 'world' },
      ]);
      const items = selectItems(state);
      expect(items).toHaveLength(1);
      expect(items[0]).toEqual({
        kind: 'assistant',
        id: 'assistant-0',
        text: 'Hello world',
        streaming: true,
      });
      expect(selectIsStreaming(state)).toBe(true);
    });

    it('starts a new assistant item after a tool interrupts the text stream', () => {
      const state = reduceAll([
        { type: 'text', delta: 'before' },
        { type: 'tool-start', id: 't1', tool: 'Read', title: 'Read foo.ts' },
        { type: 'tool-end', id: 't1', success: true, summary: '1 line' },
        { type: 'text', delta: 'after' },
      ]);
      const items = selectItems(state);
      expect(items).toHaveLength(3);
      expect(items[0]).toMatchObject({
        kind: 'assistant',
        text: 'before',
        streaming: false,
      });
      expect(items[2]).toMatchObject({
        kind: 'assistant',
        id: 'assistant-1',
        text: 'after',
        streaming: true,
      });
    });
  });

  describe('thinking start / end', () => {
    it('merges thinking deltas until thinking-end, then opens a new block', () => {
      const state = reduceAll([
        { type: 'thinking', delta: 'consider ' },
        { type: 'thinking', delta: 'options' },
        { type: 'thinking-end' },
        { type: 'thinking', delta: 'second burst' },
      ]);
      const items = selectItems(state);
      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({
        kind: 'thinking',
        id: 'thinking-0',
        text: 'consider options',
        done: true,
      });
      expect(items[1]).toEqual({
        kind: 'thinking',
        id: 'thinking-1',
        text: 'second burst',
        done: false,
      });
    });

    it('treats thinking-end without an active thinking block as a no-op', () => {
      const state = reduceAll([{ type: 'thinking-end' }]);
      expect(selectItems(state)).toHaveLength(0);
    });
  });

  describe('tool start / output / end', () => {
    it('accumulates tool output by id and closes with success and summary', () => {
      const state = reduceAll([
        { type: 'tool-start', id: 't1', tool: 'Bash', title: 'ls -la' },
        { type: 'tool-output', id: 't1', delta: 'drwxr-xr-x\n' },
        { type: 'tool-output', id: 't1', delta: 'total 0\n' },
        { type: 'tool-end', id: 't1', success: true, summary: '2 lines' },
      ]);
      const tool = selectItemById(state, 't1');
      expect(tool).toEqual({
        kind: 'tool',
        id: 't1',
        tool: 'Bash',
        title: 'ls -la',
        output: 'drwxr-xr-x\ntotal 0\n',
        done: true,
        success: true,
        summary: '2 lines',
      });
    });

    it('records failed tools', () => {
      const state = reduceAll([
        { type: 'tool-start', id: 't1', tool: 'Bash', title: 'false' },
        { type: 'tool-end', id: 't1', success: false, summary: 'exit 1' },
      ]);
      expect(selectItemById(state, 't1')).toMatchObject({
        done: true,
        success: false,
        summary: 'exit 1',
      });
    });

    it('ignores tool-output and tool-end for unknown ids', () => {
      const before = reduceAll([
        { type: 'tool-start', id: 't1', tool: 'Bash', title: 'ls' },
      ]);
      const after = reduceAll([
        { type: 'tool-start', id: 't1', tool: 'Bash', title: 'ls' },
        { type: 'tool-output', id: 'ghost', delta: 'nope' },
        { type: 'tool-end', id: 'ghost', success: true, summary: 'nope' },
      ]);
      expect(after.items).toEqual(before.items);
    });

    it('closes a trailing streaming assistant item on tool-start', () => {
      const state = reduceAll([
        { type: 'text', delta: 'intro' },
        { type: 'tool-start', id: 't1', tool: 'Read', title: 'Read bar.ts' },
      ]);
      expect(state.items[0]).toMatchObject({
        kind: 'assistant',
        streaming: false,
      });
    });

    it('resets the existing item when a tool-start is replayed', () => {
      // A retry/reconnect can re-emit a start whose id already exists; a
      // duplicate item would strand later events (first id hit) and leave
      // the ghost at done:false forever.
      const state = reduceAll([
        { type: 'tool-start', id: 't1', tool: 'Bash', title: 'ls' },
        { type: 'tool-output', id: 't1', delta: 'stale' },
        { type: 'tool-start', id: 't1', tool: 'Bash', title: 'ls -la' },
        { type: 'tool-output', id: 't1', delta: 'fresh' },
        { type: 'tool-end', id: 't1', success: true, summary: 'ok' },
      ]);
      expect(
        selectItems(state).filter((item) => item.kind === 'tool'),
      ).toHaveLength(1);
      expect(selectItemById(state, 't1')).toMatchObject({
        title: 'ls -la',
        output: 'fresh',
        done: true,
      });
    });
  });

  describe('user events', () => {
    it('produces a user item carrying text, promptId and sentToModel', () => {
      const state = reduceAll([
        {
          type: 'user',
          text: 'run the tests',
          promptId: 'sess########7',
          sentToModel: true,
        },
      ]);
      const items = selectItems(state);
      expect(items).toHaveLength(1);
      expect(items[0]).toEqual({
        kind: 'user',
        id: 'user-0',
        text: 'run the tests',
        promptId: 'sess########7',
        sentToModel: true,
      });
    });

    it('closes a trailing streaming assistant item', () => {
      const state = reduceAll([
        { type: 'text', delta: 'intro' },
        { type: 'user', text: 'next turn' },
      ]);
      expect(state.items[0]).toMatchObject({
        kind: 'assistant',
        streaming: false,
      });
      expect(state.items[1]).toMatchObject({ kind: 'user', text: 'next turn' });
    });
  });

  describe('task progress / end', () => {
    it('keeps only the tail of task progress lines', () => {
      const events: StreamEvent[] = [
        {
          type: 'task-start',
          id: 's1',
          name: 'researcher',
          description: 'bench ink frames',
        },
      ];
      for (const line of ['one', 'two', 'three', 'four', 'five']) {
        events.push({ type: 'task-progress', id: 's1', line });
      }
      const task = selectItemById(reduceAll(events), 's1');
      expect(task).toMatchObject({
        kind: 'task',
        done: false,
        progress: ['three', 'four', 'five'],
      });
    });

    it('ignores task-progress and task-end for unknown ids', () => {
      const start = {
        type: 'task-start',
        id: 's1',
        name: 'n',
        description: 'd',
      } as const;
      const before = reduceAll([start]);
      const after = reduceAll([
        start,
        { type: 'task-progress', id: 'ghost', line: 'nope' },
        { type: 'task-end', id: 'ghost', tools: 1, seconds: 1, tokens: '1' },
      ]);
      expect(after.items).toEqual(before.items);
    });

    it('resets the existing item when a task-start is replayed', () => {
      const state = reduceAll([
        { type: 'task-start', id: 's1', name: 'n', description: 'd' },
        { type: 'task-progress', id: 's1', line: 'stale' },
        { type: 'task-start', id: 's1', name: 'n2', description: 'd2' },
        { type: 'task-progress', id: 's1', line: 'fresh' },
        { type: 'task-end', id: 's1', tools: 1, seconds: 1, tokens: '1' },
      ]);
      expect(
        selectItems(state).filter((item) => item.kind === 'task'),
      ).toHaveLength(1);
      expect(selectItemById(state, 's1')).toMatchObject({
        name: 'n2',
        progress: ['fresh'],
        done: true,
      });
    });

    it('closes the task with formatted stats', () => {
      const state = reduceAll([
        {
          type: 'task-start',
          id: 's1',
          name: 'researcher',
          description: 'bench ink frames',
        },
        { type: 'task-progress', id: 's1', line: '↳ done' },
        {
          type: 'task-end',
          id: 's1',
          tools: 3,
          seconds: 12.4,
          tokens: '2.1k',
        },
      ]);
      expect(selectItemById(state, 's1')).toEqual({
        kind: 'task',
        id: 's1',
        name: 'researcher',
        description: 'bench ink frames',
        progress: ['↳ done'],
        done: true,
        stats: '3 tools · 12.4s · 2.1k tokens',
      });
    });
  });

  describe('done', () => {
    it('finalizes the trailing assistant item and clears streaming', () => {
      const state = reduceAll([
        { type: 'text', delta: 'all done ' },
        { type: 'text', delta: 'now' },
        { type: 'done' },
      ]);
      expect(selectItems(state)[0]).toMatchObject({
        kind: 'assistant',
        text: 'all done now',
        streaming: false,
      });
      expect(selectIsStreaming(state)).toBe(false);
      expect(selectIsDone(state)).toBe(true);
    });

    it('accepts further events after done (multi-turn fold)', () => {
      const state = reduceAll([
        { type: 'text', delta: 'turn one' },
        { type: 'done' },
        { type: 'text', delta: 'turn two' },
      ]);
      expect(selectItems(state)).toHaveLength(2);
      expect(selectIsStreaming(state)).toBe(true);
      expect(selectIsDone(state)).toBe(false);
    });

    it('folds a full mixed scenario in order', () => {
      const state = reduceAll([
        { type: 'thinking', delta: 'plan' },
        { type: 'thinking-end' },
        { type: 'text', delta: 'let me look' },
        { type: 'tool-start', id: 't1', tool: 'Read', title: 'Read a.ts' },
        { type: 'tool-output', id: 't1', delta: 'contents' },
        { type: 'tool-end', id: 't1', success: true, summary: 'ok' },
        { type: 'text', delta: 'found it' },
        {
          type: 'task-start',
          id: 's1',
          name: 'worker',
          description: 'verify',
        },
        { type: 'task-progress', id: 's1', line: 'step' },
        {
          type: 'task-end',
          id: 's1',
          tools: 1,
          seconds: 2,
          tokens: '0.1k',
        },
        { type: 'text', delta: 'summary' },
        { type: 'done' },
      ]);
      expect(selectItems(state).map((item) => item.kind)).toEqual([
        'thinking',
        'assistant',
        'tool',
        'assistant',
        'task',
        'assistant',
      ]);
      expect(selectItemById(state, 't1')).toMatchObject({ done: true });
      expect(selectItemById(state, 's1')).toMatchObject({ done: true });
      expect(selectIsDone(state)).toBe(true);
    });
  });

  it('never mutates items held by earlier states on any updating branch', () => {
    // Every branch that rewrites an existing item relies on
    // replace-not-mutate discipline over objects shared by reference with
    // every previously returned state, so fold one event per branch and
    // deep-check each captured snapshot after the whole fold.
    const scenarios: StreamEvent[][] = [
      [
        { type: 'text', delta: 'a' },
        { type: 'text', delta: 'b' },
      ],
      [
        { type: 'thinking', delta: 'a' },
        { type: 'thinking', delta: 'b' },
      ],
      [
        { type: 'tool-start', id: 't1', tool: 'Bash', title: 'ls' },
        { type: 'tool-output', id: 't1', delta: 'x' },
      ],
      [
        { type: 'tool-start', id: 't1', tool: 'Bash', title: 'ls' },
        { type: 'tool-end', id: 't1', success: true, summary: 'ok' },
      ],
      [
        { type: 'task-start', id: 's1', name: 'n', description: 'd' },
        { type: 'task-progress', id: 's1', line: 'step' },
      ],
      [
        { type: 'task-start', id: 's1', name: 'n', description: 'd' },
        { type: 'task-end', id: 's1', tools: 1, seconds: 1, tokens: '1' },
      ],
      // closeTrailingAssistant rewrites the streaming assistant when a
      // start/user/done event lands — pin the rewrite through a captured
      // snapshot that must survive the fold.
      [
        { type: 'text', delta: 'a' },
        { type: 'tool-start', id: 't1', tool: 'Bash', title: 'ls' },
      ],
      [{ type: 'text', delta: 'a' }, { type: 'done' }],
      // thinking-end rewrites the trailing thinking item to done.
      [{ type: 'thinking', delta: 'a' }, { type: 'thinking-end' }],
    ];
    for (const events of scenarios) {
      let state = initialStreamingModelState;
      const captured: Array<{
        items: readonly HistoryItem[];
        clone: HistoryItem[];
      }> = [];
      for (const event of events) {
        state = reduceStreamEvent(state, event);
        captured.push({
          items: state.items,
          clone: structuredClone([...state.items]),
        });
      }
      for (const { items, clone } of captured) {
        expect([...items]).toEqual(clone);
      }
    }
  });

  it('never mutates the previous state', () => {
    const before = reduceAll([{ type: 'text', delta: 'a' }]);
    const beforeItems = selectItems(before);
    reduceStreamEvent(before, { type: 'text', delta: 'b' });
    expect(selectItems(before)).toBe(beforeItems);
    expect(beforeItems).toHaveLength(1);
    expect(beforeItems[0]).toMatchObject({ text: 'a' });
  });
});
