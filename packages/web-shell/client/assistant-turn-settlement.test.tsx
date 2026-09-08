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
