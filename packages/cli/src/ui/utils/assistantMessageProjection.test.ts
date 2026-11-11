/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { MessageType, type HistoryItemWithoutId } from '../types.js';
import { createThinkingTextState } from '../state/thinkingTextState.js';
import { applyAssistantStreamDelta } from './assistantStreamProjection.js';
import { appendAssistantMessageToHistory } from './assistantMessageProjection.js';

function createHistoryTarget() {
  const history: HistoryItemWithoutId[] = [];
  const target = {
    thinkingTextState: createThinkingTextState(),
    addHistoryItem: (item: HistoryItemWithoutId) => {
      history.push(item);
    },
  };
  return { target, history };
}

describe('appendAssistantMessageToHistory', () => {
  const thinking = '**Checking cwd**\nInspecting';
  const thought = { subject: 'Checking cwd', description: 'Inspecting' };

  it('adds all thinking blocks in order before the unmodified assistant text', () => {
    const { target, history } = createHistoryTarget();
    appendAssistantMessageToHistory(
      {
        thinkingTexts: [thinking, '**Next**\nMore details'],
        text: '  Hello\nworld  ',
      },
      target,
    );
    expect(history).toEqual([
      { type: 'thinking', thought },
      {
        type: 'thinking',
        thought: { subject: 'Next', description: 'More details' },
      },
      { type: MessageType.GEMINI, text: '  Hello\nworld  ' },
    ]);
  });

  it('deduplicates repeated thinking while retaining the remaining block order', () => {
    const { target, history } = createHistoryTarget();
    appendAssistantMessageToHistory(
      {
        thinkingTexts: [thinking, ` \n${thinking} \n`, '**Next**', thinking],
        text: 'Hello',
      },
      target,
    );
    expect(history).toEqual([
      { type: 'thinking', thought },
      { type: 'thinking', thought: { subject: 'Next', description: '' } },
      { type: MessageType.GEMINI, text: 'Hello' },
    ]);
  });

  it('shares thinking deduplication with the stream display helper', () => {
    const { target, history } = createHistoryTarget();
    const streamedText: string[] = [];
    const streamTarget = {
      ...target,
      appendAssistantText: (text: string) => {
        streamedText.push(text);
      },
      setThought: () => {},
    };
    applyAssistantStreamDelta(
      { type: 'thinking_delta', text: thinking },
      streamTarget,
    );
    applyAssistantStreamDelta(
      { type: 'text_delta', text: 'Hello' },
      streamTarget,
    );
    appendAssistantMessageToHistory(
      { thinkingTexts: [thinking], text: 'Hello' },
      target,
    );
    expect(history).toEqual([
      { type: 'thinking', thought },
      { type: MessageType.GEMINI, text: 'Hello' },
    ]);
    expect(streamedText).toEqual(['Hello']);
  });

  it.each(['', ' \n\t'])(
    'keeps thinking history without adding blank assistant text %j',
    (text) => {
      const { target, history } = createHistoryTarget();
      appendAssistantMessageToHistory(
        { thinkingTexts: [thinking], text },
        target,
      );
      expect(history).toEqual([{ type: 'thinking', thought }]);
    },
  );

  it('ignores blank thinking blocks and retains nonblank assistant text', () => {
    const { target, history } = createHistoryTarget();
    appendAssistantMessageToHistory(
      { thinkingTexts: ['', ' \n\t'], text: 'Hello' },
      target,
    );
    expect(history).toEqual([{ type: MessageType.GEMINI, text: 'Hello' }]);
  });

  it('retains assistant text in separate messages even when the text matches', () => {
    const { target, history } = createHistoryTarget();
    const message = { thinkingTexts: [], text: 'Hello' };
    appendAssistantMessageToHistory(message, target);
    appendAssistantMessageToHistory(message, target);
    expect(history).toEqual([
      { type: MessageType.GEMINI, text: 'Hello' },
      { type: MessageType.GEMINI, text: 'Hello' },
    ]);
  });

  it('does not change input data or clear pending thinking owned by the caller', () => {
    const { target, history } = createHistoryTarget();
    const message = Object.freeze({
      thinkingTexts: Object.freeze([thinking]),
      text: 'Hello',
    });
    target.thinkingTextState.append('pending segment');
    appendAssistantMessageToHistory(message, target);
    expect(message).toEqual({ thinkingTexts: [thinking], text: 'Hello' });
    expect(target.thinkingTextState.takePending()).toBe('pending segment');
    expect(target.thinkingTextState.markPersisted(thinking)).toBe(false);
    expect(history).toEqual([
      { type: 'thinking', thought },
      { type: MessageType.GEMINI, text: 'Hello' },
    ]);
  });
});
