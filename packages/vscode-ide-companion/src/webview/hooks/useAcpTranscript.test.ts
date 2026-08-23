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

function assistantTextNotification(
  sessionId: string,
  text: string,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
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

  it('resets transcript state when conversationLoaded arrives on reconnect', () => {
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: userTextNotification('session-a', 'alpha'),
      });
    });
    expect(captured.blocks).toHaveLength(1);

    // Agent reconnect initialises an empty conversation and only posts
    // conversationLoaded; the previous session's blocks must not survive.
    act(() => {
      postToWebview({
        type: 'conversationLoaded',
        data: { id: 'temp', messages: [] },
      });
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

  it('drops late transcript frames from a previous session after a switch', () => {
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: userTextNotification('session-a', 'first'),
      });
    });
    expect(captured.blocks).toHaveLength(1);

    act(() => {
      postToWebview({
        type: 'qwenSessionSwitched',
        data: { sessionId: 'session-b', messages: [] },
      });
    });
    expect(captured.blocks).toHaveLength(0);

    // Session A's turn is still running on the CLI and emits a trailing
    // frame after the boundary; it must not contaminate session B.
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: userTextNotification('session-a', 'late tail from A'),
      });
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

  it('seeds the transcript from cached messages carried by qwenSessionSwitched', () => {
    act(() => {
      postToWebview({
        type: 'qwenSessionSwitched',
        data: {
          sessionId: 'session-cached',
          messages: [
            { role: 'user', content: 'cached question', timestamp: 1 },
            { role: 'assistant', content: 'cached answer', timestamp: 2 },
            { role: 'thinking', content: 'cached thought', timestamp: 3 },
          ],
        },
      });
    });

    expect(captured.blocks).toHaveLength(3);
    expect(captured.blocks[0]).toMatchObject({
      kind: 'user',
      text: 'cached question',
    });
    expect(captured.blocks[1]).toMatchObject({
      kind: 'assistant',
      text: 'cached answer',
    });
    expect(captured.blocks[2]).toMatchObject({
      kind: 'thought',
      text: 'cached thought',
    });

    // History restores are completed turns; sessionLoadComplete finalizes
    // the last block so it does not keep streaming.
    act(() => {
      postToWebview({
        type: 'sessionLoadComplete',
        data: { sessionId: 'session-cached' },
      });
    });
    expect(captured.blocks[2]).toMatchObject({ streaming: false });
  });

  it('renders live frames of the fresh session published by a load-failure fallback', () => {
    // session/load failed for an archived session: the extension falls back
    // to cached history plus a fresh ACP session and publishes the fresh id
    // as liveSessionId alongside the archived sessionId.
    act(() => {
      postToWebview({
        type: 'qwenSessionSwitched',
        data: {
          sessionId: 'archived-session',
          liveSessionId: 'fresh-acp-session',
          messages: [
            { role: 'user', content: 'cached question', timestamp: 1 },
            { role: 'assistant', content: 'cached answer', timestamp: 2 },
          ],
        },
      });
    });

    expect(captured.blocks).toHaveLength(2);
    expect(captured.blocks[0]).toMatchObject({
      kind: 'user',
      text: 'cached question',
    });
    expect(captured.blocks[1]).toMatchObject({
      kind: 'assistant',
      text: 'cached answer',
    });

    // The extension posts sessionLoadComplete right after the boundary to
    // finalize the cached history before the user interacts.
    act(() => {
      postToWebview({
        type: 'sessionLoadComplete',
        data: { sessionId: 'archived-session' },
      });
    });
    expect(captured.blocks).toHaveLength(2);
    expect(captured.blocks[1]).toMatchObject({ streaming: false });

    // Live frames of the fresh session (user echo + assistant reply) must
    // render even though the boundary's sessionId named the archived one.
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: userTextNotification('fresh-acp-session', 'follow-up'),
      });
    });
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: assistantTextNotification('fresh-acp-session', 'live answer'),
      });
    });

    expect(captured.blocks).toHaveLength(4);
    expect(captured.blocks[2]).toMatchObject({
      kind: 'user',
      text: 'follow-up',
    });
    expect(captured.blocks[3]).toMatchObject({
      kind: 'assistant',
      text: 'live answer',
    });

    // Frames from unrelated sessions must still be dropped by the guard.
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: userTextNotification('unrelated-session', 'stray'),
      });
    });
    expect(captured.blocks).toHaveLength(4);
  });

  it('finalizes the streaming assistant block when the turn ends', () => {
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: userTextNotification('session-a', 'hi'),
      });
    });
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: assistantTextNotification('session-a', 'answer'),
      });
    });

    const assistant = captured.blocks.find((b) => b.kind === 'assistant');
    expect(assistant).toMatchObject({ kind: 'assistant', streaming: true });

    act(() => {
      postToWebview({
        type: 'streamEnd',
        data: { timestamp: Date.now(), reason: 'end_turn' },
      });
    });

    const finished = captured.blocks.find((b) => b.kind === 'assistant');
    expect(finished).toMatchObject({
      kind: 'assistant',
      text: 'answer',
      streaming: false,
    });
  });

  it('finalizes blocks with a cancelled reason when the user cancels', () => {
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: assistantTextNotification('session-a', 'partial'),
      });
    });
    expect(captured.blocks[0]).toMatchObject({ streaming: true });

    act(() => {
      postToWebview({
        type: 'streamEnd',
        data: { timestamp: Date.now(), reason: 'user_cancelled' },
      });
    });
    expect(captured.blocks[0]).toMatchObject({ streaming: false });
  });
});
