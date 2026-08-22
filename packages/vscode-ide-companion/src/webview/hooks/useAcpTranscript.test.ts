/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAcpTranscript } from './useAcpTranscript.js';

function userTextNotification(
  sessionId: string,
  text: string,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text },
    },
  };
}

function postToWebview(message: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

describe('useAcpTranscript', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let captured: { blocks: ReturnType<typeof useAcpTranscript> };

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    captured = { blocks: [] };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    function Harness() {
      captured.blocks = useAcpTranscript();
      return null;
    }

    act(() => {
      root?.render(createElement(Harness));
    });
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

  it('reduces transcriptUpdate messages into rendered blocks', () => {
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: userTextNotification('session-a', 'hello '),
      });
    });
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: userTextNotification('session-a', 'world'),
      });
    });

    expect(captured.blocks).toHaveLength(1);
    expect(captured.blocks[0]).toMatchObject({
      kind: 'user',
      text: 'hello world',
    });
  });

  it('resets transcript state when qwenSessionSwitched arrives between sessions', () => {
    // Session A replays its own user text.
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: userTextNotification('session-a', 'alpha'),
      });
    });
    expect(captured.blocks).toHaveLength(1);

    // Session boundary: the extension clears the UI before replaying the
    // newly-selected session through ACP.
    act(() => {
      postToWebview({
        type: 'qwenSessionSwitched',
        data: { sessionId: 'session-b', messages: [] },
      });
    });
    expect(captured.blocks).toHaveLength(0);

    // Session B's replay must not merge with session A's leftover state.
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: userTextNotification('session-b', 'beta'),
      });
    });

    expect(captured.blocks).toHaveLength(1);
    expect(captured.blocks[0]).toMatchObject({ kind: 'user', text: 'beta' });
  });

  it('resets transcript state when a new session clears the conversation', () => {
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: userTextNotification('session-a', 'alpha'),
      });
    });
    expect(captured.blocks).toHaveLength(1);

    act(() => {
      postToWebview({ type: 'conversationCleared', data: {} });
    });
    expect(captured.blocks).toHaveLength(0);

    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: userTextNotification('session-b', 'beta'),
      });
    });
    expect(captured.blocks).toHaveLength(1);
    expect(captured.blocks[0]).toMatchObject({ kind: 'user', text: 'beta' });
  });
});
