/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  Config,
  ServerGeminiStreamEvent,
} from '@qwen-code/qwen-code-core';
import { GeminiEventType } from '@qwen-code/qwen-code-core';
import type { Part } from '@google/genai';
import { JsonOutputAdapter } from './JsonOutputAdapter.js';

function createMockConfig(): Config {
  return {
    getSessionId: vi.fn().mockReturnValue('test-session-id'),
    getModel: vi.fn().mockReturnValue('test-model'),
  } as unknown as Config;
}

describe('JsonOutputAdapter', () => {
  let adapter: JsonOutputAdapter;
  let mockConfig: Config;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutWriteSpy: any;

  beforeEach(() => {
    mockConfig = createMockConfig();
    adapter = new JsonOutputAdapter(mockConfig);
    stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
  });

  describe('startAssistantMessage', () => {
    it('should reset state for new message', () => {
      adapter.startAssistantMessage();
      adapter.startAssistantMessage(); // Start second message
      // Should not throw
      expect(() => adapter.finalizeAssistantMessage()).not.toThrow();
    });
  });

  describe('processEvent', () => {
    beforeEach(() => {
      adapter.startAssistantMessage();
    });

    it('should append text content from Content events', () => {
      const event: ServerGeminiStreamEvent = {
        type: GeminiEventType.Content,
        value: 'Hello',
      };
      adapter.processEvent(event);

      const event2: ServerGeminiStreamEvent = {
        type: GeminiEventType.Content,
        value: ' World',
      };
      adapter.processEvent(event2);

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.content).toHaveLength(1);
      expect(message.message.content[0]).toMatchObject({
        type: 'text',
        text: 'Hello World',
      });
    });

    it('should append citation content from Citation events', () => {
      const event: ServerGeminiStreamEvent = {
        type: GeminiEventType.Citation,
        value: 'Citation text',
      };
      adapter.processEvent(event);

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('Citation text'),
      });
    });

    it('should ignore non-string citation values', () => {
      const event: ServerGeminiStreamEvent = {
        type: GeminiEventType.Citation,
        value: 123,
      } as unknown as ServerGeminiStreamEvent;
      adapter.processEvent(event);

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.content).toHaveLength(0);
    });

    it('should append thinking from Thought events', () => {
      const event: ServerGeminiStreamEvent = {
        type: GeminiEventType.Thought,
        value: {
          subject: 'Planning',
          description: 'Thinking about the task',
        },
      };
      adapter.processEvent(event);

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.content).toHaveLength(1);
      expect(message.message.content[0]).toMatchObject({
        type: 'thinking',
        thinking: 'Planning: Thinking about the task',
        signature: 'Planning',
      });
    });

    it('should handle thinking with only subject', () => {
      const event: ServerGeminiStreamEvent = {
        type: GeminiEventType.Thought,
        value: {
          subject: 'Planning',
          description: '',
        },
      };
      adapter.processEvent(event);

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.content[0]).toMatchObject({
        type: 'thinking',
        signature: 'Planning',
      });
    });

    it('should append tool use from ToolCallRequest events', () => {
      const event: ServerGeminiStreamEvent = {
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-call-1',
          name: 'test_tool',
          args: { param1: 'value1' },
          isClientInitiated: false,
          prompt_id: 'prompt-1',
        },
      };
      adapter.processEvent(event);

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.content).toHaveLength(1);
      expect(message.message.content[0]).toMatchObject({
        type: 'tool_use',
        id: 'tool-call-1',
        name: 'test_tool',
        input: { param1: 'value1' },
      });
    });

    it('should set stop_reason to tool_use when message contains only tool_use blocks', () => {
      adapter.processEvent({
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-call-1',
          name: 'test_tool',
          args: { param1: 'value1' },
          isClientInitiated: false,
          prompt_id: 'prompt-1',
        },
      });

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.stop_reason).toBe('tool_use');
    });

    it('should set stop_reason to null when message contains text blocks', () => {
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Some text',
      });

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.stop_reason).toBeNull();
    });

    it('should set stop_reason to null when message contains thinking blocks', () => {
      adapter.processEvent({
        type: GeminiEventType.Thought,
        value: {
          subject: 'Planning',
          description: 'Thinking about the task',
        },
      });

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.stop_reason).toBeNull();
    });

    it('should set stop_reason to tool_use when message contains multiple tool_use blocks', () => {
      adapter.processEvent({
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-call-1',
          name: 'test_tool_1',
          args: { param1: 'value1' },
          isClientInitiated: false,
          prompt_id: 'prompt-1',
        },
      });
      adapter.processEvent({
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-call-2',
          name: 'test_tool_2',
          args: { param2: 'value2' },
          isClientInitiated: false,
          prompt_id: 'prompt-1',
        },
      });

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.content).toHaveLength(2);
      expect(
        message.message.content.every((block) => block.type === 'tool_use'),
      ).toBe(true);
      expect(message.message.stop_reason).toBe('tool_use');
    });

    it('should update usage from Finished event', () => {
      const usageMetadata = {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        cachedContentTokenCount: 10,
        totalTokenCount: 160,
      };
      const event: ServerGeminiStreamEvent = {
        type: GeminiEventType.Finished,
        value: {
          reason: undefined,
          usageMetadata,
        },
      };
      adapter.processEvent(event);

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.usage).toMatchObject({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        total_tokens: 160,
      });
    });

    it('should finalize pending blocks on Finished event', () => {
      // Add some text first
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Some text',
      });

      const event: ServerGeminiStreamEvent = {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: undefined },
      };
      adapter.processEvent(event);

      // Should not throw when finalizing
      expect(() => adapter.finalizeAssistantMessage()).not.toThrow();
    });

    it('should ignore events after finalization', () => {
      adapter.finalizeAssistantMessage();
      const originalContent =
        adapter.finalizeAssistantMessage().message.content;

      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Should be ignored',
      });

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.content).toEqual(originalContent);
    });
  });

  describe('finalizeAssistantMessage', () => {
    beforeEach(() => {
      adapter.startAssistantMessage();
    });

    it('should build and emit a complete assistant message', () => {
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Test response',
      });

      const message = adapter.finalizeAssistantMessage();

      expect(message.type).toBe('assistant');
      expect(message.uuid).toBeTruthy();
      expect(message.session_id).toBe('test-session-id');
      expect(message.parent_tool_use_id).toBeNull();
      expect(message.message.role).toBe('assistant');
      expect(message.message.model).toBe('test-model');
      expect(message.message.content).toHaveLength(1);
    });

    it('should return same message on subsequent calls', () => {
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Test',
      });

      const message1 = adapter.finalizeAssistantMessage();
      const message2 = adapter.finalizeAssistantMessage();

      expect(message1).toEqual(message2);
    });

    it('should split different block types into separate assistant messages', () => {
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Text',
      });
      adapter.processEvent({
        type: GeminiEventType.Thought,
        value: { subject: 'Thinking', description: 'Thought' },
      });

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.content).toHaveLength(1);
      expect(message.message.content[0].type).toBe('thinking');

      const storedMessages = (adapter as unknown as { messages: unknown[] })
        .messages;
      const assistantMessages = storedMessages.filter(
        (
          msg,
        ): msg is {
          type: string;
          message: { content: Array<{ type: string }> };
        } => {
          if (
            typeof msg !== 'object' ||
            msg === null ||
            !('type' in msg) ||
            (msg as { type?: string }).type !== 'assistant' ||
            !('message' in msg)
          ) {
            return false;
          }
          const message = (msg as { message?: unknown }).message;
          return (
            typeof message === 'object' &&
            message !== null &&
            'content' in message &&
            Array.isArray((message as { content?: unknown }).content)
          );
        },
      );

      expect(assistantMessages).toHaveLength(2);
      for (const assistant of assistantMessages) {
        const uniqueTypes = new Set(
          assistant.message.content.map((block) => block.type),
        );
        expect(uniqueTypes.size).toBeLessThanOrEqual(1);
      }
    });

    it('should throw if message not started', () => {
      adapter = new JsonOutputAdapter(mockConfig);
      expect(() => adapter.finalizeAssistantMessage()).toThrow(
        'Message not started',
      );
    });
  });

  describe('emitResult', () => {
    beforeEach(() => {
      adapter.startAssistantMessage();
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Response text',
      });
      adapter.finalizeAssistantMessage();
    });

    it('should emit success result as JSON array', () => {
      adapter.emitResult({
        isError: false,
        durationMs: 1000,
        apiDurationMs: 800,
        numTurns: 1,
      });

      expect(stdoutWriteSpy).toHaveBeenCalled();
      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(Array.isArray(parsed)).toBe(true);
      const resultMessage = parsed.find(
        (msg: unknown) =>
          typeof msg === 'object' &&
          msg !== null &&
          'type' in msg &&
          msg.type === 'result',
      );

      expect(resultMessage).toBeDefined();
      expect(resultMessage.is_error).toBe(false);
      expect(resultMessage.subtype).toBe('success');
      expect(resultMessage.result).toBe('Response text');
      expect(resultMessage.duration_ms).toBe(1000);
      expect(resultMessage.num_turns).toBe(1);
    });

    it('should emit error result', () => {
      adapter.emitResult({
        isError: true,
        errorMessage: 'Test error',
        durationMs: 500,
        apiDurationMs: 300,
        numTurns: 1,
      });

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      const resultMessage = parsed.find(
        (msg: unknown) =>
          typeof msg === 'object' &&
          msg !== null &&
          'type' in msg &&
          msg.type === 'result',
      );

      expect(resultMessage.is_error).toBe(true);
      expect(resultMessage.subtype).toBe('error_during_execution');
      expect(resultMessage.error?.message).toBe('Test error');
    });

    it('should use provided summary over extracted text', () => {
      adapter.emitResult({
        isError: false,
        summary: 'Custom summary',
        durationMs: 1000,
        apiDurationMs: 800,
        numTurns: 1,
      });

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      const resultMessage = parsed.find(
        (msg: unknown) =>
          typeof msg === 'object' &&
          msg !== null &&
          'type' in msg &&
          msg.type === 'result',
      );

      expect(resultMessage.result).toBe('Custom summary');
    });

    it('should include usage information', () => {
      const usage = {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
      };

      adapter.emitResult({
        isError: false,
        usage,
        durationMs: 1000,
        apiDurationMs: 800,
        numTurns: 1,
      });

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      const resultMessage = parsed.find(
        (msg: unknown) =>
          typeof msg === 'object' &&
          msg !== null &&
          'type' in msg &&
          msg.type === 'result',
      );

      expect(resultMessage.usage).toEqual(usage);
    });

    it('should include stats when provided', () => {
      const stats = {
        models: {},
        tools: {
          totalCalls: 5,
          totalSuccess: 4,
          totalFail: 1,
          totalDurationMs: 1000,
          totalDecisions: {
            accept: 3,
            reject: 1,
            modify: 0,
            auto_accept: 1,
          },
          byName: {},
        },
        files: {
          totalLinesAdded: 10,
          totalLinesRemoved: 5,
        },
      };

      adapter.emitResult({
        isError: false,
        stats,
        durationMs: 1000,
        apiDurationMs: 800,
        numTurns: 1,
      });

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      const resultMessage = parsed.find(
        (msg: unknown) =>
          typeof msg === 'object' &&
          msg !== null &&
          'type' in msg &&
          msg.type === 'result',
      );

      expect(resultMessage.stats).toEqual(stats);
    });
  });

  describe('emitUserMessage', () => {
    it('should add user message to collection', () => {
      const parts: Part[] = [{ text: 'Hello user' }];
      adapter.emitUserMessage(parts);

      adapter.emitResult({
        isError: false,
        durationMs: 1000,
        apiDurationMs: 800,
        numTurns: 1,
      });

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      const userMessage = parsed.find(
        (msg: unknown) =>
          typeof msg === 'object' &&
          msg !== null &&
          'type' in msg &&
          msg.type === 'user',
      );

      expect(userMessage).toBeDefined();
      expect(Array.isArray(userMessage.message.content)).toBe(true);
      if (Array.isArray(userMessage.message.content)) {
        expect(userMessage.message.content).toHaveLength(1);
        expect(userMessage.message.content[0]).toEqual({
          type: 'text',
          text: 'Hello user',
        });
      }
    });

    it('should handle parent_tool_use_id', () => {
      const parts: Part[] = [{ text: 'Tool response' }];
      adapter.emitUserMessage(parts);

      adapter.emitResult({
        isError: false,
        durationMs: 1000,
        apiDurationMs: 800,
        numTurns: 1,
      });

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      const userMessage = parsed.find(
        (msg: unknown) =>
          typeof msg === 'object' &&
          msg !== null &&
          'type' in msg &&
          msg.type === 'user',
      );

      // emitUserMessage currently sets parent_tool_use_id to null
      expect(userMessage.parent_tool_use_id).toBeNull();
    });
  });

  describe('emitToolResult', () => {
    it('should emit tool result message', () => {
      const request = {
        callId: 'tool-1',
        name: 'test_tool',
        args: {},
        isClientInitiated: false,
        prompt_id: 'prompt-1',
      };
      const response = {
        callId: 'tool-1',
        responseParts: [],
        resultDisplay: 'Tool executed successfully',
        error: undefined,
        errorType: undefined,
      };

      adapter.emitToolResult(request, response);

      adapter.emitResult({
        isError: false,
        durationMs: 1000,
        apiDurationMs: 800,
        numTurns: 1,
      });

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      const toolResult = parsed.find(
        (
          msg: unknown,
        ): msg is { type: 'user'; message: { content: unknown[] } } =>
          typeof msg === 'object' &&
          msg !== null &&
          'type' in msg &&
          msg.type === 'user' &&
          'message' in msg &&
          typeof msg.message === 'object' &&
          msg.message !== null &&
          'content' in msg.message &&
          Array.isArray(msg.message.content) &&
          msg.message.content[0] &&
          typeof msg.message.content[0] === 'object' &&
          'type' in msg.message.content[0] &&
          msg.message.content[0].type === 'tool_result',
      );

      expect(toolResult).toBeDefined();
      const block = toolResult.message.content[0] as {
        type: 'tool_result';
        tool_use_id: string;
        content?: string;
        is_error?: boolean;
      };
      expect(block).toMatchObject({
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: 'Tool executed successfully',
        is_error: false,
      });
    });

    it('should mark error tool results', () => {
      const request = {
        callId: 'tool-1',
        name: 'test_tool',
        args: {},
        isClientInitiated: false,
        prompt_id: 'prompt-1',
      };
      const response = {
        callId: 'tool-1',
        responseParts: [],
        resultDisplay: undefined,
        error: new Error('Tool failed'),
        errorType: undefined,
      };

      adapter.emitToolResult(request, response);

      adapter.emitResult({
        isError: false,
        durationMs: 1000,
        apiDurationMs: 800,
        numTurns: 1,
      });

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      const toolResult = parsed.find(
        (
          msg: unknown,
        ): msg is { type: 'user'; message: { content: unknown[] } } =>
          typeof msg === 'object' &&
          msg !== null &&
          'type' in msg &&
          msg.type === 'user' &&
          'message' in msg &&
          typeof msg.message === 'object' &&
          msg.message !== null &&
          'content' in msg.message &&
          Array.isArray(msg.message.content),
      );

      const block = toolResult.message.content[0] as {
        is_error?: boolean;
      };
      expect(block.is_error).toBe(true);
    });
  });

  describe('emitSystemMessage', () => {
    it('should add system message to collection', () => {
      adapter.emitSystemMessage('test_subtype', { data: 'value' });

      adapter.emitResult({
        isError: false,
        durationMs: 1000,
        apiDurationMs: 800,
        numTurns: 1,
      });

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      const systemMessage = parsed.find(
        (msg: unknown) =>
          typeof msg === 'object' &&
          msg !== null &&
          'type' in msg &&
          msg.type === 'system',
      );

      expect(systemMessage).toBeDefined();
      expect(systemMessage.subtype).toBe('test_subtype');
      expect(systemMessage.data).toEqual({ data: 'value' });
    });
  });

  describe('getSessionId and getModel', () => {
    it('should return session ID from config', () => {
      expect(adapter.getSessionId()).toBe('test-session-id');
      expect(mockConfig.getSessionId).toHaveBeenCalled();
    });

    it('should return model from config', () => {
      expect(adapter.getModel()).toBe('test-model');
      expect(mockConfig.getModel).toHaveBeenCalled();
    });
  });

  describe('multiple messages in collection', () => {
    it('should collect all messages and emit as array', () => {
      adapter.emitSystemMessage('init', {});
      adapter.emitUserMessage([{ text: 'User input' }]);
      adapter.startAssistantMessage();
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Assistant response',
      });
      adapter.finalizeAssistantMessage();
      adapter.emitResult({
        isError: false,
        durationMs: 1000,
        apiDurationMs: 800,
        numTurns: 1,
      });

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThanOrEqual(3);
      const systemMsg = parsed[0] as { type?: string };
      const userMsg = parsed[1] as { type?: string };
      expect(systemMsg.type).toBe('system');
      expect(userMsg.type).toBe('user');
      expect(
        parsed.find(
          (msg: unknown) =>
            typeof msg === 'object' &&
            msg !== null &&
            'type' in msg &&
            (msg as { type?: string }).type === 'assistant',
        ),
      ).toBeDefined();
      expect(
        parsed.find(
          (msg: unknown) =>
            typeof msg === 'object' &&
            msg !== null &&
            'type' in msg &&
            (msg as { type?: string }).type === 'result',
        ),
      ).toBeDefined();
    });
  });
});
