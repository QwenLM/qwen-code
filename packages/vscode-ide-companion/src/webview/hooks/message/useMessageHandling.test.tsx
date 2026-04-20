/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('useMessageHandling', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
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

  it('keeps the original stream timestamp when a tool call splits one assistant reply into multiple segments', () => {
    const rendered = renderHookHarness();
    root = rendered.root;
    container = rendered.container;

    act(() => {
      rendered.api.startStreaming(1_000);
    });

    act(() => {
      rendered.api.appendStreamChunk('before tool call');
    });

    act(() => {
      rendered.api.breakAssistantSegment();
    });

    act(() => {
      rendered.api.appendStreamChunk('after tool call');
    });

    const assistantMessages = rendered.api.messages.filter(
      (message): message is TextMessage => message.role === 'assistant',
    );

    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages.map((message) => message.timestamp)).toEqual([
      1_000, 1_000,
    ]);
  });
});
