// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  useNewSessionSuggestion,
  type NewSessionSuggestionState,
} from './useNewSessionSuggestion';
import type { Message } from '../adapters/types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latestSuggestion: NewSessionSuggestionState | null = null;

const testState = {
  enabled: true,
  inputText: '',
  messages: [] as Message[],
  sessionId: 'session-1' as string | undefined,
  contextUsageRatio: 0,
  isRunning: false,
  dialogOpen: false,
  hasAttachments: false as boolean | null,
  generateContent: vi.fn(async function* () {}),
};

function Host() {
  const { inputText, ...options } = testState;
  const { suggestion, updateInput } = useNewSessionSuggestion(options);
  React.useEffect(() => {
    updateInput(inputText);
  }, [inputText, updateInput]);
  latestSuggestion = suggestion;
  return null;
}

async function renderHost() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(React.createElement(Host));
  });
}

async function rerenderHost() {
  await act(async () => {
    root?.render(React.createElement(Host));
  });
}

async function flush(times = 1) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
  latestSuggestion = null;
  testState.enabled = true;
  testState.inputText = '';
  testState.messages = [];
  testState.sessionId = 'session-1';
  testState.contextUsageRatio = 0;
  testState.isRunning = false;
  testState.dialogOpen = false;
  testState.hasAttachments = false;
  testState.generateContent.mockReset();
  vi.useRealTimers();
});

describe('useNewSessionSuggestion', () => {
  it('does not suggest a new session for explicit new-task wording when there is almost no prior context', async () => {
    vi.useFakeTimers();
    testState.inputText = '帮我写一篇新的设计文档，主题是 Web Shell 新功能方案';
    testState.messages = [
      {
        id: 'm-1',
        role: 'user',
        content: 'hello',
        timestamp: 1,
      },
    ] as Message[];
    testState.contextUsageRatio = 0;

    await renderHost();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush(3);

    expect(latestSuggestion).toBeNull();
    expect(testState.generateContent).not.toHaveBeenCalled();
  });

  it('suggests a new session once explicit new-task wording has some existing context to diverge from', async () => {
    vi.useFakeTimers();
    testState.inputText = '帮我写一篇新的设计文档，主题是 Web Shell 新功能方案';
    testState.messages = [
      {
        id: 'm-1',
        role: 'user',
        content: '先看一下当前实现',
        timestamp: 1,
      },
      {
        id: 'm-2',
        role: 'assistant',
        content: '这里是当前实现的说明',
        timestamp: 2,
      },
    ] as Message[];
    testState.generateContent.mockImplementation(async function* () {
      yield {
        type: 'delta',
        requestId: 'req-1',
        seq: 0,
        text: JSON.stringify({
          suggestion: 'new_session',
          confidence: 0.9,
        }),
      };
      yield {
        type: 'done',
        requestId: 'req-1',
        model: 'fast-model',
        modelSource: 'fast',
      };
    });

    await renderHost();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush(3);

    expect(testState.generateContent).toHaveBeenCalledOnce();
    expect(latestSuggestion).toEqual({
      suggestion: 'new_session',
      classifiedInput: '帮我写一篇新的设计文档，主题是 Web Shell 新功能方案',
      sourceSessionId: 'session-1',
    });

    testState.inputText = '顺手补个测试';
    await rerenderHost();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush(3);

    expect(latestSuggestion).toBeNull();
  });

  it('reclassifies a preserved draft after the session changes', async () => {
    vi.useFakeTimers();
    testState.inputText = '帮我写一篇新的设计文档，主题是 Web Shell 新功能方案';
    testState.messages = [
      {
        id: 'm-1',
        role: 'user',
        content: '先看一下当前实现',
        timestamp: 1,
      },
      {
        id: 'm-2',
        role: 'assistant',
        content: '这里是当前实现的说明',
        timestamp: 2,
      },
    ] as Message[];
    testState.generateContent.mockImplementation(async function* () {
      yield {
        type: 'delta',
        requestId: 'req-1',
        seq: 0,
        text: JSON.stringify({
          suggestion: 'new_session',
          confidence: 0.9,
        }),
      };
    });

    await renderHost();
    testState.sessionId = 'session-2';
    await rerenderHost();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush(3);

    expect(testState.generateContent).toHaveBeenCalledOnce();
    expect(latestSuggestion?.sourceSessionId).toBe('session-2');
  });

  // The classifier is instructed to return JSON only, but live it sometimes
  // wraps a valid decision in prose or a code fence. These pin the extraction
  // fallback: recover the object when one is there, stay fail-closed when not.
  const NEW_TASK_DRAFT = '帮我写一篇新的设计文档，主题是 Web Shell 新功能方案';
  const CONTEXT_MESSAGES = [
    {
      id: 'm-1',
      role: 'user',
      content: '先看一下当前实现',
      timestamp: 1,
    },
    {
      id: 'm-2',
      role: 'assistant',
      content: '这里是当前实现的说明',
      timestamp: 2,
    },
  ] as Message[];

  async function classify(
    decisionText: string,
    inputText = NEW_TASK_DRAFT,
    messages = CONTEXT_MESSAGES,
  ) {
    vi.useFakeTimers();
    testState.inputText = inputText;
    testState.messages = messages;
    testState.generateContent.mockImplementation(async function* () {
      yield {
        type: 'delta',
        requestId: 'req-1',
        seq: 0,
        text: decisionText,
      };
      yield {
        type: 'done',
        requestId: 'req-1',
        model: 'fast-model',
        modelSource: 'fast',
      };
    });

    await renderHost();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush(3);
  }

  it('classifies a side question after only one prior exchange', async () => {
    const sideQuestion = '这里的 confidence 阈值为什么是 0.75？';
    await classify(
      JSON.stringify({ suggestion: 'btw', confidence: 0.92 }),
      sideQuestion,
    );

    expect(testState.generateContent).toHaveBeenCalledOnce();
    expect(latestSuggestion).toEqual({
      suggestion: 'btw',
      classifiedInput: sideQuestion,
      sourceSessionId: 'session-1',
    });
  });

  it('lets common side-question wording reach the classifier', async () => {
    const sideQuestion = '顺手问下，这里的 confidence 阈值为什么是 0.75？';
    await classify(
      JSON.stringify({ suggestion: 'btw', confidence: 0.9 }),
      sideQuestion,
    );

    expect(testState.generateContent).toHaveBeenCalledOnce();
    expect(latestSuggestion?.suggestion).toBe('btw');
  });

  it('does not surface new_session from the relaxed BTW context floor', async () => {
    await classify(
      JSON.stringify({ suggestion: 'new_session', confidence: 0.96 }),
      '这里的 confidence 阈值为什么是 0.75？',
    );

    expect(testState.generateContent).toHaveBeenCalledOnce();
    expect(latestSuggestion).toBeNull();
  });

  it('does not classify BTW with less than one prior exchange', async () => {
    await classify(
      JSON.stringify({ suggestion: 'btw', confidence: 0.96 }),
      '这里的 confidence 阈值为什么是 0.75？',
      CONTEXT_MESSAGES.slice(0, 1),
    );

    expect(testState.generateContent).not.toHaveBeenCalled();
    expect(latestSuggestion).toBeNull();
  });

  it.each([true, null])(
    'does not classify a low-context side question when attachment presence is %s',
    async (hasAttachments) => {
      testState.hasAttachments = hasAttachments;
      await classify(
        JSON.stringify({ suggestion: 'btw', confidence: 0.96 }),
        '这里的 confidence 阈值为什么是 0.75？',
      );

      expect(testState.generateContent).not.toHaveBeenCalled();
      expect(latestSuggestion).toBeNull();
    },
  );

  it('recovers a positive decision wrapped in prose (observed live)', async () => {
    // Verbatim shape from a live run: prose preamble + bare JSON.
    await classify(
      'The user is explicitly switching to a completely new task, which is ' +
        'unrelated to the previous discussion. This is a clear topic change.\n\n' +
        JSON.stringify({ suggestion: 'new_session', confidence: 0.98 }),
    );

    expect(testState.generateContent).toHaveBeenCalledOnce();
    expect(latestSuggestion).toEqual({
      suggestion: 'new_session',
      classifiedInput: NEW_TASK_DRAFT,
      sourceSessionId: 'session-1',
    });
  });

  it('recovers a positive decision inside a code fence', async () => {
    await classify(
      '```json\n' +
        JSON.stringify({ suggestion: 'new_session', confidence: 0.95 }) +
        '\n```',
    );

    expect(latestSuggestion).toEqual({
      suggestion: 'new_session',
      classifiedInput: NEW_TASK_DRAFT,
      sourceSessionId: 'session-1',
    });
  });

  it('keeps the banner hidden for a valid none decision', async () => {
    await classify(
      'This is a follow-up on the same topic.\n\n' +
        JSON.stringify({ suggestion: 'none', confidence: 0.97 }),
    );

    expect(testState.generateContent).toHaveBeenCalledOnce();
    expect(latestSuggestion).toBeNull();
  });

  it('suggests BTW for a side question without attachments', async () => {
    await classify(JSON.stringify({ suggestion: 'btw', confidence: 0.92 }));

    expect(latestSuggestion).toEqual({
      suggestion: 'btw',
      classifiedInput: NEW_TASK_DRAFT,
      sourceSessionId: 'session-1',
    });
  });

  it.each([true, null])(
    'does not suggest BTW when attachment presence is %s',
    async (hasAttachments) => {
      testState.hasAttachments = hasAttachments;
      await classify(JSON.stringify({ suggestion: 'btw', confidence: 0.92 }));

      expect(latestSuggestion).toBeNull();
    },
  );

  it.each([
    JSON.stringify({ shouldSuggestNewSession: true, confidence: 0.98 }),
    JSON.stringify({ suggestion: 'later', confidence: 0.98 }),
    JSON.stringify({ suggestion: 'btw', confidence: 1.1 }),
  ])('stays fail-closed for an invalid decision: %s', async (decision) => {
    await classify(decision);

    expect(latestSuggestion).toBeNull();
  });

  it('stays fail-closed on prose with no recoverable JSON object', async () => {
    await classify(
      'I think {this draft} switches topics, but here is no JSON to parse.',
    );

    expect(testState.generateContent).toHaveBeenCalledOnce();
    expect(latestSuggestion).toBeNull();
  });
});
