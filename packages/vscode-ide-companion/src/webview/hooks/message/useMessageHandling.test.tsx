/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessageHandling, type TextMessage } from './useMessageHandling.js';

type MessageHandlingApi = ReturnType<typeof useMessageHandling>;

function renderHookHarness() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  let latestApi: MessageHandlingApi | null = null;

  function Harness() {
    latestApi = useMessageHandling();
    return null;
  }

  act(() => {
    root.render(<Harness />);
  });

  return {
    container,
    root,
    get api(): MessageHandlingApi {
      if (!latestApi) {
        throw new Error('Hook API is not available');
      }
      return latestApi;
    },
  };
}

/**
 * The webview merges text messages and tool calls and sorts them by
 * `timestamp` for rendering. Two known bugs push that sort in opposite
 * directions:
 *
 *   - Tool-call interleave: a tool call that arrives between two assistant
 *     segments of the same turn must sort strictly between them. This
 *     requires seg1.ts < toolCall.ts < seg2.ts.
 *
 *   - #3273 (user question appears above the previous assistant answer):
 *     a user message belonging to a later turn must sort after every
 *     segment / tool call of the previous turn, even if the later segment
 *     was created after the user message was added. This requires all
 *     segments of turn N to be strictly less than any message/tool call
 *     from turn N+1.
 *
 * A single timestamp strategy cannot satisfy both simultaneously without a
 * monotonic-sequence layer. These tests pin the current behaviour of the
 * hook so we can wire a proper fix in next.
 */
describe('useMessageHandling', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  it('assigns the second assistant segment a newer timestamp so a tool call can sort between the two segments', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const rendered = renderHookHarness();
    root = rendered.root;
    container = rendered.container;

    act(() => {
      rendered.api.startStreaming(1_000);
    });

    act(() => {
      rendered.api.appendStreamChunk('seg1');
    });

    // Tool call arrives and triggers a segment break.
    vi.setSystemTime(2_000);
    const toolCallTimestamp = Date.now();
    act(() => {
      rendered.api.breakAssistantSegment();
    });

    // Next chunk lands after the tool call.
    vi.setSystemTime(3_000);
    act(() => {
      rendered.api.appendStreamChunk('seg2');
    });

    const assistantMessages = rendered.api.messages.filter(
      (message): message is TextMessage => message.role === 'assistant',
    );

    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0].timestamp).toBeLessThan(toolCallTimestamp);
    expect(assistantMessages[1].timestamp).toBeGreaterThan(toolCallTimestamp);
  });

  it('keeps thinking after the user message when streamStart shares the same timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const rendered = renderHookHarness();
    root = rendered.root;
    container = rendered.container;

    act(() => {
      rendered.api.addMessage({
        role: 'user',
        content: 'edited prompt',
        timestamp: 1_000,
      });
    });

    act(() => {
      rendered.api.startStreaming(1_000);
    });

    act(() => {
      rendered.api.appendThinkingChunk('thinking');
    });

    const sorted = [...rendered.api.messages].sort(
      (a, b) => a.timestamp - b.timestamp,
    );

    expect(sorted.map((message) => message.role)).toEqual([
      'user',
      'thinking',
      'assistant',
    ]);
  });

  it.fails(
    'keeps every assistant segment of a turn before a user message that was sent between segments (#3273)',
    () => {
      // Reproduces the race that #3273 describes: React batching (or any
      // other delay) causes the second segment's placeholder to materialize
      // AFTER the next user message has already been pushed into the list.
      // Because the placeholder uses Date.now() at materialization time, it
      // receives a timestamp greater than the new user message, and the
      // user bubble ends up sandwiched between the two assistant segments
      // once the list is sorted.
      vi.useFakeTimers();
      vi.setSystemTime(1_000);

      const rendered = renderHookHarness();
      root = rendered.root;
      container = rendered.container;

      act(() => {
        rendered.api.startStreaming(1_000);
      });

      act(() => {
        rendered.api.appendStreamChunk('seg1');
      });

      vi.setSystemTime(2_000);
      act(() => {
        rendered.api.breakAssistantSegment();
      });

      // The user types and sends their next question before the delayed
      // second-segment chunk is flushed.
      vi.setSystemTime(3_000);
      act(() => {
        rendered.api.addMessage({
          role: 'user',
          content: 'next question',
          timestamp: Date.now(),
        });
      });

      // Second-segment chunk finally runs.
      vi.setSystemTime(4_000);
      act(() => {
        rendered.api.appendStreamChunk('seg2');
      });

      const sorted = [...rendered.api.messages].sort(
        (a, b) => a.timestamp - b.timestamp,
      );
      const roles = sorted.map((m) => m.role);
      const userIdx = roles.indexOf('user');
      const lastAssistantIdx = roles.lastIndexOf('assistant');

      // Expected (and currently violated) invariant: the user message marks
      // the start of a new turn, so every assistant segment of the previous
      // turn must come before it.
      expect(lastAssistantIdx).toBeLessThan(userIdx);
    },
  );
});
