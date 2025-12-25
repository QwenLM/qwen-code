/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OpenAIContentConverter } from './converter.js';
import type { StreamingToolCallParser } from './streamingToolCallParser.js';
import {
  Type,
  type GenerateContentParameters,
  type Content,
  type Tool,
  type CallableTool,
} from '@google/genai';
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

  describe('convertGeminiToolsToOpenAI', () => {
    it('should convert Gemini tools with parameters field', async () => {
      const geminiTools = [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Get weather for a location',
              parameters: {
                type: Type.OBJECT,
                properties: {
                  location: { type: Type.STRING },
                },
                required: ['location'],
              },
            },
          ],
        },
      ] as Tool[];

      const result = await converter.convertGeminiToolsToOpenAI(geminiTools);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather for a location',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string' },
            },
            required: ['location'],
          },
        },
      });
    });

    it('should convert MCP tools with parametersJsonSchema field', async () => {
      // MCP tools use parametersJsonSchema which contains plain JSON schema (not Gemini types)
      const mcpTools = [
        {
          functionDeclarations: [
            {
              name: 'read_file',
              description: 'Read a file from disk',
              parametersJsonSchema: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                },
                required: ['path'],
              },
            },
          ],
        },
      ] as Tool[];

      const result = await converter.convertGeminiToolsToOpenAI(mcpTools);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file from disk',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
            required: ['path'],
          },
        },
      });
    });

    it('should handle CallableTool by resolving tool function', async () => {
      const callableTools = [
        {
          tool: async () => ({
            functionDeclarations: [
              {
                name: 'dynamic_tool',
                description: 'A dynamically resolved tool',
                parameters: {
                  type: Type.OBJECT,
                  properties: {},
                },
              },
            ],
          }),
        },
      ] as CallableTool[];

      const result = await converter.convertGeminiToolsToOpenAI(callableTools);

      expect(result).toHaveLength(1);
      expect(result[0].function.name).toBe('dynamic_tool');
    });

    it('should skip functions without name or description', async () => {
      const geminiTools = [
        {
          functionDeclarations: [
            {
              name: 'valid_tool',
              description: 'A valid tool',
            },
            {
              name: 'missing_description',
              // no description
            },
            {
              // no name
              description: 'Missing name',
            },
          ],
        },
      ] as Tool[];

      const result = await converter.convertGeminiToolsToOpenAI(geminiTools);

      expect(result).toHaveLength(1);
      expect(result[0].function.name).toBe('valid_tool');
    });

    it('should handle tools without functionDeclarations', async () => {
      const emptyTools: Tool[] = [{} as Tool, { functionDeclarations: [] }];

      const result = await converter.convertGeminiToolsToOpenAI(emptyTools);

      expect(result).toHaveLength(0);
    });

    it('should handle functions without parameters', async () => {
      const geminiTools: Tool[] = [
        {
          functionDeclarations: [
            {
              name: 'no_params_tool',
              description: 'A tool without parameters',
            },
          ],
        },
      ];

      const result = await converter.convertGeminiToolsToOpenAI(geminiTools);

      expect(result).toHaveLength(1);
      expect(result[0].function.parameters).toBeUndefined();
    });

    it('should not mutate original parametersJsonSchema', async () => {
      const originalSchema = {
        type: 'object',
        properties: { foo: { type: 'string' } },
      };
      const mcpTools: Tool[] = [
        {
          functionDeclarations: [
            {
              name: 'test_tool',
              description: 'Test tool',
              parametersJsonSchema: originalSchema,
            },
          ],
        } as Tool,
      ];

      const result = await converter.convertGeminiToolsToOpenAI(mcpTools);

      // Verify the result is a copy, not the same reference
      expect(result[0].function.parameters).not.toBe(originalSchema);
      expect(result[0].function.parameters).toEqual(originalSchema);
    });
  });

  describe('convertGeminiToolParametersToOpenAI', () => {
    it('should convert type names to lowercase', () => {
      const params = {
        type: 'OBJECT',
        properties: {
          count: { type: 'INTEGER' },
          amount: { type: 'NUMBER' },
          name: { type: 'STRING' },
        },
      };

      const result = converter.convertGeminiToolParametersToOpenAI(params);

      expect(result).toEqual({
        type: 'object',
        properties: {
          count: { type: 'integer' },
          amount: { type: 'number' },
          name: { type: 'string' },
        },
      });
    });

    it('should convert string numeric constraints to numbers', () => {
      const params = {
        type: 'object',
        properties: {
          value: {
            type: 'number',
            minimum: '0',
            maximum: '100',
            multipleOf: '0.5',
          },
        },
      };

      const result = converter.convertGeminiToolParametersToOpenAI(params);
      const properties = result?.['properties'] as Record<string, unknown>;

      expect(properties?.['value']).toEqual({
        type: 'number',
        minimum: 0,
        maximum: 100,
        multipleOf: 0.5,
      });
    });

    it('should convert string length constraints to integers', () => {
      const params = {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            minLength: '1',
            maxLength: '100',
          },
          items: {
            type: 'array',
            minItems: '0',
            maxItems: '10',
          },
        },
      };

      const result = converter.convertGeminiToolParametersToOpenAI(params);
      const properties = result?.['properties'] as Record<string, unknown>;

      expect(properties?.['text']).toEqual({
        type: 'string',
        minLength: 1,
        maxLength: 100,
      });
      expect(properties?.['items']).toEqual({
        type: 'array',
        minItems: 0,
        maxItems: 10,
      });
    });

    it('should handle nested objects', () => {
      const params = {
        type: 'object',
        properties: {
          nested: {
            type: 'object',
            properties: {
              deep: {
                type: 'INTEGER',
                minimum: '0',
              },
            },
          },
        },
      };

      const result = converter.convertGeminiToolParametersToOpenAI(params);
      const properties = result?.['properties'] as Record<string, unknown>;
      const nested = properties?.['nested'] as Record<string, unknown>;
      const nestedProperties = nested?.['properties'] as Record<
        string,
        unknown
      >;

      expect(nestedProperties?.['deep']).toEqual({
        type: 'integer',
        minimum: 0,
      });
    });

    it('should handle arrays', () => {
      const params = {
        type: 'array',
        items: {
          type: 'INTEGER',
        },
      };

      const result = converter.convertGeminiToolParametersToOpenAI(params);

      expect(result).toEqual({
        type: 'array',
        items: {
          type: 'integer',
        },
      });
    });

    it('should return undefined for null or non-object input', () => {
      expect(
        converter.convertGeminiToolParametersToOpenAI(
          null as unknown as Record<string, unknown>,
        ),
      ).toBeNull();
      expect(
        converter.convertGeminiToolParametersToOpenAI(
          undefined as unknown as Record<string, unknown>,
        ),
      ).toBeUndefined();
    });

    it('should not mutate the original parameters', () => {
      const original = {
        type: 'OBJECT',
        properties: {
          count: { type: 'INTEGER' },
        },
      };
      const originalCopy = JSON.parse(JSON.stringify(original));

      converter.convertGeminiToolParametersToOpenAI(original);

      expect(original).toEqual(originalCopy);
    });
  });
});
