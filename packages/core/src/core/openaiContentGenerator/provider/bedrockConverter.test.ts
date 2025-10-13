/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import {
  convertOpenAIToBedrock,
  convertBedrockToOpenAI,
  convertBedrockStreamToOpenAI,
} from './bedrockConverter.js';
import type {
  BedrockConverseResponse,
  BedrockStreamEvent,
} from './bedrockTypes.js';

describe('bedrockConverter', () => {
  describe('convertOpenAIToBedrock', () => {
    it('should convert simple user message', () => {
      const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-coder',
        messages: [{ role: 'user', content: 'Hello, world!' }],
      };

      const result = convertOpenAIToBedrock(openaiRequest, 'qwen-coder');

      expect(result.modelId).toBe('qwen-coder');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toHaveLength(1);
      expect(result.messages[0].content[0]).toEqual({ text: 'Hello, world!' });
    });

    it('should extract system messages', () => {
      const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-coder',
        messages: [
          { role: 'system', content: 'You are a helpful assistant' },
          { role: 'user', content: 'Hello!' },
        ],
      };

      const result = convertOpenAIToBedrock(openaiRequest, 'qwen-coder');

      expect(result.system).toBeDefined();
      expect(result.system).toHaveLength(1);
      expect(result.system![0].text).toBe('You are a helpful assistant');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
    });

    it('should convert inference parameters', () => {
      const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-coder',
        messages: [{ role: 'user', content: 'Hello!' }],
        temperature: 0.7,
        max_tokens: 1000,
        top_p: 0.9,
      };

      const result = convertOpenAIToBedrock(openaiRequest, 'qwen-coder');

      expect(result.inferenceConfig).toBeDefined();
      expect(result.inferenceConfig!.temperature).toBe(0.7);
      expect(result.inferenceConfig!.maxTokens).toBe(1000);
      expect(result.inferenceConfig!.topP).toBe(0.9);
    });

    it('should handle null and undefined inference parameters', () => {
      const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-coder',
        messages: [{ role: 'user', content: 'Hello!' }],
        temperature: null as never,
        max_tokens: undefined,
        top_p: 0,
      };

      const result = convertOpenAIToBedrock(openaiRequest, 'qwen-coder');

      expect(result.inferenceConfig).toBeDefined();
      expect(result.inferenceConfig!.temperature).toBeUndefined();
      expect(result.inferenceConfig!.maxTokens).toBeUndefined();
      expect(result.inferenceConfig!.topP).toBe(0);
    });

    it('should convert stop sequences', () => {
      const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-coder',
        messages: [{ role: 'user', content: 'Hello!' }],
        stop: ['END', 'STOP'],
      };

      const result = convertOpenAIToBedrock(openaiRequest, 'qwen-coder');

      expect(result.inferenceConfig!.stopSequences).toEqual(['END', 'STOP']);
    });

    it('should convert single stop sequence string', () => {
      const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-coder',
        messages: [{ role: 'user', content: 'Hello!' }],
        stop: 'END',
      };

      const result = convertOpenAIToBedrock(openaiRequest, 'qwen-coder');

      expect(result.inferenceConfig!.stopSequences).toEqual(['END']);
    });

    it('should filter null values from stop sequences', () => {
      const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-coder',
        messages: [{ role: 'user', content: 'Hello!' }],
        stop: ['END', null as never, 'STOP'],
      };

      const result = convertOpenAIToBedrock(openaiRequest, 'qwen-coder');

      expect(result.inferenceConfig!.stopSequences).toEqual(['END', 'STOP']);
    });

    it('should convert tool definitions', () => {
      const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-coder',
        messages: [{ role: 'user', content: 'Hello!' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get the weather',
              parameters: {
                type: 'object',
                properties: {
                  location: { type: 'string' },
                },
              },
            },
          },
        ],
      };

      const result = convertOpenAIToBedrock(openaiRequest, 'qwen-coder');

      expect(result.toolConfig).toBeDefined();
      expect(result.toolConfig!.tools).toHaveLength(1);
      expect(result.toolConfig!.tools[0].toolSpec.name).toBe('get_weather');
      expect(result.toolConfig!.tools[0].toolSpec.description).toBe(
        'Get the weather',
      );
    });

    it('should convert tool_choice auto', () => {
      const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-coder',
        messages: [{ role: 'user', content: 'Hello!' }],
        tools: [
          {
            type: 'function',
            function: { name: 'test_tool', parameters: {} },
          },
        ],
        tool_choice: 'auto',
      };

      const result = convertOpenAIToBedrock(openaiRequest, 'qwen-coder');

      expect(result.toolConfig!.toolChoice).toEqual({ auto: {} });
    });

    it('should convert tool_choice required', () => {
      const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-coder',
        messages: [{ role: 'user', content: 'Hello!' }],
        tools: [
          {
            type: 'function',
            function: { name: 'test_tool', parameters: {} },
          },
        ],
        tool_choice: 'required',
      };

      const result = convertOpenAIToBedrock(openaiRequest, 'qwen-coder');

      expect(result.toolConfig!.toolChoice).toEqual({ any: {} });
    });

    it('should convert tool_choice specific function', () => {
      const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-coder',
        messages: [{ role: 'user', content: 'Hello!' }],
        tools: [
          {
            type: 'function',
            function: { name: 'test_tool', parameters: {} },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'test_tool' } },
      };

      const result = convertOpenAIToBedrock(openaiRequest, 'qwen-coder');

      expect(result.toolConfig!.toolChoice).toEqual({
        tool: { name: 'test_tool' },
      });
    });

    it('should handle multi-turn conversation', () => {
      const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-coder',
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello!' },
          { role: 'user', content: 'How are you?' },
        ],
      };

      const result = convertOpenAIToBedrock(openaiRequest, 'qwen-coder');

      expect(result.system).toHaveLength(1);
      expect(result.messages).toHaveLength(3);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[1].role).toBe('assistant');
      expect(result.messages[2].role).toBe('user');
    });

    it('should handle assistant message with tool calls', () => {
      const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-coder',
        messages: [
          { role: 'user', content: 'What is the weather?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-123',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"location":"SF"}',
                },
              },
            ],
          },
        ],
      };

      const result = convertOpenAIToBedrock(openaiRequest, 'qwen-coder');

      expect(result.messages).toHaveLength(2);
      expect(result.messages[1].role).toBe('assistant');
      expect(result.messages[1].content).toHaveLength(1);
      expect(result.messages[1].content[0]).toHaveProperty('toolUse');
      const toolUse = (result.messages[1].content[0] as { toolUse: never })
        .toolUse;
      expect(toolUse).toMatchObject({
        toolUseId: 'call-123',
        name: 'get_weather',
        input: { location: 'SF' },
      });
    });

    it('should handle tool result messages', () => {
      const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-coder',
        messages: [
          { role: 'user', content: 'What is the weather?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-123',
                type: 'function',
                function: { name: 'get_weather', arguments: '{}' },
              },
            ],
          },
          {
            role: 'tool',
            content: 'Sunny, 72°F',
            tool_call_id: 'call-123',
          },
        ],
      };

      const result = convertOpenAIToBedrock(openaiRequest, 'qwen-coder');

      expect(result.messages).toHaveLength(3);
      expect(result.messages[2].role).toBe('user');
      expect(result.messages[2].content[0]).toHaveProperty('toolResult');
      const toolResult = (
        result.messages[2].content[0] as { toolResult: never }
      ).toolResult;
      expect(toolResult).toMatchObject({
        toolUseId: 'call-123',
        content: [{ text: 'Sunny, 72°F' }],
        status: 'success',
      });
    });

    it('should handle array content in user messages', () => {
      const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-coder',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Hello' },
              { type: 'text', text: ' world' },
            ],
          },
        ],
      };

      const result = convertOpenAIToBedrock(openaiRequest, 'qwen-coder');

      expect(result.messages[0].content).toHaveLength(2);
      expect(result.messages[0].content[0]).toEqual({ text: 'Hello' });
      expect(result.messages[0].content[1]).toEqual({ text: ' world' });
    });

    it('should handle multiple system messages', () => {
      const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-coder',
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'system', content: 'Be concise' },
          { role: 'user', content: 'Hello!' },
        ],
      };

      const result = convertOpenAIToBedrock(openaiRequest, 'qwen-coder');

      expect(result.system).toHaveLength(2);
      expect(result.system![0].text).toBe('You are helpful');
      expect(result.system![1].text).toBe('Be concise');
    });

    it('should handle empty messages array', () => {
      const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-coder',
        messages: [],
      };

      const result = convertOpenAIToBedrock(openaiRequest, 'qwen-coder');

      expect(result.messages).toEqual([]);
      expect(result.system).toBeUndefined();
    });

    it('should handle assistant message with content and tool calls', () => {
      const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-coder',
        messages: [
          {
            role: 'assistant',
            content: 'Let me check that for you.',
            tool_calls: [
              {
                id: 'call-123',
                type: 'function',
                function: { name: 'search', arguments: '{}' },
              },
            ],
          },
        ],
      };

      const result = convertOpenAIToBedrock(openaiRequest, 'qwen-coder');

      expect(result.messages[0].content).toHaveLength(2);
      expect(result.messages[0].content[0]).toEqual({
        text: 'Let me check that for you.',
      });
      expect(result.messages[0].content[1]).toHaveProperty('toolUse');
    });
  });

  describe('convertBedrockToOpenAI', () => {
    it('should convert text response', () => {
      const bedrockResponse: BedrockConverseResponse = {
        output: {
          message: {
            role: 'assistant',
            content: [{ text: 'Hello! How can I help you?' }],
          },
        },
        stopReason: 'end_turn',
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
        },
      };

      const result = convertBedrockToOpenAI(bedrockResponse, 'qwen-coder');

      expect(result.choices).toHaveLength(1);
      expect(result.choices[0].message.role).toBe('assistant');
      expect(result.choices[0].message.content).toBe(
        'Hello! How can I help you?',
      );
      expect(result.choices[0].finish_reason).toBe('stop');
      expect(result.usage?.prompt_tokens).toBe(10);
      expect(result.usage?.completion_tokens).toBe(20);
      expect(result.usage?.total_tokens).toBe(30);
    });

    it('should convert tool call response', () => {
      const bedrockResponse: BedrockConverseResponse = {
        output: {
          message: {
            role: 'assistant',
            content: [
              {
                toolUse: {
                  toolUseId: 'tool-123',
                  name: 'get_weather',
                  input: { location: 'San Francisco' },
                },
              },
            ],
          },
        },
        stopReason: 'tool_use',
        usage: {
          inputTokens: 10,
          outputTokens: 15,
          totalTokens: 25,
        },
      };

      const result = convertBedrockToOpenAI(bedrockResponse, 'qwen-coder');

      expect(result.choices[0].message.tool_calls).toBeDefined();
      expect(result.choices[0].message.tool_calls).toHaveLength(1);
      expect(result.choices[0].message.tool_calls![0].id).toBe('tool-123');
      expect(result.choices[0].message.tool_calls![0].function.name).toBe(
        'get_weather',
      );
      expect(result.choices[0].finish_reason).toBe('tool_calls');
    });

    it('should convert multiple text blocks', () => {
      const bedrockResponse: BedrockConverseResponse = {
        output: {
          message: {
            role: 'assistant',
            content: [{ text: 'Hello ' }, { text: 'world!' }],
          },
        },
        stopReason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      };

      const result = convertBedrockToOpenAI(bedrockResponse, 'qwen-coder');

      expect(result.choices[0].message.content).toBe('Hello world!');
    });

    it('should convert mixed text and tool call response', () => {
      const bedrockResponse: BedrockConverseResponse = {
        output: {
          message: {
            role: 'assistant',
            content: [
              { text: 'Let me check that.' },
              {
                toolUse: {
                  toolUseId: 'tool-123',
                  name: 'search',
                  input: { query: 'test' },
                },
              },
            ],
          },
        },
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
      };

      const result = convertBedrockToOpenAI(bedrockResponse, 'qwen-coder');

      expect(result.choices[0].message.content).toBe('Let me check that.');
      expect(result.choices[0].message.tool_calls).toHaveLength(1);
    });

    it('should convert max_tokens stop reason', () => {
      const bedrockResponse: BedrockConverseResponse = {
        output: {
          message: { role: 'assistant', content: [{ text: 'Hello' }] },
        },
        stopReason: 'max_tokens',
        usage: { inputTokens: 10, outputTokens: 1000, totalTokens: 1010 },
      };

      const result = convertBedrockToOpenAI(bedrockResponse, 'qwen-coder');

      expect(result.choices[0].finish_reason).toBe('length');
    });

    it('should convert content_filtered stop reason', () => {
      const bedrockResponse: BedrockConverseResponse = {
        output: {
          message: { role: 'assistant', content: [{ text: 'Sorry' }] },
        },
        stopReason: 'content_filtered',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };

      const result = convertBedrockToOpenAI(bedrockResponse, 'qwen-coder');

      expect(result.choices[0].finish_reason).toBe('content_filter');
    });

    it('should convert stop_sequence stop reason', () => {
      const bedrockResponse: BedrockConverseResponse = {
        output: {
          message: { role: 'assistant', content: [{ text: 'Done' }] },
        },
        stopReason: 'stop_sequence',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };

      const result = convertBedrockToOpenAI(bedrockResponse, 'qwen-coder');

      expect(result.choices[0].finish_reason).toBe('stop');
    });
  });

  describe('convertBedrockStreamToOpenAI', () => {
    it('should convert simple text stream', () => {
      const events: BedrockStreamEvent[] = [
        { messageStart: { role: 'assistant' } },
        {
          contentBlockStart: {
            start: { text: '' },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { text: 'Hello' },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { text: ' world' },
            contentBlockIndex: 0,
          },
        },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: 'end_turn' } },
      ];

      const chunks = Array.from(
        convertBedrockStreamToOpenAI(events, 'qwen-coder'),
      );

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].choices[0].delta.role).toBe('assistant');

      const textChunks = chunks.filter(
        (c) => c.choices[0].delta.content !== undefined,
      );
      // Should have at least 2 text chunks
      expect(textChunks.length).toBeGreaterThanOrEqual(2);

      // Find chunks with actual text content (not empty strings)
      const nonEmptyTextChunks = textChunks.filter(
        (c) => c.choices[0].delta.content !== '',
      );
      expect(nonEmptyTextChunks).toHaveLength(2);
      expect(nonEmptyTextChunks[0].choices[0].delta.content).toBe('Hello');
      expect(nonEmptyTextChunks[1].choices[0].delta.content).toBe(' world');

      const finalChunk = chunks[chunks.length - 1];
      expect(finalChunk.choices[0].finish_reason).toBe('stop');
    });

    it('should convert tool call stream', () => {
      const events: BedrockStreamEvent[] = [
        { messageStart: { role: 'assistant' } },
        {
          contentBlockStart: {
            start: {
              toolUse: { toolUseId: 'tool-123', name: 'get_weather' },
            },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { toolUse: { input: '{"location"' } },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { toolUse: { input: ':"SF"}' } },
            contentBlockIndex: 0,
          },
        },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: 'tool_use' } },
      ];

      const chunks = Array.from(
        convertBedrockStreamToOpenAI(events, 'qwen-coder'),
      );

      const toolChunks = chunks.filter(
        (c) => c.choices[0].delta.tool_calls !== undefined,
      );
      expect(toolChunks.length).toBeGreaterThan(0);

      const firstToolChunk = toolChunks[0];
      const toolCalls = firstToolChunk.choices[0].delta.tool_calls;
      expect(toolCalls).toBeDefined();
      expect(toolCalls!.length).toBeGreaterThan(0);

      const firstToolCall = toolCalls![0];
      expect(firstToolCall).toBeDefined();
      expect(firstToolCall!.id).toBe('tool-123');
      expect(firstToolCall!.function).toBeDefined();
      expect(firstToolCall!.function!.name).toBe('get_weather');

      const finalChunk = chunks[chunks.length - 1];
      expect(finalChunk.choices[0].finish_reason).toBe('tool_calls');
    });

    it('should handle metadata events', () => {
      const events: BedrockStreamEvent[] = [
        { messageStart: { role: 'assistant' } },
        {
          contentBlockStart: {
            start: { text: '' },
            contentBlockIndex: 0,
          },
        },
        {
          contentBlockDelta: {
            delta: { text: 'Hi' },
            contentBlockIndex: 0,
          },
        },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: 'end_turn' } },
        {
          metadata: {
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            metrics: { latencyMs: 100 },
          },
        },
      ];

      const chunks = Array.from(
        convertBedrockStreamToOpenAI(events, 'qwen-coder'),
      );

      // Metadata events are not included in OpenAI chunks
      // but should not cause errors
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('should handle empty stream', () => {
      const events: BedrockStreamEvent[] = [];

      const chunks = Array.from(
        convertBedrockStreamToOpenAI(events, 'qwen-coder'),
      );

      expect(chunks).toHaveLength(0);
    });
  });
});
