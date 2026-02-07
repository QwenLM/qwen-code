/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QwenSessionUpdateHandler } from './qwenSessionUpdateHandler.js';
import type { AcpSessionUpdate } from '../types/acpTypes.js';
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

  describe('current_model_update handling', () => {
    it('calls onModelChanged callback with model info', () => {
      const modelUpdate: AcpSessionUpdate = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'current_model_update',
          model: {
            modelId: 'qwen3-coder-plus',
            name: 'Qwen3 Coder Plus',
            description: 'A powerful coding model',
          },
        },
      } as AcpSessionUpdate;

      handler.handleSessionUpdate(modelUpdate);

      expect(mockCallbacks.onModelChanged).toHaveBeenCalledWith({
        modelId: 'qwen3-coder-plus',
        name: 'Qwen3 Coder Plus',
        description: 'A powerful coding model',
      });
    });

    it('handles model update with _meta field', () => {
      const modelUpdate: AcpSessionUpdate = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'current_model_update',
          model: {
            modelId: 'test-model',
            name: 'Test Model',
            _meta: { contextLimit: 128000 },
          },
        },
      } as AcpSessionUpdate;

      handler.handleSessionUpdate(modelUpdate);

      expect(mockCallbacks.onModelChanged).toHaveBeenCalledWith({
        modelId: 'test-model',
        name: 'Test Model',
        _meta: { contextLimit: 128000 },
      });
    });

    it('does not call callback when onModelChanged is not set', () => {
      const handlerWithoutCallback = new QwenSessionUpdateHandler({});

      const modelUpdate: AcpSessionUpdate = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'current_model_update',
          model: {
            modelId: 'qwen3-coder',
            name: 'Qwen3 Coder',
          },
        },
      } as AcpSessionUpdate;

      // Should not throw
      expect(() =>
        handlerWithoutCallback.handleSessionUpdate(modelUpdate),
      ).not.toThrow();
    });
  });

  describe('current_mode_update handling', () => {
    it('calls onModeChanged callback with mode id', () => {
      const modeUpdate: AcpSessionUpdate = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'current_mode_update',
          modeId: 'auto-edit' as ApprovalModeValue,
        },
      } as AcpSessionUpdate;

      handler.handleSessionUpdate(modeUpdate);

      expect(mockCallbacks.onModeChanged).toHaveBeenCalledWith('auto-edit');
    });
  });

  describe('agent_message_chunk handling', () => {
    it('calls onStreamChunk callback with text content', () => {
      const messageUpdate: AcpSessionUpdate = {
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
      const messageUpdate: AcpSessionUpdate = {
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
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        },
        durationMs: 1234,
      });
    });
  });

  describe('tool_call handling', () => {
    it('calls onToolCall callback with tool call data', () => {
      const toolCallUpdate: AcpSessionUpdate = {
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
      const planUpdate: AcpSessionUpdate = {
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

      const planUpdate: AcpSessionUpdate = {
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
      const commandsUpdate: AcpSessionUpdate = {
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
      } as AcpSessionUpdate;

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
      const commandsUpdate: AcpSessionUpdate = {
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
      } as AcpSessionUpdate;

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

      const commandsUpdate: AcpSessionUpdate = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'compress', description: 'Compress', input: null },
          ],
        },
      } as AcpSessionUpdate;

      // Should not throw
      expect(() =>
        handlerWithoutCallback.handleSessionUpdate(commandsUpdate),
      ).not.toThrow();
    });

    it('handles empty commands list', () => {
      const commandsUpdate: AcpSessionUpdate = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [],
        },
      } as AcpSessionUpdate;

      handler.handleSessionUpdate(commandsUpdate);

      expect(mockCallbacks.onAvailableCommands).toHaveBeenCalledWith([]);
    });
  });

  describe('updateCallbacks', () => {
    it('updates callbacks and uses new ones', () => {
      const newOnModelChanged = vi.fn();
      handler.updateCallbacks({
        ...mockCallbacks,
        onModelChanged: newOnModelChanged,
      });

      const modelUpdate: AcpSessionUpdate = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'current_model_update',
          model: {
            modelId: 'new-model',
            name: 'New Model',
          },
        },
      } as AcpSessionUpdate;

      handler.handleSessionUpdate(modelUpdate);

      expect(newOnModelChanged).toHaveBeenCalled();
      expect(mockCallbacks.onModelChanged).not.toHaveBeenCalled();
    });

    it('updates onAvailableCommands callback', () => {
      const newOnAvailableCommands = vi.fn();
      handler.updateCallbacks({
        ...mockCallbacks,
        onAvailableCommands: newOnAvailableCommands,
      });

      const commandsUpdate: AcpSessionUpdate = {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'test', description: 'Test command', input: null },
          ],
        },
      } as AcpSessionUpdate;

      handler.handleSessionUpdate(commandsUpdate);

      expect(newOnAvailableCommands).toHaveBeenCalled();
      expect(mockCallbacks.onAvailableCommands).not.toHaveBeenCalled();
    });
  });
});
