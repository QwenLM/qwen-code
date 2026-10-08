// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_FEEDBACK_STORAGE_KEY,
  MAX_ASSISTANT_FEEDBACK_SESSIONS,
  describeFeedbackUserMessage,
  feedbackUserMessageOf,
  notifyAssistantFeedback,
  readAssistantFeedbackStore,
  setAssistantFeedbackRating,
  shouldOfferAssistantFeedback,
  writeAssistantFeedbackStore,
  type AssistantFeedbackStore,
} from './assistantFeedback';

function storeOf(sessionIds: readonly string[]): AssistantFeedbackStore {
  const store: AssistantFeedbackStore = {};
  for (const sessionId of sessionIds) {
    store[sessionId] = { 'turn-1': 'up' };
  }
  return store;
}

function sessionIds(n: number): string[] {
  return Array.from({ length: n }, (_, index) => `session-${index}`);
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('readAssistantFeedbackStore', () => {
  it('round-trips what writeAssistantFeedbackStore persisted', () => {
    const store = setAssistantFeedbackRating({}, 'session-1', 'turn-1', 'down');
    writeAssistantFeedbackStore(store);
    expect(readAssistantFeedbackStore()).toEqual({
      'session-1': { 'turn-1': 'down' },
    });
  });

  it('degrades to nothing marked instead of guessing', () => {
    window.localStorage.setItem(ASSISTANT_FEEDBACK_STORAGE_KEY, 'not json');
    expect(readAssistantFeedbackStore()).toEqual({});

    window.localStorage.setItem(
      ASSISTANT_FEEDBACK_STORAGE_KEY,
      JSON.stringify({ v: 1, 'session-1': { 'turn-1': 'maybe' } }),
    );
    expect(readAssistantFeedbackStore()).toEqual({});

    window.localStorage.setItem(ASSISTANT_FEEDBACK_STORAGE_KEY, '"a string"');
    expect(readAssistantFeedbackStore()).toEqual({});
  });

  it('ignores a payload written by another version', () => {
    window.localStorage.setItem(
      ASSISTANT_FEEDBACK_STORAGE_KEY,
      JSON.stringify({ v: 99, 'session-1': { 'turn-1': 'up' } }),
    );
    expect(readAssistantFeedbackStore()).toEqual({});
  });

  it('survives a localStorage that refuses to be read', () => {
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('unavailable');
      });
    expect(readAssistantFeedbackStore()).toEqual({});
    // Positive control: without this the assertion above passes on an empty
    // localStorage even if the spy never intercepts.
    expect(getItem).toHaveBeenCalled();
  });
});

describe('writeAssistantFeedbackStore', () => {
  it('never throws when localStorage refuses to be written', () => {
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('quota exceeded');
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      writeAssistantFeedbackStore(storeOf(['session-1'])),
    ).not.toThrow();
    expect(setItem).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('keeps only the most recent sessions', () => {
    writeAssistantFeedbackStore(storeOf(sessionIds(12)));
    const stored = readAssistantFeedbackStore();
    expect(Object.keys(stored)).toHaveLength(MAX_ASSISTANT_FEEDBACK_SESSIONS);
    expect(Object.keys(stored)).toEqual(sessionIds(12).slice(2));
  });
});

describe('setAssistantFeedbackRating', () => {
  it('marks, switches, and clears a turn', () => {
    const marked = setAssistantFeedbackRating({}, 'session-1', 'turn-1', 'up');
    expect(marked).toEqual({ 'session-1': { 'turn-1': 'up' } });
    const switched = setAssistantFeedbackRating(
      marked,
      'session-1',
      'turn-1',
      'down',
    );
    expect(switched).toEqual({ 'session-1': { 'turn-1': 'down' } });
    expect(
      setAssistantFeedbackRating(switched, 'session-1', 'turn-1', null),
    ).toEqual({});
  });

  it('keeps a session that is still being rated out of the prune order', () => {
    const atLimit = storeOf(sessionIds(MAX_ASSISTANT_FEEDBACK_SESSIONS));
    const edited = setAssistantFeedbackRating(
      atLimit,
      'session-0',
      'turn-1',
      'down',
    );
    // Adding one more session must drop the stalest one, not the just-edited.
    writeAssistantFeedbackStore({
      ...edited,
      'session-10': { 'turn-1': 'up' },
    });
    const stored = readAssistantFeedbackStore();
    expect(Object.keys(stored)).toContain('session-0');
    expect(Object.keys(stored)).not.toContain('session-1');
  });

  it('ignores an empty session or turn id', () => {
    const store = storeOf(['session-1']);
    expect(setAssistantFeedbackRating(store, '', 'turn-1', 'up')).toBe(store);
    expect(setAssistantFeedbackRating(store, 'session-1', '', 'up')).toBe(
      store,
    );
  });
});

describe('shouldOfferAssistantFeedback', () => {
  const offer = (overrides: {
    renderMode?: 'interactive' | 'readonly' | 'document';
    sessionId?: string;
    options?: { enabled?: boolean };
  }) =>
    shouldOfferAssistantFeedback({
      renderMode: overrides.renderMode ?? 'interactive',
      sessionId: 'sessionId' in overrides ? overrides.sessionId : 'session-1',
      options: 'options' in overrides ? overrides.options : {},
    });

  it('offers the marks to a live session the host opted in', () => {
    expect(offer({})).toBe(true);
  });

  it('stays off when the host did not opt in', () => {
    expect(offer({ options: undefined })).toBe(false);
  });

  it('stays off when the host switched it back off', () => {
    expect(offer({ options: { enabled: false } })).toBe(false);
  });

  it('stays off without a session to store the mark against', () => {
    expect(offer({ sessionId: undefined })).toBe(false);
  });

  it('stays off in a read-only or embedded transcript', () => {
    expect(offer({ renderMode: 'readonly' })).toBe(false);
    expect(offer({ renderMode: 'document' })).toBe(false);
  });
});

describe('describeFeedbackUserMessage', () => {
  it('keeps the tail of a long prompt', () => {
    const prompt = `${'a'.repeat(150)}TAIL`;
    const described = describeFeedbackUserMessage({ content: prompt });
    expect(described.text).toHaveLength(100);
    expect(described.text.endsWith('TAIL')).toBe(true);
  });

  it('trims and forwards a short prompt whole', () => {
    expect(
      describeFeedbackUserMessage({ content: '  hello  ', timestamp: 42 }),
    ).toEqual({ text: 'hello', timestamp: 42 });
  });

  it('names what a text-less prompt carried', () => {
    expect(
      describeFeedbackUserMessage({ content: '', images: [{}] }).text,
    ).toBe('[图片]');
    expect(
      describeFeedbackUserMessage({ content: '   ', files: [{}] }).text,
    ).toBe('[附件]');
    expect(
      describeFeedbackUserMessage({
        content: '',
        images: [{}, {}],
        files: [{}],
      }).text,
    ).toBe('[图片] [附件]');
  });

  it('leaves the timestamp out when the transcript has none', () => {
    expect(describeFeedbackUserMessage({ content: 'hi' })).toEqual({
      text: 'hi',
    });
  });
});

describe('feedbackUserMessageOf', () => {
  const messages = [
    { id: 'u1', role: 'user', content: 'first prompt', timestamp: 10 },
    { id: 'a1', role: 'assistant', content: 'answer' },
    { id: 's1', role: 'user_shell', command: 'ls -la', timestamp: 20 },
  ];

  it('reports the prompt of the turn it is asked about', () => {
    expect(feedbackUserMessageOf(messages, 'u1')).toEqual({
      text: 'first prompt',
      timestamp: 10,
    });
  });

  it('uses a shell turn\u2019s command as its prompt', () => {
    expect(feedbackUserMessageOf(messages, 's1')).toEqual({
      text: 'ls -la',
      timestamp: 20,
    });
  });

  it('reports an unknown prompt rather than guessing one', () => {
    expect(feedbackUserMessageOf(messages, 'missing')).toEqual({ text: '' });
    expect(feedbackUserMessageOf(messages, 'a1')).toEqual({ text: '' });
  });
});

describe('notifyAssistantFeedback', () => {
  const info = {
    rating: 'up' as const,
    promptId: 'prompt-1',
    sessionId: 'session-1',
    userMessage: { text: 'hello', timestamp: 42 },
  };

  it('hands the mark to the host', () => {
    const handler = vi.fn();
    notifyAssistantFeedback(handler, info);
    expect(handler).toHaveBeenCalledWith(info);
  });

  it('does nothing without a handler', () => {
    expect(() => notifyAssistantFeedback(undefined, info)).not.toThrow();
  });

  it('swallows a throwing handler: the mark is already made', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      notifyAssistantFeedback(() => {
        throw new Error('host blew up');
      }, info),
    ).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});
