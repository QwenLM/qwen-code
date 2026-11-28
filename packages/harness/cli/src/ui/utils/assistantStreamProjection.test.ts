/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ThoughtSummary } from '@qwen-code/core';
import type { HistoryItemWithoutId } from '../types.js';
import { createThinkingTextState } from '../state/thinkingTextState.js';
import { applyAssistantStreamDelta } from './assistantStreamProjection.js';

type DisplayCall =
  | ['history', HistoryItemWithoutId]
  | ['text', string]
  | ['thought', ThoughtSummary | null];

function createDisplayTarget() {
  const calls: DisplayCall[] = [];
  const target: Parameters<typeof applyAssistantStreamDelta>[1] = {
    thinkingTextState: createThinkingTextState(),
    addHistoryItem: (item) => {
      calls.push(['history', item]);
    },
    appendAssistantText: (text) => {
      calls.push(['text', text]);
    },
    setThought: (thought) => {
      calls.push(['thought', thought]);
    },
  };
  return { target, calls };
}

describe('applyAssistantStreamDelta', () => {
  const thinking = '**Checking cwd**\nInspecting';
  const thought = { subject: 'Checking cwd', description: 'Inspecting' };

  it('accumulates split thinking and updates its display without adding history', () => {
    const { target, calls } = createDisplayTarget();
    applyAssistantStreamDelta(
      { type: 'thinking_delta', text: '**Checking' },
      target,
    );
    applyAssistantStreamDelta(
      { type: 'thinking_delta', text: ' cwd**\nInspecting' },
      target,
    );
    expect(calls).toEqual([
      ['thought', { subject: '', description: '**Checking' }],
      ['thought', thought],
    ]);
    expect(target.thinkingTextState.takePending()).toBe(thinking);
    expect(target.thinkingTextState.markPersisted(thinking)).toBe(true);
  });

  it('preserves the existing empty thinking display update', () => {
    const { target, calls } = createDisplayTarget();
    applyAssistantStreamDelta({ type: 'thinking_delta', text: '' }, target);
    expect(calls).toEqual([['thought', { subject: '', description: '' }]]);
  });

  it('adds pending thinking before appending text and clearing the current thought', () => {
    const { target, calls } = createDisplayTarget();
    applyAssistantStreamDelta(
      { type: 'thinking_delta', text: thinking },
      target,
    );
    calls.length = 0;
    applyAssistantStreamDelta({ type: 'text_delta', text: 'Hello' }, target);
    expect(calls).toEqual([
      ['history', { type: 'thinking', thought }],
      ['text', 'Hello'],
      ['thought', null],
    ]);
    expect(target.thinkingTextState.takePending()).toBe('');
    expect(target.thinkingTextState.markPersisted(thinking)).toBe(false);
  });

  it.each(['Hello', '', ' \n'])(
    'preserves text content %j and clears the thought without pending thinking',
    (text) => {
      const { target, calls } = createDisplayTarget();
      applyAssistantStreamDelta({ type: 'text_delta', text }, target);
      expect(calls).toEqual([
        ['text', text],
        ['thought', null],
      ]);
    },
  );

  it.each(['', ' \n\t'])(
    'clears blank pending thinking %j without adding it to history',
    (text) => {
      const { target, calls } = createDisplayTarget();
      target.thinkingTextState.append(text);
      applyAssistantStreamDelta({ type: 'text_delta', text: 'Hello' }, target);
      expect(calls).toEqual([
        ['text', 'Hello'],
        ['thought', null],
      ]);
      expect(target.thinkingTextState.takePending()).toBe('');
    },
  );

  it('clears duplicate pending thinking without adding it to history again', () => {
    const { target, calls } = createDisplayTarget();
    target.thinkingTextState.markPersisted(thinking);
    target.thinkingTextState.append(` \n${thinking} \n`);
    applyAssistantStreamDelta({ type: 'text_delta', text: 'Hello' }, target);
    expect(calls).toEqual([
      ['text', 'Hello'],
      ['thought', null],
    ]);
    expect(target.thinkingTextState.takePending()).toBe('');
    expect(target.thinkingTextState.markPersisted(thinking)).toBe(false);
  });

  it('starts a new thinking segment after text while retaining prior history keys', () => {
    const { target, calls } = createDisplayTarget();
    target.thinkingTextState.append(thinking);
    applyAssistantStreamDelta({ type: 'text_delta', text: 'First' }, target);
    calls.length = 0;
    applyAssistantStreamDelta(
      { type: 'thinking_delta', text: '**Next**\nMore details' },
      target,
    );
    applyAssistantStreamDelta({ type: 'text_delta', text: 'Second' }, target);
    const nextThought = { subject: 'Next', description: 'More details' };
    expect(calls).toEqual([
      ['thought', nextThought],
      ['history', { type: 'thinking', thought: nextThought }],
      ['text', 'Second'],
      ['thought', null],
    ]);
    expect(target.thinkingTextState.markPersisted(thinking)).toBe(false);
  });
});
