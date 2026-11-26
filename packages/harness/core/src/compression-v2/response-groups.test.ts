/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  canPreserveResponseGroup,
  splitForCompaction,
} from './response-groups.js';
import { makeAssistant, makeUser } from './test-helpers.js';
import type { AssistantMessage, Message } from './message-types.js';

function assistant(group: string, call: string): AssistantMessage {
  return {
    ...makeAssistant([{ type: 'tool_use', id: call, name: 'Read', input: {} }]),
    responseGroupId: group,
  };
}

function tenMessages(): Message[] {
  return [
    makeUser('M1'),
    assistant('r1', 't1'),
    makeUser([{ type: 'tool_result', tool_use_id: 't1', content: 'M3' }]),
    assistant('r2', 't2'),
    makeUser([{ type: 'tool_result', tool_use_id: 't2', content: 'M5' }]),
    assistant('r3', 't3'),
    makeUser([{ type: 'tool_result', tool_use_id: 't3', content: 'M7' }]),
    makeUser('M8'),
    assistant('r4', 't4'),
    makeUser([{ type: 'tool_result', tool_use_id: 't4', content: 'M10' }]),
  ];
}

describe('splitForCompaction', () => {
  it('summarizes M1-M8 and keeps the complete M9-M10 response group', () => {
    const messages = tenMessages();
    expect(splitForCompaction(messages)).toEqual({
      summaryHistory: messages.slice(0, 8),
      preservedMessages: messages.slice(8),
    });
  });

  it('cuts the M7 background snapshot at M5, not at the last user role', () => {
    const messages = tenMessages().slice(0, 7);
    expect(splitForCompaction(messages)).toEqual({
      summaryHistory: messages.slice(0, 5),
      preservedMessages: messages.slice(5),
    });
  });

  it('keeps every block of a response even with empty or repeated provider IDs', () => {
    const messages = tenMessages();
    const latest = messages[8] as AssistantMessage;
    const text = {
      ...makeAssistant([{ type: 'text', text: 'M9 text' }]),
      responseGroupId: latest.responseGroupId,
    };
    for (const message of messages) {
      if (message.type === 'assistant') message.message.id = '';
    }
    messages.splice(8, 0, text);
    const result = splitForCompaction(messages);
    expect(result.summaryHistory).toEqual(messages.slice(0, 8));
    expect(result.preservedMessages).toEqual(messages.slice(8));
    expect(text.uuid).not.toBe(latest.uuid);
  });

  it('preserves a latest plain-text response and all following user input', () => {
    const messages = tenMessages();
    const reply = {
      ...makeAssistant([{ type: 'text', text: 'done' }]),
      responseGroupId: 'r5',
    };
    const user = makeUser('follow-up');
    messages.push(reply, user);
    expect(splitForCompaction(messages).preservedMessages).toEqual([
      reply,
      user,
    ]);
  });

  it('uses request and provider IDs for legacy rows', () => {
    const first = makeAssistant([{ type: 'text', text: 'first' }]);
    first.requestId = 'local-old-1';
    const last = makeAssistant([{ type: 'text', text: 'last' }]);
    last.requestId = 'local-old-2';
    expect(splitForCompaction([first, last]).preservedMessages).toEqual([last]);
    delete first.requestId;
    delete last.requestId;
    expect(splitForCompaction([first, last]).preservedMessages).toEqual([last]);
  });

  it('does not create a response boundary for virtual or API-error rows', () => {
    const messages = tenMessages();
    const virtual = {
      ...makeAssistant([{ type: 'text', text: 'display' }]),
      isVirtual: true,
    };
    const error = {
      ...makeAssistant([{ type: 'text', text: 'error' }]),
      isApiErrorMessage: true,
    };
    messages.push(virtual, error);
    expect(splitForCompaction(messages).preservedMessages).toEqual(
      messages.slice(8),
    );
  });

  it('keeps all messages when only the latest response exists', () => {
    const messages = tenMessages().slice(0, 3);
    expect(splitForCompaction(messages)).toEqual({
      summaryHistory: [],
      preservedMessages: messages,
    });
  });

  it('does not guess a boundary for legacy assistant records without any response identity', () => {
    const messages = tenMessages();
    const old = messages[1] as AssistantMessage;
    delete old.responseGroupId;
    old.message.id = '';
    expect(splitForCompaction(messages)).toEqual({
      summaryHistory: [],
      preservedMessages: messages,
    });
  });
});

describe('canPreserveResponseGroup', () => {
  it('keeps a complete call/result pair even after its result was budgeted', () => {
    const group = tenMessages().slice(8);
    expect(canPreserveResponseGroup(group, new Set(['t4']))).toBe(true);
  });

  it('rejects an old call without its result, including a partly stale multi-call group', () => {
    const call = assistant('r4', 'old');
    const fresh = assistant('r4', 'new');
    expect(canPreserveResponseGroup([call], new Set(['old']))).toBe(false);
    expect(canPreserveResponseGroup([call, fresh], new Set(['old']))).toBe(
      false,
    );
    expect(canPreserveResponseGroup([fresh], new Set(['old']))).toBe(true);
  });
});
