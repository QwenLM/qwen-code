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
  foldLiveEvent,
  type LiveHistoryItem,
  type LiveToolItem,
} from './live-session-model.js';

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
