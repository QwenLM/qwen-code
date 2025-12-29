/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  GeminiEventType,
  type Config,
  type ServerGeminiStreamEvent,
  type ToolCallRequestInfo,
  type TaskResultDisplay,
} from '@qwen-code/qwen-code-core';
import type { Part, GenerateContentResponseUsageMetadata } from '@google/genai';
import type {
  CLIMessage,
  CLIAssistantMessage,
  ContentBlock,
} from '../types.js';
import {
  BaseJsonOutputAdapter,
  type MessageState,
  type ResultOptions,
  partsToString,
  partsToContentBlock,
  toolResultContent,
  extractTextFromBlocks,
  createExtendedUsage,
} from './BaseJsonOutputAdapter.js';

/**
 * Test implementation of BaseJsonOutputAdapter for unit testing.
 * Captures emitted messages for verification.
 */
class TestJsonOutputAdapter extends BaseJsonOutputAdapter {
  readonly emittedMessages: CLIMessage[] = [];

  protected emitMessageImpl(message: CLIMessage): void {
    this.emittedMessages.push(message);
  }

  protected shouldEmitStreamEvents(): boolean {
    return false;
  }

  finalizeAssistantMessage(): CLIAssistantMessage {
    return this.finalizeAssistantMessageInternal(
      this.mainAgentMessageState,
      null,
    );
  }

  emitResult(options: ResultOptions): void {
    const resultMessage = this.buildResultMessage(
      options,
      this.lastAssistantMessage,
    );
    this.emitMessageImpl(resultMessage);
  }

  // Expose protected methods for testing
  exposeGetMessageState(parentToolUseId: string | null): MessageState {
    return this.getMessageState(parentToolUseId);
  }

  exposeCreateMessageState(): MessageState {
    return this.createMessageState();
  }

  exposeCreateUsage(metadata?: GenerateContentResponseUsageMetadata | null) {
    return this.createUsage(metadata);
  }

  exposeBuildMessage(parentToolUseId: string | null): CLIAssistantMessage {
    return this.buildMessage(parentToolUseId);
  }

  exposeFinalizePendingBlocks(
    state: MessageState,
    parentToolUseId?: string | null,
  ): void {
    this.finalizePendingBlocks(state, parentToolUseId);
  }

  exposeOpenBlock(state: MessageState, index: number, block: unknown): void {
    this.openBlock(state, index, block as ContentBlock);
  }

  exposeCloseBlock(state: MessageState, index: number): void {
    this.closeBlock(state, index);
  }

  exposeEnsureBlockTypeConsistency(
    state: MessageState,
    targetType: 'text' | 'thinking' | 'tool_use',
    parentToolUseId: string | null,
  ): void {
    this.ensureBlockTypeConsistency(state, targetType, parentToolUseId);
  }

  exposeStartAssistantMessageInternal(state: MessageState): void {
    this.startAssistantMessageInternal(state);
  }

  exposeFinalizeAssistantMessageInternal(
    state: MessageState,
    parentToolUseId: string | null,
  ): CLIAssistantMessage {
    return this.finalizeAssistantMessageInternal(state, parentToolUseId);
  }

  exposeAppendText(
    state: MessageState,
    fragment: string,
    parentToolUseId: string | null,
  ): void {
    this.appendText(state, fragment, parentToolUseId);
  }

  exposeAppendThinking(
    state: MessageState,
    subject?: string,
    description?: string,
    parentToolUseId?: string | null,
  ): void {
    this.appendThinking(state, subject, description, parentToolUseId);
  }

  exposeAppendToolUse(
    state: MessageState,
    request: { callId: string; name: string; args: unknown },
    parentToolUseId: string | null,
  ): void {
    this.appendToolUse(state, request as ToolCallRequestInfo, parentToolUseId);
  }

  exposeEnsureMessageStarted(
    state: MessageState,
    parentToolUseId: string | null,
  ): void {
    this.ensureMessageStarted(state, parentToolUseId);
  }

  exposeCreateSubagentToolUseBlock(
    state: MessageState,
    toolCall: NonNullable<TaskResultDisplay['toolCalls']>[number],
    parentToolUseId: string,
  ) {
    return this.createSubagentToolUseBlock(state, toolCall, parentToolUseId);
  }

  exposeBuildResultMessage(options: ResultOptions) {
    return this.buildResultMessage(options, this.lastAssistantMessage);
  }

  exposeBuildSubagentErrorResult(errorMessage: string, numTurns: number) {
    return this.buildSubagentErrorResult(errorMessage, numTurns);
  }
}

function createMockConfig(): Config {
  return {
    getSessionId: vi.fn().mockReturnValue('test-session-id'),
    getModel: vi.fn().mockReturnValue('test-model'),
  } as unknown as Config;
}

describe('BaseJsonOutputAdapter', () => {
  let adapter: TestJsonOutputAdapter;
  let mockConfig: Config;

  beforeEach(() => {
    mockConfig = createMockConfig();
    adapter = new TestJsonOutputAdapter(mockConfig);
  });

  describe('createMessageState', () => {
    it('should create a new message state with default values', () => {
      const state = adapter.exposeCreateMessageState();

      expect(state.messageId).toBeNull();
      expect(state.blocks).toEqual([]);
      expect(state.openBlocks).toBeInstanceOf(Set);
      expect(state.openBlocks.size).toBe(0);
      expect(state.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
      });
      expect(state.messageStarted).toBe(false);
      expect(state.finalized).toBe(false);
      expect(state.currentBlockType).toBeNull();
    });
  });

  describe('getMessageState', () => {
    it('should return main agent state for null parentToolUseId', () => {
      const state = adapter.exposeGetMessageState(null);
      expect(state).toBe(adapter['mainAgentMessageState']);
    });

    it('should create and return subagent state for non-null parentToolUseId', () => {
      const parentToolUseId = 'parent-tool-1';
      const state1 = adapter.exposeGetMessageState(parentToolUseId);
      const state2 = adapter.exposeGetMessageState(parentToolUseId);

      expect(state1).toBe(state2);
      expect(state1).not.toBe(adapter['mainAgentMessageState']);
      expect(adapter['subagentMessageStates'].has(parentToolUseId)).toBe(true);
    });

    it('should create separate states for different parentToolUseIds', () => {
      const state1 = adapter.exposeGetMessageState('parent-1');
      const state2 = adapter.exposeGetMessageState('parent-2');

      expect(state1).not.toBe(state2);
    });
  });

  describe('createUsage', () => {
    it('should create usage with default values when metadata is not provided', () => {
      const usage = adapter.exposeCreateUsage();

      expect(usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
      });
    });

    it('should create usage with null metadata', () => {
      const usage = adapter.exposeCreateUsage(null);

      expect(usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
      });
    });

    it('should extract usage from metadata', () => {
      const metadata: GenerateContentResponseUsageMetadata = {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        cachedContentTokenCount: 10,
        totalTokenCount: 160,
      };

      const usage = adapter.exposeCreateUsage(metadata);

      expect(usage).toEqual({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        total_tokens: 160,
      });
    });

    it('should handle partial metadata', () => {
      const metadata: GenerateContentResponseUsageMetadata = {
        promptTokenCount: 100,
        // candidatesTokenCount missing
      };

      const usage = adapter.exposeCreateUsage(metadata);

      expect(usage).toEqual({
        input_tokens: 100,
        output_tokens: 0,
      });
    });
  });

  describe('buildMessage', () => {
    beforeEach(() => {
      adapter.startAssistantMessage();
    });

    it('should throw error if message not started', () => {
      // Manipulate the actual main agent state used by buildMessage
      const state = adapter['mainAgentMessageState'];
      state.messageId = null; // Explicitly set to null to test error case
      state.blocks = [{ type: 'text', text: 'test' }];

      expect(() => adapter.exposeBuildMessage(null)).toThrow(
        'Message not started',
      );
    });

    it('should build message with text blocks', () => {
      adapter.startAssistantMessage();
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Hello world',
      });

      const message = adapter.exposeBuildMessage(null);

      expect(message.type).toBe('assistant');
      expect(message.uuid).toBeTruthy();
      expect(message.session_id).toBe('test-session-id');
      expect(message.parent_tool_use_id).toBeNull();
      expect(message.message.role).toBe('assistant');
      expect(message.message.model).toBe('test-model');
      expect(message.message.content).toHaveLength(1);
      expect(message.message.content[0]).toMatchObject({
        type: 'text',
        text: 'Hello world',
      });
      expect(message.message.stop_reason).toBeNull();
    });

    it('should set stop_reason to tool_use when message contains only tool_use blocks', () => {
      adapter.startAssistantMessage();
      adapter.processEvent({
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-1',
          name: 'test_tool',
          args: {},
          isClientInitiated: false,
          prompt_id: 'prompt-1',
        },
      });

      const message = adapter.exposeBuildMessage(null);

      expect(message.message.stop_reason).toBe('tool_use');
    });

    it('should enforce single block type constraint', () => {
      adapter.startAssistantMessage();
      const state = adapter['mainAgentMessageState'];
      state.messageId = 'test-id';
      state.blocks = [
        { type: 'text', text: 'text' },
        { type: 'thinking', thinking: 'thinking', signature: 'sig' },
      ];

      expect(() => adapter.exposeBuildMessage(null)).toThrow(
        'Assistant message must contain only one type of ContentBlock',
      );
    });
  });

  describe('finalizePendingBlocks', () => {
    it('should finalize text blocks', () => {
      const state = adapter.exposeCreateMessageState();
      state.blocks = [{ type: 'text', text: 'test' }];
      const index = 0;
      adapter.exposeOpenBlock(state, index, state.blocks[0]);

      adapter.exposeFinalizePendingBlocks(state);

      expect(state.openBlocks.has(index)).toBe(false);
    });

    it('should finalize thinking blocks', () => {
      const state = adapter.exposeCreateMessageState();
      state.blocks = [{ type: 'thinking', thinking: 'test', signature: 'sig' }];
      const index = 0;
      adapter.exposeOpenBlock(state, index, state.blocks[0]);

      adapter.exposeFinalizePendingBlocks(state);

      expect(state.openBlocks.has(index)).toBe(false);
    });

    it('should do nothing if no blocks', () => {
      const state = adapter.exposeCreateMessageState();

      expect(() => adapter.exposeFinalizePendingBlocks(state)).not.toThrow();
    });

    it('should do nothing if last block is not text or thinking', () => {
      const state = adapter.exposeCreateMessageState();
      state.blocks = [
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'test',
          input: {},
        },
      ];

      expect(() => adapter.exposeFinalizePendingBlocks(state)).not.toThrow();
    });
  });

  describe('openBlock and closeBlock', () => {
    it('should add block index to openBlocks', () => {
      const state = adapter.exposeCreateMessageState();
      const block = { type: 'text', text: 'test' };

      adapter.exposeOpenBlock(state, 0, block);

      expect(state.openBlocks.has(0)).toBe(true);
    });

    it('should remove block index from openBlocks', () => {
      const state = adapter.exposeCreateMessageState();
      const block = { type: 'text', text: 'test' };
      adapter.exposeOpenBlock(state, 0, block);

      adapter.exposeCloseBlock(state, 0);

      expect(state.openBlocks.has(0)).toBe(false);
    });

    it('should not throw when closing non-existent block', () => {
      const state = adapter.exposeCreateMessageState();

      expect(() => adapter.exposeCloseBlock(state, 0)).not.toThrow();
    });
  });

  describe('ensureBlockTypeConsistency', () => {
    it('should set currentBlockType if null', () => {
      const state = adapter.exposeCreateMessageState();
      state.currentBlockType = null;

      adapter.exposeEnsureBlockTypeConsistency(state, 'text', null);

      expect(state.currentBlockType).toBe('text');
    });

    it('should do nothing if currentBlockType matches target', () => {
      const state = adapter.exposeCreateMessageState();
      state.currentBlockType = 'text';
      state.messageId = 'test-id';
      state.blocks = [{ type: 'text', text: 'test' }];

      adapter.exposeEnsureBlockTypeConsistency(state, 'text', null);

      expect(state.currentBlockType).toBe('text');
      expect(state.blocks).toHaveLength(1);
    });

    it('should finalize and start new message when block type changes', () => {
      adapter.startAssistantMessage();
      const state = adapter['mainAgentMessageState'];
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'text',
      });

      adapter.exposeEnsureBlockTypeConsistency(state, 'thinking', null);

      expect(state.currentBlockType).toBe('thinking');
      expect(state.blocks.length).toBe(0);
    });
  });

  describe('startAssistantMessageInternal', () => {
    it('should reset message state', () => {
      const state = adapter.exposeCreateMessageState();
      state.messageId = 'old-id';
      state.blocks = [{ type: 'text', text: 'old' }];
      state.openBlocks.add(0);
      state.usage = { input_tokens: 100, output_tokens: 50 };
      state.messageStarted = true;
      state.finalized = true;
      state.currentBlockType = 'text';

      adapter.exposeStartAssistantMessageInternal(state);

      expect(state.messageId).toBeTruthy();
      expect(state.messageId).not.toBe('old-id');
      expect(state.blocks).toEqual([]);
      expect(state.openBlocks.size).toBe(0);
      expect(state.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
      expect(state.messageStarted).toBe(false);
      expect(state.finalized).toBe(false);
      expect(state.currentBlockType).toBeNull();
    });
  });

  describe('finalizeAssistantMessageInternal', () => {
    it('should return same message if already finalized', () => {
      adapter.startAssistantMessage();
      const state = adapter['mainAgentMessageState'];
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'test',
      });

      const message1 = adapter.exposeFinalizeAssistantMessageInternal(
        state,
        null,
      );
      const message2 = adapter.exposeFinalizeAssistantMessageInternal(
        state,
        null,
      );

      expect(message1).toEqual(message2);
      expect(state.finalized).toBe(true);
    });

    it('should finalize pending blocks and emit message', () => {
      adapter.startAssistantMessage();
      const state = adapter['mainAgentMessageState'];
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'test',
      });

      const message = adapter.exposeFinalizeAssistantMessageInternal(
        state,
        null,
      );

      expect(message).toBeDefined();
      expect(state.finalized).toBe(true);
      expect(adapter.emittedMessages).toContain(message);
    });

    it('should close all open blocks', () => {
      adapter.startAssistantMessage();
      const state = adapter['mainAgentMessageState'];
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'test',
      });
      state.openBlocks.add(0);

      adapter.exposeFinalizeAssistantMessageInternal(state, null);

      expect(state.openBlocks.size).toBe(0);
    });
  });

  describe('appendText', () => {
    it('should create new text block if none exists', () => {
      const state = adapter.exposeCreateMessageState();
      adapter.startAssistantMessage();

      adapter.exposeAppendText(state, 'Hello', null);

      expect(state.blocks).toHaveLength(1);
      expect(state.blocks[0]).toMatchObject({
        type: 'text',
        text: 'Hello',
      });
    });

    it('should append to existing text block', () => {
      const state = adapter.exposeCreateMessageState();
      adapter.startAssistantMessage();
      adapter.exposeAppendText(state, 'Hello', null);

      adapter.exposeAppendText(state, ' World', null);

      expect(state.blocks).toHaveLength(1);
      expect(state.blocks[0]).toMatchObject({
        type: 'text',
        text: 'Hello World',
      });
    });

    it('should ignore empty fragments', () => {
      const state = adapter.exposeCreateMessageState();
      adapter.startAssistantMessage();

      adapter.exposeAppendText(state, '', null);

      expect(state.blocks).toHaveLength(0);
    });

    it('should ensure message is started', () => {
      const state = adapter.exposeCreateMessageState();
      adapter.startAssistantMessage();

      adapter.exposeAppendText(state, 'test', null);

      expect(state.messageStarted).toBe(true);
    });
  });

  describe('appendThinking', () => {
    it('should create new thinking block', () => {
      const state = adapter.exposeCreateMessageState();
      adapter.startAssistantMessage();

      adapter.exposeAppendThinking(
        state,
        'Planning',
        'Thinking about task',
        null,
      );

      expect(state.blocks).toHaveLength(1);
      expect(state.blocks[0]).toMatchObject({
        type: 'thinking',
        thinking: 'Planning: Thinking about task',
        signature: 'Planning',
      });
    });

    it('should append to existing thinking block', () => {
      const state = adapter.exposeCreateMessageState();
      adapter.startAssistantMessage();
      adapter.exposeAppendThinking(state, 'Planning', 'First thought', null);

      adapter.exposeAppendThinking(state, 'Planning', 'Second thought', null);

      expect(state.blocks).toHaveLength(1);
      expect(state.blocks[0].type).toBe('thinking');
      const block = state.blocks[0] as { thinking: string };
      expect(block.thinking).toContain('First thought');
      expect(block.thinking).toContain('Second thought');
    });

    it('should handle only subject', () => {
      const state = adapter.exposeCreateMessageState();
      adapter.startAssistantMessage();

      adapter.exposeAppendThinking(state, 'Planning', '', null);

      expect(state.blocks).toHaveLength(1);
      expect(state.blocks[0]).toMatchObject({
        type: 'thinking',
        signature: 'Planning',
      });
    });

    it('should ignore empty fragments', () => {
      const state = adapter.exposeCreateMessageState();
      adapter.startAssistantMessage();

      adapter.exposeAppendThinking(state, '', '', null);

      expect(state.blocks).toHaveLength(0);
    });

    it('should preserve whitespace in thinking content', () => {
      const state = adapter.exposeCreateMessageState();
      adapter.startAssistantMessage();

      adapter.exposeAppendThinking(
        state,
        '',
        'The user just said "Hello"',
        null,
      );

      expect(state.blocks).toHaveLength(1);
      expect(state.blocks[0]).toMatchObject({
        type: 'thinking',
        thinking: 'The user just said "Hello"',
      });
      // Verify spaces are preserved
      const block = state.blocks[0] as { thinking: string };
      expect(block.thinking).toContain('user just');
      expect(block.thinking).not.toContain('userjust');
    });

    it('should preserve whitespace when appending multiple thinking fragments', () => {
      const state = adapter.exposeCreateMessageState();
      adapter.startAssistantMessage();

      // Simulate streaming thinking content in fragments
      adapter.exposeAppendThinking(state, '', 'The user just', null);
      adapter.exposeAppendThinking(state, '', ' said "Hello"', null);
      adapter.exposeAppendThinking(
        state,
        '',
        '. This is a simple greeting',
        null,
      );

      expect(state.blocks).toHaveLength(1);
      const block = state.blocks[0] as { thinking: string };
      // Verify the complete text with all spaces preserved
      expect(block.thinking).toBe(
        'The user just said "Hello". This is a simple greeting',
      );
      // Verify specific space preservation
      expect(block.thinking).toContain('user just ');
      expect(block.thinking).toContain(' said');
      expect(block.thinking).toContain('". This');
      expect(block.thinking).not.toContain('userjust');
      expect(block.thinking).not.toContain('justsaid');
    });

    it('should preserve leading and trailing whitespace in description', () => {
      const state = adapter.exposeCreateMessageState();
      adapter.startAssistantMessage();

      adapter.exposeAppendThinking(state, '', '  content with spaces  ', null);

      expect(state.blocks).toHaveLength(1);
      const block = state.blocks[0] as { thinking: string };
      expect(block.thinking).toBe('  content with spaces  ');
    });
  });

  describe('appendToolUse', () => {
    it('should create tool_use block', () => {
      const state = adapter.exposeCreateMessageState();
      adapter.startAssistantMessage();

      adapter.exposeAppendToolUse(
        state,
        {
          callId: 'tool-1',
          name: 'test_tool',
          args: { param: 'value' },
        },
        null,
      );

      expect(state.blocks).toHaveLength(1);
      expect(state.blocks[0]).toMatchObject({
        type: 'tool_use',
        id: 'tool-1',
        name: 'test_tool',
        input: { param: 'value' },
      });
    });

    it('should finalize pending blocks before appending tool_use', () => {
      const state = adapter.exposeCreateMessageState();
      adapter.startAssistantMessage();
      adapter.exposeAppendText(state, 'text', null);

      adapter.exposeAppendToolUse(
        state,
        {
          callId: 'tool-1',
          name: 'test_tool',
          args: {},
        },
        null,
      );

      expect(state.blocks.length).toBeGreaterThan(0);
      const toolUseBlock = state.blocks.find((b) => b.type === 'tool_use');
      expect(toolUseBlock).toBeDefined();
    });
  });

  describe('ensureMessageStarted', () => {
    it('should set messageStarted to true', () => {
      const state = adapter.exposeCreateMessageState();
      adapter.startAssistantMessage();

      adapter.exposeEnsureMessageStarted(state, null);

      expect(state.messageStarted).toBe(true);
    });

    it('should do nothing if already started', () => {
      const state = adapter.exposeCreateMessageState();
      adapter.startAssistantMessage();
      state.messageStarted = true;

      adapter.exposeEnsureMessageStarted(state, null);

      expect(state.messageStarted).toBe(true);
    });
  });

  describe('startAssistantMessage', () => {
    it('should reset main agent message state', () => {
      adapter.startAssistantMessage();
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'test',
      });

      adapter.startAssistantMessage();

      const state = adapter['mainAgentMessageState'];
      expect(state.blocks).toHaveLength(0);
      expect(state.messageStarted).toBe(false);
    });
  });

  describe('processEvent', () => {
    beforeEach(() => {
      adapter.startAssistantMessage();
    });

    it('should process Content events', () => {
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Hello',
      });

      const state = adapter['mainAgentMessageState'];
      expect(state.blocks).toHaveLength(1);
      expect(state.blocks[0]).toMatchObject({
        type: 'text',
        text: 'Hello',
      });
    });

    it('should process Citation events', () => {
      adapter.processEvent({
        type: GeminiEventType.Citation,
        value: 'Citation text',
      });

      const state = adapter['mainAgentMessageState'];
      expect(state.blocks[0].type).toBe('text');
      const block = state.blocks[0] as { text: string };
      expect(block.text).toContain('Citation text');
    });

    it('should ignore non-string Citation values', () => {
      adapter.processEvent({
        type: GeminiEventType.Citation,
        value: 123,
      } as unknown as ServerGeminiStreamEvent);

      const state = adapter['mainAgentMessageState'];
      expect(state.blocks).toHaveLength(0);
    });

    it('should process Thought events', () => {
      adapter.processEvent({
        type: GeminiEventType.Thought,
        value: {
          subject: 'Planning',
          description: 'Thinking',
        },
      });

      const state = adapter['mainAgentMessageState'];
      expect(state.blocks).toHaveLength(1);
      expect(state.blocks[0]).toMatchObject({
        type: 'thinking',
        thinking: 'Planning: Thinking',
        signature: 'Planning',
      });
    });

    it('should process ToolCallRequest events', () => {
      adapter.processEvent({
        type: GeminiEventType.ToolCallRequest,
        value: {
          callId: 'tool-1',
          name: 'test_tool',
          args: { param: 'value' },
          isClientInitiated: false,
          prompt_id: 'prompt-1',
        },
      });

      const state = adapter['mainAgentMessageState'];
      expect(state.blocks).toHaveLength(1);
      expect(state.blocks[0]).toMatchObject({
        type: 'tool_use',
        id: 'tool-1',
        name: 'test_tool',
        input: { param: 'value' },
      });
    });

    it('should process Finished events with usage metadata', () => {
      adapter.processEvent({
        type: GeminiEventType.Finished,
        value: {
          reason: undefined,
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 50,
          },
        },
      });

      const state = adapter['mainAgentMessageState'];
      expect(state.usage).toEqual({
        input_tokens: 100,
        output_tokens: 50,
      });
    });

    it('should ignore events after finalization', () => {
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'First',
      });
      adapter.finalizeAssistantMessage();

      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Second',
      });

      const state = adapter['mainAgentMessageState'];
      expect(state.blocks[0]).toMatchObject({
        type: 'text',
        text: 'First',
      });
    });
  });

  describe('finalizeAssistantMessage', () => {
    beforeEach(() => {
      adapter.startAssistantMessage();
    });

    it('should build and return assistant message', () => {
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Test response',
      });

      const message = adapter.finalizeAssistantMessage();

      expect(message.type).toBe('assistant');
      expect(message.message.content).toHaveLength(1);
      expect(adapter.emittedMessages).toContain(message);
    });
  });

  describe('emitUserMessage', () => {
    it('should emit user message with ContentBlock array', () => {
      const parts: Part[] = [{ text: 'Hello user' }];

      adapter.emitUserMessage(parts);

      expect(adapter.emittedMessages).toHaveLength(1);
      const message = adapter.emittedMessages[0];
      expect(message.type).toBe('user');
      if (message.type === 'user') {
        expect(Array.isArray(message.message.content)).toBe(true);
        if (Array.isArray(message.message.content)) {
          expect(message.message.content).toHaveLength(1);
          expect(message.message.content[0]).toEqual({
            type: 'text',
            text: 'Hello user',
          });
        }
        expect(message.parent_tool_use_id).toBeNull();
      }
    });

    it('should handle multiple parts and merge into single text block', () => {
      const parts: Part[] = [{ text: 'Hello' }, { text: ' World' }];

      adapter.emitUserMessage(parts);

      const message = adapter.emittedMessages[0];
      if (message.type === 'user' && Array.isArray(message.message.content)) {
        expect(message.message.content).toHaveLength(1);
        expect(message.message.content[0]).toEqual({
          type: 'text',
          text: 'Hello World',
        });
      }
    });

    it('should handle non-text parts by converting to text blocks', () => {
      const parts: Part[] = [
        { text: 'Hello' },
        { functionCall: { name: 'test' } },
      ];

      adapter.emitUserMessage(parts);

      const message = adapter.emittedMessages[0];
      if (message.type === 'user' && Array.isArray(message.message.content)) {
        expect(message.message.content.length).toBeGreaterThan(0);
        const textBlock = message.message.content.find(
          (block) => block.type === 'text',
        );
        expect(textBlock).toBeDefined();
        if (textBlock && textBlock.type === 'text') {
          expect(textBlock.text).toContain('Hello');
        }
      }
    });
  });

  describe('emitToolResult', () => {
    it('should emit tool result message with content', () => {
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

      expect(adapter.emittedMessages).toHaveLength(1);
      const message = adapter.emittedMessages[0];
      expect(message.type).toBe('user');
      if (message.type === 'user') {
        expect(message.message.content).toHaveLength(1);
        const block = message.message.content[0];
        if (typeof block === 'object' && block !== null && 'type' in block) {
          expect(block.type).toBe('tool_result');
          if (block.type === 'tool_result') {
            expect(block.tool_use_id).toBe('tool-1');
            expect(block.content).toBe('Tool executed successfully');
            expect(block.is_error).toBe(false);
          }
        }
      }
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

      const message = adapter.emittedMessages[0];
      if (message.type === 'user') {
        const block = message.message.content[0];
        if (typeof block === 'object' && block !== null && 'type' in block) {
          if (block.type === 'tool_result') {
            expect(block.is_error).toBe(true);
          }
        }
      }
    });

    it('should handle parentToolUseId', () => {
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
        resultDisplay: 'Result',
        error: undefined,
        errorType: undefined,
      };

      adapter.emitToolResult(request, response, 'parent-tool-1');

      const message = adapter.emittedMessages[0];
      if (message.type === 'user') {
        expect(message.parent_tool_use_id).toBe('parent-tool-1');
      }
    });
  });

  describe('emitSystemMessage', () => {
    it('should emit system message', () => {
      adapter.emitSystemMessage('test_subtype', { data: 'value' });

      expect(adapter.emittedMessages).toHaveLength(1);
      const message = adapter.emittedMessages[0];
      expect(message.type).toBe('system');
      if (message.type === 'system') {
        expect(message.subtype).toBe('test_subtype');
        expect(message.data).toEqual({ data: 'value' });
      }
    });

    it('should handle system message without data', () => {
      adapter.emitSystemMessage('test_subtype');

      const message = adapter.emittedMessages[0];
      if (message.type === 'system') {
        expect(message.subtype).toBe('test_subtype');
      }
    });
  });

  describe('buildResultMessage', () => {
    beforeEach(() => {
      adapter.startAssistantMessage();
      adapter.processEvent({
        type: GeminiEventType.Content,
        value: 'Response text',
      });
      const message = adapter.finalizeAssistantMessage();
      // Update lastAssistantMessage manually since test adapter doesn't do it automatically
      adapter['lastAssistantMessage'] = message;
    });

    it('should build success result message', () => {
      const options: ResultOptions = {
        isError: false,
        durationMs: 1000,
        apiDurationMs: 800,
        numTurns: 1,
      };

      const result = adapter.exposeBuildResultMessage(options);

      expect(result.type).toBe('result');
      expect(result.is_error).toBe(false);
      if (!result.is_error) {
        expect(result.subtype).toBe('success');
        expect(result.result).toBe('Response text');
        expect(result.duration_ms).toBe(1000);
        expect(result.duration_api_ms).toBe(800);
        expect(result.num_turns).toBe(1);
      }
    });

    it('should build error result message', () => {
      const options: ResultOptions = {
        isError: true,
        errorMessage: 'Test error',
        durationMs: 500,
        apiDurationMs: 300,
        numTurns: 1,
      };

      const result = adapter.exposeBuildResultMessage(options);

      expect(result.type).toBe('result');
      expect(result.is_error).toBe(true);
      if (result.is_error) {
        expect(result.subtype).toBe('error_during_execution');
        expect(result.error?.message).toBe('Test error');
      }
    });

    it('should use provided summary over extracted text', () => {
      const options: ResultOptions = {
        isError: false,
        summary: 'Custom summary',
        durationMs: 1000,
        apiDurationMs: 800,
        numTurns: 1,
      };

      const result = adapter.exposeBuildResultMessage(options);

      if (!result.is_error) {
        expect(result.result).toBe('Custom summary');
      }
    });

    it('should include usage information', () => {
      const usage = {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
      };
      const options: ResultOptions = {
        isError: false,
        usage,
        durationMs: 1000,
        apiDurationMs: 800,
        numTurns: 1,
      };

      const result = adapter.exposeBuildResultMessage(options);

      expect(result.usage).toEqual(usage);
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
      const options: ResultOptions = {
        isError: false,
        stats,
        durationMs: 1000,
        apiDurationMs: 800,
        numTurns: 1,
      };

      const result = adapter.exposeBuildResultMessage(options);

      if (!result.is_error && 'stats' in result) {
        expect(result['stats']).toEqual(stats);
      }
    });

    it('should handle result without assistant message', () => {
      adapter = new TestJsonOutputAdapter(mockConfig);
      const options: ResultOptions = {
        isError: false,
        durationMs: 1000,
        apiDurationMs: 800,
        numTurns: 1,
      };

      const result = adapter.exposeBuildResultMessage(options);

      if (!result.is_error) {
        expect(result.result).toBe('');
      }
    });
  });

  describe('startSubagentAssistantMessage', () => {
    it('should start subagent message', () => {
      const parentToolUseId = 'parent-tool-1';

      adapter.startSubagentAssistantMessage(parentToolUseId);

      const state = adapter.exposeGetMessageState(parentToolUseId);
      expect(state.messageId).toBeTruthy();
      expect(state.blocks).toEqual([]);
    });
  });

  describe('finalizeSubagentAssistantMessage', () => {
    it('should finalize and return subagent message', () => {
      const parentToolUseId = 'parent-tool-1';
      adapter.startSubagentAssistantMessage(parentToolUseId);
      const state = adapter.exposeGetMessageState(parentToolUseId);
      adapter.exposeAppendText(state, 'Subagent response', parentToolUseId);

      const message = adapter.finalizeSubagentAssistantMessage(parentToolUseId);

      expect(message.type).toBe('assistant');
      expect(message.parent_tool_use_id).toBe(parentToolUseId);
      expect(message.message.content).toHaveLength(1);
    });
  });

  describe('emitSubagentErrorResult', () => {
    it('should emit subagent error result', () => {
      const parentToolUseId = 'parent-tool-1';
      adapter.startSubagentAssistantMessage(parentToolUseId);

      adapter.emitSubagentErrorResult('Error occurred', 5, parentToolUseId);

      expect(adapter.emittedMessages.length).toBeGreaterThan(0);
      const errorResult = adapter.emittedMessages.find(
        (msg) => msg.type === 'result' && msg.is_error === true,
      );
      expect(errorResult).toBeDefined();
      if (
        errorResult &&
        errorResult.type === 'result' &&
        errorResult.is_error
      ) {
        expect(errorResult.error?.message).toBe('Error occurred');
        expect(errorResult.num_turns).toBe(5);
      }
    });

    it('should finalize pending assistant message before emitting error', () => {
      const parentToolUseId = 'parent-tool-1';
      adapter.startSubagentAssistantMessage(parentToolUseId);
      const state = adapter.exposeGetMessageState(parentToolUseId);
      adapter.exposeAppendText(state, 'Partial response', parentToolUseId);

      adapter.emitSubagentErrorResult('Error', 1, parentToolUseId);

      const assistantMessage = adapter.emittedMessages.find(
        (msg) => msg.type === 'assistant',
      );
      expect(assistantMessage).toBeDefined();
    });
  });

  describe('processSubagentToolCall', () => {
    it('should process subagent tool call', () => {
      const parentToolUseId = 'parent-tool-1';
      adapter.startSubagentAssistantMessage(parentToolUseId);
      const toolCall: NonNullable<TaskResultDisplay['toolCalls']>[number] = {
        callId: 'tool-1',
        name: 'test_tool',
        args: { param: 'value' },
        status: 'success',
        resultDisplay: 'Result',
      };

      adapter.processSubagentToolCall(toolCall, parentToolUseId);

      // processSubagentToolCall finalizes the message and starts a new one,
      // so we should check the emitted messages instead of the state
      const assistantMessages = adapter.emittedMessages.filter(
        (msg) =>
          msg.type === 'assistant' &&
          msg.parent_tool_use_id === parentToolUseId,
      );
      expect(assistantMessages.length).toBeGreaterThan(0);
      const toolUseMessage = assistantMessages.find(
        (msg) =>
          msg.type === 'assistant' &&
          msg.message.content.some((block) => block.type === 'tool_use'),
      );
      expect(toolUseMessage).toBeDefined();
    });

    it('should finalize text message before tool_use', () => {
      const parentToolUseId = 'parent-tool-1';
      adapter.startSubagentAssistantMessage(parentToolUseId);
      const state = adapter.exposeGetMessageState(parentToolUseId);
      adapter.exposeAppendText(state, 'Text', parentToolUseId);

      const toolCall: NonNullable<TaskResultDisplay['toolCalls']>[number] = {
        callId: 'tool-1',
        name: 'test_tool',
        args: {},
        status: 'success',
        resultDisplay: 'Result',
      };

      adapter.processSubagentToolCall(toolCall, parentToolUseId);

      const assistantMessages = adapter.emittedMessages.filter(
        (msg) => msg.type === 'assistant',
      );
      expect(assistantMessages.length).toBeGreaterThan(0);
    });
  });

  describe('createSubagentToolUseBlock', () => {
    it('should create tool_use block for subagent', () => {
      const state = adapter.exposeCreateMessageState();
      adapter.startAssistantMessage();
      const toolCall: NonNullable<TaskResultDisplay['toolCalls']>[number] = {
        callId: 'tool-1',
        name: 'test_tool',
        args: { param: 'value' },
        status: 'success',
        resultDisplay: 'Result',
      };

      const { block, index } = adapter.exposeCreateSubagentToolUseBlock(
        state,
        toolCall,
        'parent-tool-1',
      );

      expect(block).toMatchObject({
        type: 'tool_use',
        id: 'tool-1',
        name: 'test_tool',
        input: { param: 'value' },
      });
      expect(state.blocks[index]).toBe(block);
      expect(state.openBlocks.has(index)).toBe(true);
    });
  });

  describe('buildSubagentErrorResult', () => {
    it('should build subagent error result', () => {
      const errorResult = adapter.exposeBuildSubagentErrorResult(
        'Error message',
        3,
      );

      expect(errorResult.type).toBe('result');
      expect(errorResult.is_error).toBe(true);
      expect(errorResult.subtype).toBe('error_during_execution');
      expect(errorResult.error?.message).toBe('Error message');
      expect(errorResult.num_turns).toBe(3);
      expect(errorResult.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
      });
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

  describe('helper functions', () => {
    describe('partsToContentBlock', () => {
      it('should convert text parts to TextBlock array', () => {
        const parts: Part[] = [{ text: 'Hello' }, { text: ' World' }];

        const result = partsToContentBlock(parts);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          type: 'text',
          text: 'Hello World',
        });
      });

      it('should handle functionResponse parts by extracting output', () => {
        const parts: Part[] = [
          { text: 'Result: ' },
          {
            functionResponse: {
              name: 'test',
              response: { output: 'function output' },
            },
          },
        ];

        const result = partsToContentBlock(parts);

        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('text');
        if (result[0].type === 'text') {
          expect(result[0].text).toBe('Result: function output');
        }
      });

      it('should handle non-text parts by converting to JSON string', () => {
        const parts: Part[] = [
          { text: 'Hello' },
          { functionCall: { name: 'test' } },
        ];

        const result = partsToContentBlock(parts);

        expect(result.length).toBeGreaterThan(0);
        const textBlock = result.find((block) => block.type === 'text');
        expect(textBlock).toBeDefined();
        if (textBlock && textBlock.type === 'text') {
          expect(textBlock.text).toContain('Hello');
          expect(textBlock.text).toContain('functionCall');
        }
      });

      it('should handle empty array', () => {
        const result = partsToContentBlock([]);

        expect(result).toEqual([]);
      });

      it('should merge consecutive text parts into single block', () => {
        const parts: Part[] = [
          { text: 'Part 1' },
          { text: 'Part 2' },
          { text: 'Part 3' },
        ];

        const result = partsToContentBlock(parts);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          type: 'text',
          text: 'Part 1Part 2Part 3',
        });
      });
    });

    describe('partsToString', () => {
      it('should convert text parts to string', () => {
        const parts: Part[] = [{ text: 'Hello' }, { text: ' World' }];

        const result = partsToString(parts);

        expect(result).toBe('Hello World');
      });

      it('should handle non-text parts', () => {
        const parts: Part[] = [
          { text: 'Hello' },
          { functionCall: { name: 'test' } },
        ];

        const result = partsToString(parts);

        expect(result).toContain('Hello');
        expect(result).toContain('functionCall');
      });

      it('should handle empty array', () => {
        const result = partsToString([]);

        expect(result).toBe('');
      });
    });

    describe('toolResultContent', () => {
      it('should extract content from resultDisplay', () => {
        const response = {
          callId: 'tool-1',
          resultDisplay: 'Tool result',
          responseParts: [],
          error: undefined,
          errorType: undefined,
        };

        const result = toolResultContent(response);

        expect(result).toBe('Tool result');
      });

      it('should extract content from responseParts', () => {
        const response = {
          callId: 'tool-1',
          resultDisplay: undefined,
          responseParts: [{ text: 'Result' }],
          error: undefined,
          errorType: undefined,
        };

        const result = toolResultContent(response);

        expect(result).toBeTruthy();
      });

      it('should extract error message', () => {
        const response = {
          callId: 'tool-1',
          resultDisplay: undefined,
          responseParts: [],
          error: new Error('Tool failed'),
          errorType: undefined,
        };

        const result = toolResultContent(response);

        expect(result).toBe('Tool failed');
      });

      it('should return undefined if no content', () => {
        const response = {
          callId: 'tool-1',
          resultDisplay: undefined,
          responseParts: [],
          error: undefined,
          errorType: undefined,
        };

        const result = toolResultContent(response);

        expect(result).toBeUndefined();
      });

      it('should ignore empty resultDisplay', () => {
        const response = {
          callId: 'tool-1',
          resultDisplay: '   ',
          responseParts: [{ text: 'Result' }],
          error: undefined,
          errorType: undefined,
        };

        const result = toolResultContent(response);

        expect(result).toBeTruthy();
        expect(result).not.toBe('   ');
      });
    });

    describe('extractTextFromBlocks', () => {
      it('should extract text from text blocks', () => {
        const blocks: ContentBlock[] = [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: ' World' },
        ];

        const result = extractTextFromBlocks(blocks);

        expect(result).toBe('Hello World');
      });

      it('should ignore non-text blocks', () => {
        const blocks: ContentBlock[] = [
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', id: 'tool-1', name: 'test', input: {} },
        ];

        const result = extractTextFromBlocks(blocks);

        expect(result).toBe('Hello');
      });

      it('should handle empty array', () => {
        const result = extractTextFromBlocks([]);

        expect(result).toBe('');
      });

      it('should handle array with no text blocks', () => {
        const blocks: ContentBlock[] = [
          { type: 'tool_use', id: 'tool-1', name: 'test', input: {} },
        ];

        const result = extractTextFromBlocks(blocks);

        expect(result).toBe('');
      });
    });

    describe('createExtendedUsage', () => {
      it('should create extended usage with default values', () => {
        const usage = createExtendedUsage();

        expect(usage).toEqual({
          input_tokens: 0,
          output_tokens: 0,
        });
      });
    });
  });
});
