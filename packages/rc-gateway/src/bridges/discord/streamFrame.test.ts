/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { extractAgentText } from './streamFrame.js';

describe('extractAgentText', () => {
  it('pulls text from an agent_message_chunk (nested under update)', () => {
    expect(
      extractAgentText({
        sessionId: 's',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      }),
    ).toBe('hello');
  });

  it('accepts the update object directly (no wrapper)', () => {
    expect(
      extractAgentText({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
      }),
    ).toBe('hi');
  });

  it('skips thought chunks and tool calls (deliberate scope)', () => {
    expect(
      extractAgentText({
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { text: 'thinking' },
        },
      }),
    ).toBe('');
    expect(
      extractAgentText({ update: { sessionUpdate: 'tool_call', title: 'x' } }),
    ).toBe('');
  });

  it('returns "" for malformed / empty frames', () => {
    expect(extractAgentText(undefined)).toBe('');
    expect(extractAgentText({})).toBe('');
    expect(
      extractAgentText({ update: { sessionUpdate: 'agent_message_chunk' } }),
    ).toBe('');
    expect(
      extractAgentText({
        update: { sessionUpdate: 'agent_message_chunk', content: { text: 5 } },
      }),
    ).toBe('');
  });
});
