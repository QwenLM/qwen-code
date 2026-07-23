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
  generateContent: vi.fn(async function* () {}),
};

function Host() {
  const { suggestion } = useNewSessionSuggestion(testState);
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
          shouldSuggestNewSession: true,
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
      isVisible: true,
      classifiedInput: '帮我写一篇新的设计文档，主题是 Web Shell 新功能方案',
    });

    testState.inputText = '顺手补个测试';
    await rerenderHost();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush(3);

    expect(latestSuggestion).toBeNull();
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

  async function classify(decisionText: string) {
    vi.useFakeTimers();
    testState.inputText = NEW_TASK_DRAFT;
    testState.messages = CONTEXT_MESSAGES;
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

  it('recovers a positive decision wrapped in prose (observed live)', async () => {
    // Verbatim shape from a live run: prose preamble + bare JSON.
    await classify(
      'The user is explicitly switching to a completely new task, which is ' +
        'unrelated to the previous discussion. This is a clear topic change.\n\n' +
        JSON.stringify({ shouldSuggestNewSession: true, confidence: 0.98 }),
    );

    expect(testState.generateContent).toHaveBeenCalledOnce();
    expect(latestSuggestion).toEqual({
      isVisible: true,
      classifiedInput: NEW_TASK_DRAFT,
    });
  });

  it('recovers a positive decision inside a code fence', async () => {
    await classify(
      '```json\n' +
        JSON.stringify({ shouldSuggestNewSession: true, confidence: 0.95 }) +
        '\n```',
    );

    expect(latestSuggestion).toEqual({
      isVisible: true,
      classifiedInput: NEW_TASK_DRAFT,
    });
  });

  it('keeps the banner hidden for a prose-wrapped negative decision', async () => {
    await classify(
      'This is a follow-up on the same topic.\n\n' +
        JSON.stringify({ shouldSuggestNewSession: false, confidence: 0.97 }),
    );

    expect(testState.generateContent).toHaveBeenCalledOnce();
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
