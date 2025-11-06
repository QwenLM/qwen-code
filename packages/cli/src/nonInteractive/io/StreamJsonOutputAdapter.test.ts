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
import { StreamJsonOutputAdapter } from './StreamJsonOutputAdapter.js';

function createMockConfig(): Config {
  return {
    getSessionId: vi.fn().mockReturnValue('test-session-id'),
    getModel: vi.fn().mockReturnValue('test-model'),
  } as unknown as Config;
}

describe('StreamJsonOutputAdapter', () => {
  let adapter: StreamJsonOutputAdapter;
  let mockConfig: Config;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutWriteSpy: any;

  beforeEach(() => {
    mockConfig = createMockConfig();
    stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
  });

  describe('with partial messages enabled', () => {
    beforeEach(() => {
      adapter = new StreamJsonOutputAdapter(mockConfig, true);
    });

    describe('startAssistantMessage', () => {
      it('should reset state for new message', () => {
        adapter.startAssistantMessage();
        adapter.processEvent({
          type: GeminiEventType.Content,
          value: 'First',
        });
        adapter.finalizeAssistantMessage();

        adapter.startAssistantMessage();
        adapter.processEvent({
          type: GeminiEventType.Content,
          value: 'Second',
        });

        const message = adapter.finalizeAssistantMessage();
        expect(message.message.content[0]).toMatchObject({
          type: 'text',
          text: 'Second',
        });
      });
    });

    describe('processEvent with stream events', () => {
      beforeEach(() => {
        adapter.startAssistantMessage();
      });

      it('should emit stream events for text deltas', () => {
        adapter.processEvent({
          type: GeminiEventType.Content,
          value: 'Hello',
        });

        const calls = stdoutWriteSpy.mock.calls;
        expect(calls.length).toBeGreaterThan(0);

        const deltaEventCall = calls.find((call: unknown[]) => {
          try {
            const parsed = JSON.parse(call[0] as string);
            return (
              parsed.type === 'stream_event' &&
              parsed.event.type === 'content_block_delta'
            );
          } catch {
            return false;
          }
        });

        expect(deltaEventCall).toBeDefined();
        const parsed = JSON.parse(deltaEventCall![0] as string);
        expect(parsed.event.type).toBe('content_block_delta');
        expect(parsed.event.delta).toMatchObject({
          type: 'text_delta',
          text: 'Hello',
        });
      });

      it('should emit message_start event on first content', () => {
        adapter.processEvent({
          type: GeminiEventType.Content,
          value: 'First',
        });

        const calls = stdoutWriteSpy.mock.calls;
        const messageStartCall = calls.find((call: unknown[]) => {
          try {
            const parsed = JSON.parse(call[0] as string);
            return (
              parsed.type === 'stream_event' &&
              parsed.event.type === 'message_start'
            );
          } catch {
            return false;
          }
        });

        expect(messageStartCall).toBeDefined();
      });

      it('should emit content_block_start for new blocks', () => {
        adapter.processEvent({
          type: GeminiEventType.Content,
          value: 'Text',
        });

        const calls = stdoutWriteSpy.mock.calls;
        const blockStartCall = calls.find((call: unknown[]) => {
          try {
            const parsed = JSON.parse(call[0] as string);
            return (
              parsed.type === 'stream_event' &&
              parsed.event.type === 'content_block_start'
            );
          } catch {
            return false;
          }
        });

        expect(blockStartCall).toBeDefined();
      });

      it('should emit thinking delta events', () => {
        adapter.processEvent({
          type: GeminiEventType.Thought,
          value: {
            subject: 'Planning',
            description: 'Thinking',
          },
        });

        const calls = stdoutWriteSpy.mock.calls;
        const deltaCall = calls.find((call: unknown[]) => {
          try {
            const parsed = JSON.parse(call[0] as string);
            return (
              parsed.type === 'stream_event' &&
              parsed.event.type === 'content_block_delta' &&
              parsed.event.delta.type === 'thinking_delta'
            );
          } catch {
            return false;
          }
        });

        expect(deltaCall).toBeDefined();
      });

      it('should emit message_stop on finalization', () => {
        adapter.processEvent({
          type: GeminiEventType.Content,
          value: 'Text',
        });
        adapter.finalizeAssistantMessage();

        const calls = stdoutWriteSpy.mock.calls;
        const messageStopCall = calls.find((call: unknown[]) => {
          try {
            const parsed = JSON.parse(call[0] as string);
            return (
              parsed.type === 'stream_event' &&
              parsed.event.type === 'message_stop'
            );
          } catch {
            return false;
          }
        });

        expect(messageStopCall).toBeDefined();
      });
    });
  });

  describe('with partial messages disabled', () => {
    beforeEach(() => {
      adapter = new StreamJsonOutputAdapter(mockConfig, false);
    });

    it('should not emit stream events', () => {
      adapter.startAssistantMessage();
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Text',
      });

      const calls = stdoutWriteSpy.mock.calls;
      const streamEventCall = calls.find((call: unknown[]) => {
        try {
          const parsed = JSON.parse(call[0] as string);
          return parsed.type === 'stream_event';
        } catch {
          return false;
        }
      });

      expect(streamEventCall).toBeUndefined();
    });

    it('should still emit final assistant message', () => {
      adapter.startAssistantMessage();
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Text',
      });
      adapter.finalizeAssistantMessage();

      const calls = stdoutWriteSpy.mock.calls;
      const assistantCall = calls.find((call: unknown[]) => {
        try {
          const parsed = JSON.parse(call[0] as string);
          return parsed.type === 'assistant';
        } catch {
          return false;
        }
      });

      expect(assistantCall).toBeDefined();
    });
  });

  describe('processEvent', () => {
    beforeEach(() => {
      adapter = new StreamJsonOutputAdapter(mockConfig, false);
      adapter.startAssistantMessage();
    });

    it('should append text content from Content events', () => {
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Hello',
      });
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: ' World',
      });

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.content).toHaveLength(1);
      expect(message.message.content[0]).toMatchObject({
        type: 'text',
        text: 'Hello World',
      });
    });

    it('should append citation content from Citation events', () => {
      adapter.processEvent({
        type: GeminiEventType.Citation,
        value: 'Citation text',
      });

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('Citation text'),
      });
    });

    it('should ignore non-string citation values', () => {
      adapter.processEvent({
        type: GeminiEventType.Citation,
        value: 123,
      } as unknown as ServerGeminiStreamEvent);

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.content).toHaveLength(0);
    });

    it('should append thinking from Thought events', () => {
      adapter.processEvent({
        type: GeminiEventType.Thought,
        value: {
          subject: 'Planning',
          description: 'Thinking about the task',
        },
      });

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.content).toHaveLength(1);
      expect(message.message.content[0]).toMatchObject({
        type: 'thinking',
        thinking: 'Planning: Thinking about the task',
        signature: 'Planning',
      });
    });

    it('should handle thinking with only subject', () => {
      adapter.processEvent({
        type: GeminiEventType.Thought,
        value: {
          subject: 'Planning',
          description: '',
        },
      });

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.content[0]).toMatchObject({
        type: 'thinking',
        signature: 'Planning',
      });
    });

    it('should append tool use from ToolCallRequest events', () => {
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
      adapter.processEvent({
        type: GeminiEventType.Finished,
        value: {
          reason: undefined,
          usageMetadata,
        },
      });

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.usage).toMatchObject({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        total_tokens: 160,
      });
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
      adapter = new StreamJsonOutputAdapter(mockConfig, false);
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

    it('should emit message to stdout immediately', () => {
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Test',
      });

      stdoutWriteSpy.mockClear();
      adapter.finalizeAssistantMessage();

      expect(stdoutWriteSpy).toHaveBeenCalled();
      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.type).toBe('assistant');
    });

    it('should store message in lastAssistantMessage', () => {
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Test',
      });

      const message = adapter.finalizeAssistantMessage();
      // Access protected property for testing
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((adapter as any).lastAssistantMessage).toEqual(message);
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
      stdoutWriteSpy.mockClear();
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

      const assistantMessages = stdoutWriteSpy.mock.calls
        .map((call: unknown[]) => JSON.parse(call[0] as string))
        .filter(
          (
            payload: unknown,
          ): payload is {
            type: string;
            message: { content: Array<{ type: string }> };
          } => {
            if (
              typeof payload !== 'object' ||
              payload === null ||
              !('type' in payload) ||
              (payload as { type?: string }).type !== 'assistant' ||
              !('message' in payload)
            ) {
              return false;
            }
            const message = (payload as { message?: unknown }).message;
            if (
              typeof message !== 'object' ||
              message === null ||
              !('content' in message)
            ) {
              return false;
            }
            const content = (message as { content?: unknown }).content;
            return (
              Array.isArray(content) &&
              content.length > 0 &&
              content.every(
                (block: unknown) =>
                  typeof block === 'object' &&
                  block !== null &&
                  'type' in block,
              )
            );
          },
        );

      expect(assistantMessages).toHaveLength(2);
      const observedTypes = assistantMessages.map(
        (payload: {
          type: string;
          message: { content: Array<{ type: string }> };
        }) => payload.message.content[0]?.type ?? '',
      );
      expect(observedTypes).toEqual(['text', 'thinking']);
      for (const payload of assistantMessages) {
        const uniqueTypes = new Set(
          payload.message.content.map((block: { type: string }) => block.type),
        );
        expect(uniqueTypes.size).toBeLessThanOrEqual(1);
      }
    });

    it('should throw if message not started', () => {
      adapter = new StreamJsonOutputAdapter(mockConfig, false);
      expect(() => adapter.finalizeAssistantMessage()).toThrow(
        'Message not started',
      );
    });
  });

  describe('emitResult', () => {
    beforeEach(() => {
      adapter = new StreamJsonOutputAdapter(mockConfig, false);
      adapter.startAssistantMessage();
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Response text',
      });
      adapter.finalizeAssistantMessage();
    });

    it('should emit success result immediately', () => {
      stdoutWriteSpy.mockClear();
      adapter.emitResult({
        isError: false,
        durationMs: 1000,
        apiDurationMs: 800,
        numTurns: 1,
      });

      expect(stdoutWriteSpy).toHaveBeenCalled();
      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.type).toBe('result');
      expect(parsed.is_error).toBe(false);
      expect(parsed.subtype).toBe('success');
      expect(parsed.result).toBe('Response text');
      expect(parsed.duration_ms).toBe(1000);
      expect(parsed.num_turns).toBe(1);
    });

    it('should emit error result', () => {
      stdoutWriteSpy.mockClear();
      adapter.emitResult({
        isError: true,
        errorMessage: 'Test error',
        durationMs: 500,
        apiDurationMs: 300,
        numTurns: 1,
      });

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.is_error).toBe(true);
      expect(parsed.subtype).toBe('error_during_execution');
      expect(parsed.error?.message).toBe('Test error');
    });

    it('should use provided summary over extracted text', () => {
      stdoutWriteSpy.mockClear();
      adapter.emitResult({
        isError: false,
        summary: 'Custom summary',
        durationMs: 1000,
        apiDurationMs: 800,
        numTurns: 1,
      });

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.result).toBe('Custom summary');
    });

    it('should include usage information', () => {
      const usage = {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
      };

      stdoutWriteSpy.mockClear();
      adapter.emitResult({
        isError: false,
        usage,
        durationMs: 1000,
        apiDurationMs: 800,
        numTurns: 1,
      });

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.usage).toEqual(usage);
    });

    it('should handle result without assistant message', () => {
      adapter = new StreamJsonOutputAdapter(mockConfig, false);
      stdoutWriteSpy.mockClear();
      adapter.emitResult({
        isError: false,
        durationMs: 1000,
        apiDurationMs: 800,
        numTurns: 1,
      });

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.result).toBe('');
    });
  });

  describe('emitUserMessage', () => {
    beforeEach(() => {
      adapter = new StreamJsonOutputAdapter(mockConfig, false);
    });

    it('should emit user message immediately', () => {
      stdoutWriteSpy.mockClear();
      const parts: Part[] = [{ text: 'Hello user' }];
      adapter.emitUserMessage(parts);

      expect(stdoutWriteSpy).toHaveBeenCalled();
      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.type).toBe('user');
      expect(Array.isArray(parsed.message.content)).toBe(true);
      if (Array.isArray(parsed.message.content)) {
        expect(parsed.message.content).toHaveLength(1);
        expect(parsed.message.content[0]).toEqual({
          type: 'text',
          text: 'Hello user',
        });
      }
    });

    it('should handle parent_tool_use_id', () => {
      const parts: Part[] = [{ text: 'Tool response' }];
      adapter.emitUserMessage(parts);

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      // emitUserMessage currently sets parent_tool_use_id to null
      expect(parsed.parent_tool_use_id).toBeNull();
    });
  });

  describe('emitToolResult', () => {
    beforeEach(() => {
      adapter = new StreamJsonOutputAdapter(mockConfig, false);
    });

    it('should emit tool result message immediately', () => {
      stdoutWriteSpy.mockClear();
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

      expect(stdoutWriteSpy).toHaveBeenCalled();
      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.type).toBe('user');
      expect(parsed.parent_tool_use_id).toBeNull();
      const block = parsed.message.content[0];
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

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      const block = parsed.message.content[0];
      expect(block.is_error).toBe(true);
    });
  });

  describe('emitSystemMessage', () => {
    beforeEach(() => {
      adapter = new StreamJsonOutputAdapter(mockConfig, false);
    });

    it('should emit system message immediately', () => {
      stdoutWriteSpy.mockClear();
      adapter.emitSystemMessage('test_subtype', { data: 'value' });

      expect(stdoutWriteSpy).toHaveBeenCalled();
      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.type).toBe('system');
      expect(parsed.subtype).toBe('test_subtype');
      expect(parsed.data).toEqual({ data: 'value' });
    });
  });

  describe('getSessionId and getModel', () => {
    beforeEach(() => {
      adapter = new StreamJsonOutputAdapter(mockConfig, false);
    });

    it('should return session ID from config', () => {
      expect(adapter.getSessionId()).toBe('test-session-id');
      expect(mockConfig.getSessionId).toHaveBeenCalled();
    });

    it('should return model from config', () => {
      expect(adapter.getModel()).toBe('test-model');
      expect(mockConfig.getModel).toHaveBeenCalled();
    });
  });

  describe('message_id in stream events', () => {
    beforeEach(() => {
      adapter = new StreamJsonOutputAdapter(mockConfig, true);
      adapter.startAssistantMessage();
    });

    it('should include message_id in stream events after message starts', () => {
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Text',
      });
      // Process another event to ensure messageStarted is true
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'More',
      });

      const calls = stdoutWriteSpy.mock.calls;
      // Find all delta events
      const deltaCalls = calls.filter((call: unknown[]) => {
        try {
          const parsed = JSON.parse(call[0] as string);
          return (
            parsed.type === 'stream_event' &&
            parsed.event.type === 'content_block_delta'
          );
        } catch {
          return false;
        }
      });

      expect(deltaCalls.length).toBeGreaterThan(0);
      // The second delta event should have message_id (after messageStarted becomes true)
      // message_id is added to the event object, so check parsed.event.message_id
      if (deltaCalls.length > 1) {
        const secondDelta = JSON.parse(
          (deltaCalls[1] as unknown[])[0] as string,
        );
        // message_id is on the enriched event object
        expect(
          secondDelta.event.message_id || secondDelta.message_id,
        ).toBeTruthy();
      } else {
        // If only one delta, check if message_id exists
        const delta = JSON.parse((deltaCalls[0] as unknown[])[0] as string);
        // message_id is added when messageStarted is true
        // First event may or may not have it, but subsequent ones should
        expect(delta.event.message_id || delta.message_id).toBeTruthy();
      }
    });
  });

  describe('multiple text blocks', () => {
    beforeEach(() => {
      adapter = new StreamJsonOutputAdapter(mockConfig, false);
      adapter.startAssistantMessage();
    });

    it('should split assistant messages when block types change repeatedly', () => {
      stdoutWriteSpy.mockClear();
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Text content',
      });
      adapter.processEvent({
        type: GeminiEventType.Thought,
        value: { subject: 'Thinking', description: 'Thought' },
      });
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'More text',
      });

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.content).toHaveLength(1);
      expect(message.message.content[0]).toMatchObject({
        type: 'text',
        text: 'More text',
      });

      const assistantMessages = stdoutWriteSpy.mock.calls
        .map((call: unknown[]) => JSON.parse(call[0] as string))
        .filter(
          (
            payload: unknown,
          ): payload is {
            type: string;
            message: { content: Array<{ type: string; text?: string }> };
          } => {
            if (
              typeof payload !== 'object' ||
              payload === null ||
              !('type' in payload) ||
              (payload as { type?: string }).type !== 'assistant' ||
              !('message' in payload)
            ) {
              return false;
            }
            const message = (payload as { message?: unknown }).message;
            if (
              typeof message !== 'object' ||
              message === null ||
              !('content' in message)
            ) {
              return false;
            }
            const content = (message as { content?: unknown }).content;
            return (
              Array.isArray(content) &&
              content.length > 0 &&
              content.every(
                (block: unknown) =>
                  typeof block === 'object' &&
                  block !== null &&
                  'type' in block,
              )
            );
          },
        );

      expect(assistantMessages).toHaveLength(3);
      const observedTypes = assistantMessages.map(
        (msg: {
          type: string;
          message: { content: Array<{ type: string; text?: string }> };
        }) => msg.message.content[0]?.type ?? '',
      );
      expect(observedTypes).toEqual(['text', 'thinking', 'text']);
      for (const msg of assistantMessages) {
        const uniqueTypes = new Set(
          msg.message.content.map((block: { type: string }) => block.type),
        );
        expect(uniqueTypes.size).toBeLessThanOrEqual(1);
      }
    });

    it('should merge consecutive text fragments', () => {
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Hello',
      });
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: ' ',
      });
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'World',
      });

      const message = adapter.finalizeAssistantMessage();
      expect(message.message.content).toHaveLength(1);
      expect(message.message.content[0]).toMatchObject({
        type: 'text',
        text: 'Hello World',
      });
    });
  });
});
