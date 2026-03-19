/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QwenSessionUpdateHandler } from './qwenSessionUpdateHandler.js';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { ApprovalModeValue } from '../types/approvalModeValueTypes.js';
import type { QwenAgentCallbacks } from '../types/chatTypes.js';

describe('QwenSessionUpdateHandler', () => {
  let handler: QwenSessionUpdateHandler;
  let mockCallbacks: QwenAgentCallbacks;

  beforeEach(() => {
    mockCallbacks = {
      onStreamChunk: vi.fn(),
      onThoughtChunk: vi.fn(),
      onToolCall: vi.fn(),
      onPlan: vi.fn(),
      onModeChanged: vi.fn(),
      onModelChanged: vi.fn(),
      onUsageUpdate: vi.fn(),
      onAvailableCommands: vi.fn(),
    };
    handler = new QwenSessionUpdateHandler(mockCallbacks);
  });

  describe('current_mode_update handling', () => {
    it('calls onModeChanged callback with mode id', () => {
      const modeUpdate: SessionNotification = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: 'auto-edit' as ApprovalModeValue,
        },
      } as SessionNotification;

      handler.handleSessionUpdate(modeUpdate);

      expect(mockCallbacks.onModeChanged).toHaveBeenCalledWith('auto-edit');
    });
  });

  describe('agent_message_chunk handling', () => {
    it('calls onStreamChunk callback with text content', () => {
      const messageUpdate: SessionNotification = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Hello, world!',
          },
        },
      };

      handler.handleSessionUpdate(messageUpdate);

      expect(mockCallbacks.onStreamChunk).toHaveBeenCalledWith('Hello, world!');
    });

    it('emits usage metadata when present', () => {
      const messageUpdate: SessionNotification = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Response',
          },
          _meta: {
            usage: {
              promptTokens: 100,
              completionTokens: 50,
              totalTokens: 150,
            },
            durationMs: 1234,
          },
        },
      };

      handler.handleSessionUpdate(messageUpdate);

      expect(mockCallbacks.onUsageUpdate).toHaveBeenCalledWith({
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          thoughtTokens: undefined,
          totalTokens: 150,
          cachedReadTokens: undefined,
          cachedWriteTokens: undefined,
          promptTokens: 100,
          completionTokens: 50,
          thoughtsTokens: undefined,
          cachedTokens: undefined,
        },
        durationMs: 1234,
      });
    });

    it('maps SDK usage field names to both SDK and legacy fields', () => {
      const messageUpdate: SessionNotification = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Response',
          },
          _meta: {
            usage: {
              inputTokens: 200,
              outputTokens: 80,
              thoughtTokens: 30,
              totalTokens: 310,
              cachedReadTokens: 10,
            } as never,
            durationMs: 500,
          },
        },
      };

      handler.handleSessionUpdate(messageUpdate);

      expect(mockCallbacks.onUsageUpdate).toHaveBeenCalledWith({
        usage: {
          inputTokens: 200,
          outputTokens: 80,
          thoughtTokens: 30,
          totalTokens: 310,
          cachedReadTokens: 10,
          cachedWriteTokens: undefined,
          promptTokens: 200,
          completionTokens: 80,
          thoughtsTokens: 30,
          cachedTokens: 10,
        },
        durationMs: 500,
      });
    });
  });

  describe('tool_call handling', () => {
    it('calls onToolCall callback with tool call data', () => {
      const toolCallUpdate: SessionNotification = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-123',
          kind: 'read',
          title: 'Read file',
          status: 'pending',
          rawInput: { path: '/test/file.ts' },
        },
      };

      handler.handleSessionUpdate(toolCallUpdate);

      expect(mockCallbacks.onToolCall).toHaveBeenCalledWith({
        toolCallId: 'call-123',
        kind: 'read',
        title: 'Read file',
        status: 'pending',
        rawInput: { path: '/test/file.ts' },
        content: undefined,
        locations: undefined,
      });
    });
  });

  describe('plan handling', () => {
    it('calls onPlan callback with plan entries', () => {
      const planUpdate: SessionNotification = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'plan',
          entries: [
            { content: 'Step 1', priority: 'high', status: 'pending' },
            { content: 'Step 2', priority: 'medium', status: 'pending' },
          ],
        },
      };

      handler.handleSessionUpdate(planUpdate);

      expect(mockCallbacks.onPlan).toHaveBeenCalledWith([
        { content: 'Step 1', priority: 'high', status: 'pending' },
        { content: 'Step 2', priority: 'medium', status: 'pending' },
      ]);
    });

    it('falls back to stream chunk when onPlan is not set', () => {
      const handlerWithStream = new QwenSessionUpdateHandler({
        onStreamChunk: vi.fn(),
      });

      const planUpdate: SessionNotification = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'plan',
          entries: [{ content: 'Task 1', priority: 'high', status: 'pending' }],
        },
      };

      handlerWithStream.handleSessionUpdate(planUpdate);

      expect(handlerWithStream['callbacks'].onStreamChunk).toHaveBeenCalled();
    });
  });

  describe('available_commands_update handling', () => {
    it('calls onAvailableCommands callback with commands', () => {
      const commandsUpdate: SessionNotification = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            {
              name: 'compress',
              description: 'Compress the context',
              input: null,
            },
            {
              name: 'init',
              description: 'Initialize the project',
              input: null,
            },
            {
              name: 'summary',
              description: 'Generate project summary',
              input: null,
            },
          ],
        },
      } as SessionNotification;

      handler.handleSessionUpdate(commandsUpdate);

      expect(mockCallbacks.onAvailableCommands).toHaveBeenCalledWith([
        { name: 'compress', description: 'Compress the context', input: null },
        { name: 'init', description: 'Initialize the project', input: null },
        {
          name: 'summary',
          description: 'Generate project summary',
          input: null,
        },
      ]);
    });

    it('handles commands with input hint', () => {
      const commandsUpdate: SessionNotification = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            {
              name: 'search',
              description: 'Search for files',
              input: { hint: 'Enter search query' },
            },
          ],
        },
      } as SessionNotification;

      handler.handleSessionUpdate(commandsUpdate);

      expect(mockCallbacks.onAvailableCommands).toHaveBeenCalledWith([
        {
          name: 'search',
          description: 'Search for files',
          input: { hint: 'Enter search query' },
        },
      ]);
    });

    it('does not call callback when onAvailableCommands is not set', () => {
      const handlerWithoutCallback = new QwenSessionUpdateHandler({});

      const commandsUpdate: SessionNotification = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'compress', description: 'Compress', input: null },
          ],
        },
      } as SessionNotification;

      // Should not throw
      expect(() =>
        handlerWithoutCallback.handleSessionUpdate(commandsUpdate),
      ).not.toThrow();
    });

    it('handles empty commands list', () => {
      const commandsUpdate: SessionNotification = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [],
        },
      } as SessionNotification;

      handler.handleSessionUpdate(commandsUpdate);

      expect(mockCallbacks.onAvailableCommands).toHaveBeenCalledWith([]);
    });
  });

  describe('updateCallbacks', () => {
    it('updates mode callback and uses new one', () => {
      const newOnModeChanged = vi.fn();
      handler.updateCallbacks({
        ...mockCallbacks,
        onModeChanged: newOnModeChanged,
      });

      const modeUpdate: SessionNotification = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: 'yolo' as ApprovalModeValue,
        },
      } as SessionNotification;

      handler.handleSessionUpdate(modeUpdate);

      expect(newOnModeChanged).toHaveBeenCalled();
      expect(mockCallbacks.onModeChanged).not.toHaveBeenCalled();
    });

    it('updates onAvailableCommands callback', () => {
      const newOnAvailableCommands = vi.fn();
      handler.updateCallbacks({
        ...mockCallbacks,
        onAvailableCommands: newOnAvailableCommands,
      });

      const commandsUpdate: SessionNotification = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'test', description: 'Test command', input: null },
          ],
        },
      } as SessionNotification;

      handler.handleSessionUpdate(commandsUpdate);

      expect(newOnAvailableCommands).toHaveBeenCalled();
      expect(mockCallbacks.onAvailableCommands).not.toHaveBeenCalled();
    });
  });
});
