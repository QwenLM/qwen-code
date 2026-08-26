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

function toolCallNotification(
  sessionId: string,
  toolCallId: string,
): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId,
      status: 'in_progress',
      title: 'Running command',
      kind: 'execute',
    },
  } as SessionNotification;
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

  it('drops frames of the abandoned session after conversationCleared publishes the fresh id', () => {
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: assistantTextNotification('session-a', 'old turn'),
      });
    });
    expect(captured.blocks).toHaveLength(1);

    // New-session flow: the extension creates the fresh ACP session first
    // and publishes its id with the boundary.
    act(() => {
      postToWebview({
        type: 'conversationCleared',
        data: { sessionId: 'session-b' },
      });
    });
    expect(captured.blocks).toHaveLength(0);

    // The abandoned session may still be streaming on the CLI; its
    // trailing frames must not be adopted into the fresh conversation.
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: assistantTextNotification(
          'session-a',
          'STALE tail of old session',
        ),
      });
    });
    expect(captured.blocks).toHaveLength(0);

    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: userTextNotification('session-b', 'fresh'),
      });
    });
    expect(captured.blocks).toHaveLength(1);
    expect(captured.blocks[0]).toMatchObject({ kind: 'user', text: 'fresh' });
  });

  it('keeps the guard pinned when conversationLoaded carries the session id', () => {
    act(() => {
      postToWebview({
        type: 'conversationCleared',
        data: { sessionId: 'session-b' },
      });
    });

    // First send of the new session: conversationLoaded resets the state
    // but re-pins the guard via the carried session id, so a stale frame
    // racing the boundary is still dropped.
    act(() => {
      postToWebview({
        type: 'conversationLoaded',
        data: { id: 'conv_1', messages: [], sessionId: 'session-b' },
      });
    });

    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: assistantTextNotification(
          'session-a',
          'STALE tail of old session',
        ),
      });
    });
    expect(captured.blocks).toHaveLength(0);

    // The new session's echo and reply render normally.
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: userTextNotification('session-b', 'hello'),
      });
    });
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: assistantTextNotification('session-b', 'reply'),
      });
    });
    expect(captured.blocks).toHaveLength(2);
    expect(captured.blocks[0]).toMatchObject({ kind: 'user', text: 'hello' });
    expect(captured.blocks[1]).toMatchObject({
      kind: 'assistant',
      text: 'reply',
    });
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

  it.each(['timeout', 'session_expired'] as const)(
    'force-finalizes an in-flight tool block when the stream ends with %s',
    (reason) => {
      act(() => {
        postToWebview({
          type: 'transcriptUpdate',
          data: toolCallNotification('session-a', 'call-1'),
        });
      });
      expect(captured.blocks[0]).toMatchObject({
        kind: 'tool',
        status: 'in_progress',
      });

      act(() => {
        postToWebview({
          type: 'streamEnd',
          data: { timestamp: Date.now(), reason },
        });
      });

      // The reducer only propagates abnormal termination for the
      // cancelled/error reasons; without the mapping the tool block would
      // keep its in-flight status and spin forever.
      expect(captured.blocks[0]).toMatchObject({
        kind: 'tool',
        status: 'cancelled',
      });
    },
  );

  it('force-finalizes an in-flight tool block when the user cancels', () => {
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: toolCallNotification('session-a', 'call-1'),
      });
    });
    expect(captured.blocks[0]).toMatchObject({
      kind: 'tool',
      status: 'in_progress',
    });

    act(() => {
      postToWebview({
        type: 'streamEnd',
        data: { timestamp: Date.now(), reason: 'user_cancelled' },
      });
    });
    expect(captured.blocks[0]).toMatchObject({
      kind: 'tool',
      status: 'cancelled',
    });
  });

  it('leaves an in-flight tool block running on a normal end_turn stream end', () => {
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: toolCallNotification('session-a', 'call-1'),
      });
    });

    act(() => {
      postToWebview({
        type: 'streamEnd',
        data: { timestamp: Date.now(), reason: 'end_turn' },
      });
    });

    // Transport-layer-style endings must not cancel in-flight tools; the
    // daemon still delivers the real terminal status via tool_call_update.
    expect(captured.blocks[0]).toMatchObject({
      kind: 'tool',
      status: 'in_progress',
    });
  });

  it('drops a stale untagged streamEnd while a tagged stream is active', () => {
    act(() => {
      postToWebview({
        type: 'streamStart',
        data: { timestamp: Date.now(), requestId: 'req-1' },
      });
    });
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: assistantTextNotification('session-a', 'first half '),
      });
    });

    // A foreign/stale turn-end (e.g. the abandoned previous request's
    // streamEnd) arrives mid-stream; finalizing here would split the
    // in-flight answer into two assistant blocks.
    act(() => {
      postToWebview({
        type: 'streamEnd',
        data: { timestamp: Date.now(), reason: 'user_cancelled' },
      });
    });

    expect(captured.blocks).toHaveLength(1);
    expect(captured.blocks[0]).toMatchObject({
      kind: 'assistant',
      text: 'first half ',
      streaming: true,
    });

    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: assistantTextNotification('session-a', 'second half'),
      });
    });

    // The reply stays in a single block instead of rendering split.
    expect(captured.blocks).toHaveLength(1);
    expect(captured.blocks[0]).toMatchObject({
      kind: 'assistant',
      text: 'first half second half',
      streaming: true,
    });

    // The matching tagged streamEnd still finalizes the turn.
    act(() => {
      postToWebview({
        type: 'streamEnd',
        data: { timestamp: Date.now(), reason: 'end_turn', requestId: 'req-1' },
      });
    });
    expect(captured.blocks[0]).toMatchObject({ streaming: false });
  });

  it('drops a streamEnd tagged for a different request while a tagged stream is active', () => {
    act(() => {
      postToWebview({
        type: 'streamStart',
        data: { timestamp: Date.now(), requestId: 'req-2' },
      });
    });
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: assistantTextNotification('session-a', 'answer'),
      });
    });

    act(() => {
      postToWebview({
        type: 'streamEnd',
        data: { timestamp: Date.now(), reason: 'end_turn', requestId: 'req-1' },
      });
    });

    expect(captured.blocks[0]).toMatchObject({ streaming: true });
  });

  it('ignores background-notification end-turns so they do not finalize the live turn', () => {
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: assistantTextNotification('session-a', 'streaming'),
      });
    });
    expect(captured.blocks[0]).toMatchObject({ streaming: true });

    // Background-task completion posts an end-turn (untagged, with the
    // background_notification source) while the interactive turn streams.
    act(() => {
      postToWebview({
        type: 'streamEnd',
        data: {
          timestamp: Date.now(),
          reason: 'end_turn',
          source: 'background_notification',
        },
      });
    });

    expect(captured.blocks[0]).toMatchObject({ streaming: true });

    // The live turn still finalizes on its own untagged end-turn when no
    // tagged stream is active.
    act(() => {
      postToWebview({
        type: 'streamEnd',
        data: { timestamp: Date.now(), reason: 'end_turn' },
      });
    });
    expect(captured.blocks[0]).toMatchObject({ streaming: false });
  });

  it('does not seed the transcript when qwenSessionSwitched carries no messages field', () => {
    const errors: Event[] = [];
    const onError = (event: Event) => {
      errors.push(event);
    };
    window.addEventListener('error', onError);
    try {
      act(() => {
        postToWebview({
          type: 'qwenSessionSwitched',
          data: { sessionId: 'session-no-messages' },
        });
      });

      // The boundary still resets the transcript, but nothing is seeded
      // and the handler must not crash on the missing cache array.
      expect(captured.blocks).toHaveLength(0);
      expect(errors).toHaveLength(0);
    } finally {
      window.removeEventListener('error', onError);
    }
  });

  it('does not clobber the fresh transcript when qwenSessionSwitched carries an empty messages array', () => {
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: userTextNotification('session-a', 'alpha'),
      });
    });
    expect(captured.blocks).toHaveLength(1);

    act(() => {
      postToWebview({
        type: 'qwenSessionSwitched',
        data: { sessionId: 'session-empty-cache', messages: [] },
      });
    });
    expect(captured.blocks).toHaveLength(0);

    // Live frames of the switched session render after the boundary.
    act(() => {
      postToWebview({
        type: 'transcriptUpdate',
        data: userTextNotification('session-empty-cache', 'live'),
      });
    });
    expect(captured.blocks).toHaveLength(1);
    expect(captured.blocks[0]).toMatchObject({ kind: 'user', text: 'live' });
  });
});
