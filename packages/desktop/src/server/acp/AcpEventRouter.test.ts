/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { normalizeSessionUpdate } from './AcpEventRouter.js';

describe('normalizeSessionUpdate', () => {
  it('normalizes assistant text chunks and usage metadata', () => {
    const messages = normalizeSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
        _meta: {
          usage: {
            inputTokens: 11,
            outputTokens: 7,
            thoughtTokens: 2,
            totalTokens: 20,
          },
          durationMs: 1500,
        },
      },
    } as SessionNotification);

    expect(messages).toEqual([
      { type: 'message_delta', role: 'assistant', text: 'hello' },
      {
        type: 'usage',
        data: {
          usage: {
            inputTokens: 11,
            outputTokens: 7,
            thoughtTokens: 2,
            totalTokens: 20,
            cachedReadTokens: undefined,
            cachedWriteTokens: undefined,
            promptTokens: 11,
            completionTokens: 7,
            thoughtsTokens: 2,
            cachedTokens: undefined,
          },
          durationMs: 1500,
        },
      },
    ]);
  });

  it('normalizes thought chunks, tool calls, plans, modes, and commands', () => {
    expect(
      normalizeSessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'thinking' },
        },
      } as SessionNotification),
    ).toEqual([{ type: 'message_delta', role: 'thinking', text: 'thinking' }]);

    expect(
      normalizeSessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'Read file',
          kind: 'read',
          status: 'pending',
          rawInput: { path: 'README.md' },
          locations: [{ path: 'README.md', line: 1 }],
          _meta: { timestamp: 123 },
        },
      } as SessionNotification),
    ).toEqual([
      {
        type: 'tool_call',
        data: {
          toolCallId: 'tool-1',
          title: 'Read file',
          kind: 'read',
          status: 'pending',
          rawInput: { path: 'README.md' },
          rawOutput: undefined,
          content: undefined,
          locations: [{ path: 'README.md', line: 1 }],
          timestamp: 123,
        },
      },
    ]);

    expect(
      normalizeSessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'plan',
          entries: [
            { content: 'Implement', priority: 'high', status: 'in_progress' },
          ],
        },
      } as SessionNotification),
    ).toEqual([
      {
        type: 'plan',
        entries: [
          { content: 'Implement', priority: 'high', status: 'in_progress' },
        ],
      },
    ]);

    expect(
      normalizeSessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: 'auto-edit',
        },
      } as SessionNotification),
    ).toEqual([{ type: 'mode_changed', mode: 'auto-edit' }]);

    expect(
      normalizeSessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            {
              name: 'help',
              description: 'Show help',
              input: { hint: 'topic' },
            },
          ],
          _meta: { availableSkills: ['review'] },
        },
      } as SessionNotification),
    ).toEqual([
      {
        type: 'available_commands',
        commands: [
          {
            name: 'help',
            description: 'Show help',
            input: { hint: 'topic' },
          },
        ],
        skills: ['review'],
      },
    ]);
  });

  it('normalizes explicit usage updates', () => {
    const messages = normalizeSessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'usage_update',
        used: 4096,
        size: 128000,
      },
    } as SessionNotification);

    expect(messages).toEqual([
      {
        type: 'usage',
        data: {
          usage: { totalTokens: 4096 },
          tokenLimit: 128000,
          cost: undefined,
        },
      },
    ]);
  });
});
