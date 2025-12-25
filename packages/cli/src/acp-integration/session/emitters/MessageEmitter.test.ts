/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageEmitter } from './MessageEmitter.js';
import type { SessionContext } from '../types.js';
import type { Config } from '@qwen-code/qwen-code-core';

describe('MessageEmitter', () => {
  let mockContext: SessionContext;
  let sendUpdateSpy: ReturnType<typeof vi.fn>;
  let emitter: MessageEmitter;

  beforeEach(() => {
    sendUpdateSpy = vi.fn().mockResolvedValue(undefined);
    mockContext = {
      sessionId: 'test-session-id',
      config: {} as Config,
      sendUpdate: sendUpdateSpy,
    };
    emitter = new MessageEmitter(mockContext);
  });

  describe('emitUserMessage', () => {
    it('should send user_message_chunk update with text content', async () => {
      await emitter.emitUserMessage('Hello, world!');

      expect(sendUpdateSpy).toHaveBeenCalledTimes(1);
      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Hello, world!' },
      });
    });

    it('should handle empty text', async () => {
      await emitter.emitUserMessage('');

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: '' },
      });
    });

    it('should handle multiline text', async () => {
      const multilineText = 'Line 1\nLine 2\nLine 3';
      await emitter.emitUserMessage(multilineText);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: multilineText },
      });
    });
  });

  describe('emitAgentMessage', () => {
    it('should send agent_message_chunk update with text content', async () => {
      await emitter.emitAgentMessage('I can help you with that.');

      expect(sendUpdateSpy).toHaveBeenCalledTimes(1);
      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'I can help you with that.' },
      });
    });
  });

  describe('emitAgentThought', () => {
    it('should send agent_thought_chunk update with text content', async () => {
      await emitter.emitAgentThought('Let me think about this...');

      expect(sendUpdateSpy).toHaveBeenCalledTimes(1);
      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Let me think about this...' },
      });
    });
  });

  describe('emitMessage', () => {
    it('should emit user message when role is user', async () => {
      await emitter.emitMessage('User input', 'user');

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'User input' },
      });
    });

    it('should emit agent message when role is assistant and isThought is false', async () => {
      await emitter.emitMessage('Agent response', 'assistant', false);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Agent response' },
      });
    });

    it('should emit agent message when role is assistant and isThought is not provided', async () => {
      await emitter.emitMessage('Agent response', 'assistant');

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Agent response' },
      });
    });

    it('should emit agent thought when role is assistant and isThought is true', async () => {
      await emitter.emitAgentThought('Thinking...');

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Thinking...' },
      });
    });

    it('should ignore isThought when role is user', async () => {
      // Even if isThought is true, user messages should still be user_message_chunk
      await emitter.emitMessage('User input', 'user', true);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'User input' },
      });
    });
  });

  describe('multiple emissions', () => {
    it('should handle multiple sequential emissions', async () => {
      await emitter.emitUserMessage('First');
      await emitter.emitAgentMessage('Second');
      await emitter.emitAgentThought('Third');

      expect(sendUpdateSpy).toHaveBeenCalledTimes(3);
      expect(sendUpdateSpy).toHaveBeenNthCalledWith(1, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'First' },
      });
      expect(sendUpdateSpy).toHaveBeenNthCalledWith(2, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Second' },
      });
      expect(sendUpdateSpy).toHaveBeenNthCalledWith(3, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Third' },
      });
    });
  });

  describe('emitUsageMetadata', () => {
    it('should emit agent_message_chunk with _meta.usage containing token counts', async () => {
      const usageMetadata = {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 25,
        totalTokenCount: 175,
        cachedContentTokenCount: 10,
      };

      await emitter.emitUsageMetadata(usageMetadata);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: {
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            thoughtsTokens: 25,
            totalTokens: 175,
            cachedTokens: 10,
          },
        },
      });
    });

    it('should include durationMs in _meta when provided', async () => {
      const usageMetadata = {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 2,
        totalTokenCount: 17,
        cachedContentTokenCount: 1,
      };

      await emitter.emitUsageMetadata(usageMetadata, 'done', 1234);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'done' },
        _meta: {
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            thoughtsTokens: 2,
            totalTokens: 17,
            cachedTokens: 1,
          },
          durationMs: 1234,
        },
      });
    });
  });
});
