// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import type { WebShellAssistantTurnSettledEvent } from './customization';
import type {
  DaemonPromptSettledEvent,
  DaemonPromptSettledListener,
} from './daemon/session/types';

const harness = vi.hoisted(() => ({
  sessionId: undefined as string | undefined,
  blocks: [] as readonly unknown[],
  listener: undefined as ((event: unknown) => void) | undefined,
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => ({ sessionId: harness.sessionId }),
  useTranscriptStore: () => ({
    getSnapshot: () => ({ blocks: harness.blocks }),
  }),
}));

vi.mock('./daemon/session/DaemonSessionProvider.js', () => ({
  useDaemonPromptSettled: (listener: unknown) => {
    harness.listener = listener as (event: unknown) => void;
  },
}));

import { AssistantTurnSettlementObserver } from './assistant-turn-settlement';
import { cleanupReact, mountReact } from './test/reactHarness';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function assistantBlock(
  id: string,
  text: string,
  init: {
    promptId?: string;
    parentToolCallId?: string;
    streaming?: boolean;
  } = {},
): DaemonTranscriptBlock {
  return {
    id,
    kind: 'assistant',
    text,
    clientReceivedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    streaming: false,
    ...init,
  } as unknown as DaemonTranscriptBlock;
}

function toolBlock(id: string, toolCallId: string): DaemonTranscriptBlock {
  // The SDK reducer never stamps `promptId` on tool blocks, so a `promptId`
  // filter over raw blocks drops every tool call of the turn.
  return {
    id,
    kind: 'tool',
    toolCallId,
    title: 'Tool',
    status: 'completed',
    clientReceivedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as DaemonTranscriptBlock;
}

function userBlock(
  id: string,
  text: string,
  promptId?: string,
): DaemonTranscriptBlock {
  return {
    id,
    kind: 'user',
    text,
    promptId,
    clientReceivedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as DaemonTranscriptBlock;
}

describe('assistant turn settlement projection', () => {
  let published: WebShellAssistantTurnSettledEvent[] = [];

  beforeEach(() => {
    published = [];
    harness.sessionId = 'session-1';
    harness.blocks = [];
    harness.listener = undefined;
  });

  afterEach(() => {
    cleanupReact();
  });

  function mountAndSettle(event: DaemonPromptSettledEvent) {
    mountReact(
      <AssistantTurnSettlementObserver
        onAssistantTurnSettled={(settled) => {
          published.push(settled);
        }}
      />,
    );
    const listener = harness.listener as
      | DaemonPromptSettledListener
      | undefined;
    if (!listener) throw new Error('observer did not subscribe');
    act(() => {
      listener(event);
    });
    if (published.length !== 1) {
      throw new Error(
        `expected one published settlement, got ${published.length}`,
      );
    }
    return published[0]!;
  }

  it('publishes the final top-level assistant message across a tool boundary', () => {
    harness.blocks = [
      assistantBlock('assistant-1', 'Let me check.', {
        promptId: 'prompt-live',
      }),
      toolBlock('tool-2', 'call-1'),
      assistantBlock('assistant-3', 'The answer is 42.', {
        promptId: 'prompt-live',
      }),
    ];

    const settled = mountAndSettle({
      sessionId: 'session-1',
      promptId: 'prompt-live',
      outcome: 'completed',
      stopReason: 'end_turn',
    });

    // Not the pre-tool block, and not both halves glued together: the tool
    // call is a message boundary even though it carries no `promptId`.
    expect(settled).toEqual({
      sessionId: 'session-1',
      promptId: 'prompt-live',
      outcome: 'completed',
      stopReason: 'end_turn',
      message: {
        id: 'assistant-3',
        content: 'The answer is 42.',
        isStreaming: false,
        timestamp: 1,
      },
    });
  });

  it('does not return subagent-owned assistant text as the turn answer', () => {
    harness.blocks = [
      assistantBlock('assistant-1', 'Delegating now.', {
        promptId: 'prompt-live',
      }),
      toolBlock('tool-2', 'call-1'),
      assistantBlock('assistant-3', 'subagent final text', {
        promptId: 'prompt-live',
        parentToolCallId: 'call-1',
      }),
    ];

    const settled = mountAndSettle({
      sessionId: 'session-1',
      promptId: 'prompt-live',
      outcome: 'completed',
      stopReason: 'end_turn',
    });

    expect(settled.message).toMatchObject({
      id: 'assistant-1',
      content: 'Delegating now.',
    });
  });

  it('skips a whitespace-only assistant block after a tool boundary', () => {
    // A whitespace-only assistant block after a tool call cannot merge (the
    // tool case sets `needsNewContentMessage`), so it renders as its own empty
    // message and would otherwise win the backward scan as the turn's final
    // message — dropping the substantive answer.
    harness.blocks = [
      assistantBlock('assistant-1', 'The answer is 42.', {
        promptId: 'prompt-live',
      }),
      toolBlock('tool-2', 'call-1'),
      assistantBlock('assistant-3', '   ', { promptId: 'prompt-live' }),
    ];

    const settled = mountAndSettle({
      sessionId: 'session-1',
      promptId: 'prompt-live',
      outcome: 'completed',
      stopReason: 'end_turn',
    });

    expect(settled.message).toEqual({
      id: 'assistant-1',
      content: 'The answer is 42.',
      isStreaming: false,
      timestamp: 1,
    });
  });

  it('omits the message for a settlement from another session', () => {
    harness.blocks = [
      assistantBlock('assistant-1', 'The answer is 42.', {
        promptId: 'prompt-live',
      }),
    ];

    const settled = mountAndSettle({
      sessionId: 'session-other',
      promptId: 'prompt-live',
      outcome: 'completed',
      stopReason: 'end_turn',
    });

    expect(settled).not.toHaveProperty('message');
  });

  it('does not settle a streaming assistant block as the turn answer', () => {
    // The block-level streaming guard must fire: the insight-segment adapter
    // branch pushes its assistant messages without `isStreaming`, so only the
    // block scan stands in front of publishing a still-streaming fragment.
    harness.blocks = [
      assistantBlock(
        'assistant-1',
        '{"insight_progress":{"stage":"planning","progress":0.5}} after',
        { promptId: 'prompt-live', streaming: true },
      ),
    ];

    const settled = mountAndSettle({
      sessionId: 'session-1',
      promptId: 'prompt-live',
      outcome: 'completed',
      stopReason: 'end_turn',
    });

    expect(settled).not.toHaveProperty('message');
  });

  it('does not settle a merged message that absorbed a streaming block from another prompt', () => {
    // The message-level streaming guard must fire: consecutive top-level
    // assistant blocks merge, and the merged message inherits the trailing
    // block's `streaming` even though that block is outside this prompt's
    // `promptBlockIds`.
    harness.blocks = [
      assistantBlock('assistant-1', 'The answer is 42.', {
        promptId: 'prompt-live',
      }),
      assistantBlock('assistant-2', 'next turn still typing', {
        promptId: 'prompt-other',
        streaming: true,
      }),
    ];

    const settled = mountAndSettle({
      sessionId: 'session-1',
      promptId: 'prompt-live',
      outcome: 'completed',
      stopReason: 'end_turn',
    });

    expect(settled).not.toHaveProperty('message');
  });

  it('treats a finished unstamped sibling as a foreign turn', () => {
    // Goal-runtime and background-notification turns never cross the
    // `session/prompt` boundary that sets `entry.activePromptId`, so their
    // frames are forwarded unstamped (`bridgeClient.ts:1066-1071`) and nothing
    // can backfill a block that already finished (`sdk-typescript
    // daemon/ui/transcript.ts:836-840`). Admitting it re-glues a foreign turn's
    // text onto this prompt's message id — the contamination the ownership
    // rule exists to stop, entering through the unstamped door.
    harness.blocks = [
      assistantBlock('assistant-1', 'The answer is 42.', {
        promptId: 'prompt-A',
      }),
      assistantBlock('assistant-2', 'goal turn text'),
    ];

    const settled = mountAndSettle({
      sessionId: 'session-1',
      promptId: 'prompt-A',
      outcome: 'completed',
      stopReason: 'end_turn',
    });

    expect(settled).not.toHaveProperty('message');
  });

  it('does not settle a merged message that absorbed an unstamped streaming block', () => {
    // The unstamped sibling is still open, so it stays owned: a later delta can
    // yet stamp it. The merged message inherits its `streaming`, and the
    // block-level guard cannot fire because the sibling is not in
    // `promptBlockIds` — the message-level guard is the sole defence against
    // handing a host unfinished text for a prompt reported `completed`.
    harness.blocks = [
      assistantBlock('assistant-1', 'The answer is 42.', {
        promptId: 'prompt-A',
      }),
      assistantBlock('assistant-2', 'still typing', { streaming: true }),
    ];

    const settled = mountAndSettle({
      sessionId: 'session-1',
      promptId: 'prompt-A',
      outcome: 'completed',
      stopReason: 'end_turn',
    });

    expect(settled).not.toHaveProperty('message');
  });

  it('does not publish one merged message for two adjacent prompts', () => {
    // A continuation carries no user prompt to echo (`bridge.ts` skips
    // `echoPromptToSessionBus` when `isContinue`), so two top-level assistant
    // blocks with different `promptId`s land adjacent with nothing between
    // them. The reducer keeps them as two blocks (`transcript.ts` refuses to
    // merge when both prompt ids are set and differ) and the adapter then
    // merges them into ONE message that keeps the first block's `id` and
    // concatenates both texts. An intersection test published that same
    // message for both prompts: turn B's answer attributed to turn A, under a
    // message id both settlements share.
    harness.blocks = [
      assistantBlock('assistant-1', 'The answer is 42.', {
        promptId: 'prompt-A',
      }),
      assistantBlock('assistant-2', 'next turn text', { promptId: 'prompt-B' }),
    ];

    const settledA = mountAndSettle({
      sessionId: 'session-1',
      promptId: 'prompt-A',
      outcome: 'completed',
      stopReason: 'end_turn',
    });
    expect(settledA).not.toHaveProperty('message');

    cleanupReact();
    published = [];
    const settledB = mountAndSettle({
      sessionId: 'session-1',
      promptId: 'prompt-B',
      outcome: 'completed',
      stopReason: 'end_turn',
    });
    // Not A's message id, and not the glued content: B must never inherit a
    // message that also carries A's text.
    expect(settledB).not.toHaveProperty('message');
  });

  it('still publishes each turn its own message when a user echo separates them', () => {
    // Guards the fix against over-rejecting: whole-message ownership must not
    // cost an ordinary turn (user echo between the two assistant blocks) its
    // settlement, and the two prompts must get two distinct message ids.
    harness.blocks = [
      assistantBlock('assistant-1', 'The answer is 42.', {
        promptId: 'prompt-A',
      }),
      userBlock('user-2', 'and next?', 'prompt-B'),
      assistantBlock('assistant-3', 'next turn text', { promptId: 'prompt-B' }),
    ];

    const settledA = mountAndSettle({
      sessionId: 'session-1',
      promptId: 'prompt-A',
      outcome: 'completed',
      stopReason: 'end_turn',
    });
    expect(settledA.message).toEqual({
      id: 'assistant-1',
      content: 'The answer is 42.',
      isStreaming: false,
      timestamp: 1,
    });

    cleanupReact();
    published = [];
    const settledB = mountAndSettle({
      sessionId: 'session-1',
      promptId: 'prompt-B',
      outcome: 'completed',
      stopReason: 'end_turn',
    });
    expect(settledB.message).toEqual({
      id: 'assistant-3',
      content: 'next turn text',
      isStreaming: false,
      timestamp: 1,
    });
  });

  it('publishes only the fields the host contract declares', () => {
    harness.blocks = [];
    // Internal-only widening: a field added to the internal event (and to no
    // public type) must not reach hosts, at the top level or inside `error`.
    const internalEvent = {
      sessionId: 'session-1',
      promptId: 'prompt-live',
      outcome: 'failed',
      errorKind: 'loop_detected',
      error: {
        message: 'Loop detected',
        code: 'turn_error',
        loopType: 'tool_loop',
      },
    } as unknown as DaemonPromptSettledEvent;

    const settled = mountAndSettle(internalEvent);

    expect(Object.keys(settled).sort()).toEqual([
      'error',
      'outcome',
      'promptId',
      'sessionId',
    ]);
    expect(settled).not.toHaveProperty('errorKind');
    expect(settled.error).toEqual({
      message: 'Loop detected',
      code: 'turn_error',
    });
  });
});
