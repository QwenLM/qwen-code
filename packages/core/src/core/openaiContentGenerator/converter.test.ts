/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OpenAIContentConverter } from './converter.js';
import type { StreamingToolCallParser } from './streamingToolCallParser.js';
import type { GenerateContentParameters, Content } from '@google/genai';
import type OpenAI from 'openai';

describe('OpenAIContentConverter', () => {
  let converter: OpenAIContentConverter;

  beforeEach(() => {
    converter = new OpenAIContentConverter('test-model');
  });

  describe('resetStreamingToolCalls', () => {
    it('should clear streaming tool calls accumulator', () => {
      // Access private field for testing
      const parser = (
        converter as unknown as {
          streamingToolCallParser: StreamingToolCallParser;
        }
      ).streamingToolCallParser;

      // Add some test data to the parser
      parser.addChunk(0, '{"arg": "value"}', 'test-id', 'test-function');
      parser.addChunk(1, '{"arg2": "value2"}', 'test-id-2', 'test-function-2');

      // Verify data is present
      expect(parser.getBuffer(0)).toBe('{"arg": "value"}');
      expect(parser.getBuffer(1)).toBe('{"arg2": "value2"}');

      // Call reset method
      converter.resetStreamingToolCalls();

      // Verify data is cleared
      expect(parser.getBuffer(0)).toBe('');
      expect(parser.getBuffer(1)).toBe('');
    });

    it('should be safe to call multiple times', () => {
      // Call reset multiple times
      converter.resetStreamingToolCalls();
      converter.resetStreamingToolCalls();
      converter.resetStreamingToolCalls();

      // Should not throw any errors
      const parser = (
        converter as unknown as {
          streamingToolCallParser: StreamingToolCallParser;
        }
      ).streamingToolCallParser;
      expect(parser.getBuffer(0)).toBe('');
    });

    it('should be safe to call on empty accumulator', () => {
      // Call reset on empty accumulator
      converter.resetStreamingToolCalls();

      // Should not throw any errors
      const parser = (
        converter as unknown as {
          streamingToolCallParser: StreamingToolCallParser;
        }
      ).streamingToolCallParser;
      expect(parser.getBuffer(0)).toBe('');
    });
  });

  describe('convertGeminiRequestToOpenAI', () => {
    const createRequestWithFunctionResponse = (
      response: Record<string, unknown>,
    ): GenerateContentParameters => {
      const contents: Content[] = [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_1',
                name: 'shell',
                args: {},
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_1',
                name: 'shell',
                response,
              },
            },
          ],
        },
      ];
      return {
        model: 'models/test',
        contents,
      };
    };

    it('should extract raw output from function response objects', () => {
      const request = createRequestWithFunctionResponse({
        output: 'Raw output text',
      });

      const messages = converter.convertGeminiRequestToOpenAI(request);
      const toolMessage = messages.find((message) => message.role === 'tool');

      expect(toolMessage).toBeDefined();
      expect(toolMessage?.content).toBe('Raw output text');
    });

    it('should prioritize error field when present', () => {
      const request = createRequestWithFunctionResponse({
        error: 'Command failed',
      });

      const messages = converter.convertGeminiRequestToOpenAI(request);
      const toolMessage = messages.find((message) => message.role === 'tool');

      expect(toolMessage).toBeDefined();
      expect(toolMessage?.content).toBe('Command failed');
    });

    it('should stringify non-string responses', () => {
      const request = createRequestWithFunctionResponse({
        data: { value: 42 },
      });

      const messages = converter.convertGeminiRequestToOpenAI(request);
      const toolMessage = messages.find((message) => message.role === 'tool');

      expect(toolMessage).toBeDefined();
      expect(toolMessage?.content).toBe('{"data":{"value":42}}');
    });
  });

  describe('OpenAI -> Gemini reasoning content', () => {
    it('should convert reasoning_content to a thought part for non-streaming responses', () => {
      const response = converter.convertOpenAIResponseToGemini({
        object: 'chat.completion',
        id: 'chatcmpl-1',
        created: 123,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'final answer',
              reasoning_content: 'chain-of-thought',
            },
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletion);

      const parts = response.candidates?.[0]?.content?.parts;
      expect(parts?.[0]).toEqual(
        expect.objectContaining({ thought: true, text: 'chain-of-thought' }),
      );
      expect(parts?.[1]).toEqual(
        expect.objectContaining({ text: 'final answer' }),
      );
    });

    it('should convert streaming reasoning_content delta to a thought part', () => {
      const chunk = converter.convertOpenAIChunkToGemini({
        object: 'chat.completion.chunk',
        id: 'chunk-1',
        created: 456,
        choices: [
          {
            index: 0,
            delta: {
              content: 'visible text',
              reasoning_content: 'thinking...',
            },
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
        model: 'gpt-test',
      } as unknown as OpenAI.Chat.ChatCompletionChunk);

      const parts = chunk.candidates?.[0]?.content?.parts;
      expect(parts?.[0]).toEqual(
        expect.objectContaining({ thought: true, text: 'thinking...' }),
      );
      expect(parts?.[1]).toEqual(
        expect.objectContaining({ text: 'visible text' }),
      );
    });
  });
});
