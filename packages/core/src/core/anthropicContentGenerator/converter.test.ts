/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallableTool, Content, Tool } from '@google/genai';
import { FinishReason } from '@google/genai';
import type Anthropic from '@anthropic-ai/sdk';

// Mock schema conversion so we can force edge-cases (e.g. missing `type`).
vi.mock('../../utils/schemaConverter.js', () => ({
  convertSchema: vi.fn((schema: unknown) => schema),
}));

import { convertSchema } from '../../utils/schemaConverter.js';
import { AnthropicContentConverter } from './converter.js';

describe('AnthropicContentConverter', () => {
  let converter: AnthropicContentConverter;

  beforeEach(() => {
    vi.clearAllMocks();
    converter = new AnthropicContentConverter('test-model', 'auto');
  });

  describe('convertGeminiRequestToAnthropic', () => {
    it('extracts systemInstruction text from string', () => {
      const { system } = converter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: 'hi',
        config: { systemInstruction: 'sys' },
      });

      expect(system).toBe('sys');
    });

    it('extracts systemInstruction text from parts and joins with newlines', () => {
      const { system } = converter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: 'hi',
        config: {
          systemInstruction: {
            role: 'system',
            parts: [{ text: 'a' }, { text: 'b' }],
          } as unknown as Content,
        },
      });

      expect(system).toBe('a\nb');
    });

    it('converts a plain string content into a user message', () => {
      const { messages } = converter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: 'Hello',
      });

      expect(messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ]);
    });

    it('converts user content parts into a user message with text blocks', () => {
      const { messages } = converter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Hello' }, { text: 'World' }],
          },
        ],
      });

      expect(messages).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: 'World' },
          ],
        },
      ]);
    });

    it('converts assistant thought parts into Anthropic thinking blocks', () => {
      const { messages } = converter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              { text: 'internal', thought: true, thoughtSignature: 'sig' },
              { text: 'visible' },
            ],
          },
        ],
      });

      expect(messages).toEqual([
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'internal', signature: 'sig' },
            { type: 'text', text: 'visible' },
          ],
        },
      ]);
    });

    it('converts functionCall parts from model role into tool_use blocks', () => {
      const { messages } = converter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              { text: 'preface' },
              {
                functionCall: {
                  id: 'call-1',
                  name: 'tool_name',
                  args: { a: 1 },
                },
              },
            ],
          },
        ],
      });

      expect(messages).toEqual([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'preface' },
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'tool_name',
              input: { a: 1 },
            },
          ],
        },
      ]);
    });

    it('converts functionResponse parts into user tool_result messages', () => {
      const { messages } = converter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call-1',
                  name: 'tool_name',
                  response: { output: 'ok' },
                },
              },
            ],
          },
        ],
      });

      expect(messages).toEqual([
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-1',
              content: 'ok',
            },
          ],
        },
      ]);
    });

    it('extracts function response error field when present', () => {
      const { messages } = converter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call-1',
                  name: 'tool_name',
                  response: { error: 'boom' },
                },
              },
            ],
          },
        ],
      });

      expect(messages[0]).toEqual({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: 'boom',
          },
        ],
      });
    });
  });

  describe('convertGeminiToolsToAnthropic', () => {
    it('converts Tool.functionDeclarations to Anthropic tools and runs schema conversion', async () => {
      const tools = [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Get weather',
              parametersJsonSchema: {
                type: 'object',
                properties: { location: { type: 'string' } },
                required: ['location'],
              },
            },
          ],
        },
      ] as Tool[];

      const result = await converter.convertGeminiToolsToAnthropic(tools);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: 'get_weather',
        description: 'Get weather',
        input_schema: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
        },
      });

      expect(vi.mocked(convertSchema)).toHaveBeenCalledTimes(1);
    });

    it('resolves CallableTool.tool() and converts its functionDeclarations', async () => {
      const callable = [
        {
          tool: async () =>
            ({
              functionDeclarations: [
                {
                  name: 'dynamic_tool',
                  description: 'resolved tool',
                  parametersJsonSchema: { type: 'object', properties: {} },
                },
              ],
            }) as unknown as Tool,
        },
      ] as CallableTool[];

      const result = await converter.convertGeminiToolsToAnthropic(callable);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('dynamic_tool');
    });

    it('defaults missing parameters to an empty object schema', async () => {
      const tools = [
        {
          functionDeclarations: [
            { name: 'no_params', description: 'no params' },
          ],
        },
      ] as Tool[];

      const result = await converter.convertGeminiToolsToAnthropic(tools);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: 'no_params',
        description: 'no params',
        input_schema: { type: 'object', properties: {} },
      });
    });

    it('forces input_schema.type to "object" when schema conversion yields no type', async () => {
      vi.mocked(convertSchema).mockImplementationOnce(() => ({
        properties: {},
      }));
      const tools = [
        {
          functionDeclarations: [
            {
              name: 'edge',
              description: 'edge',
              parametersJsonSchema: { type: 'object', properties: {} },
            },
          ],
        },
      ] as Tool[];

      const result = await converter.convertGeminiToolsToAnthropic(tools);
      expect(result[0]?.input_schema?.type).toBe('object');
    });
  });

  describe('convertAnthropicResponseToGemini', () => {
    it('converts text, tool_use, thinking, and redacted_thinking blocks', () => {
      const response = converter.convertAnthropicResponseToGemini({
        id: 'msg-1',
        model: 'claude-test',
        stop_reason: 'end_turn',
        content: [
          { type: 'thinking', thinking: 'thought', signature: 'sig' },
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 't1', name: 'tool', input: { x: 1 } },
          { type: 'redacted_thinking' },
        ],
        usage: { input_tokens: 3, output_tokens: 5 },
      } as unknown as Anthropic.Message);

      expect(response.responseId).toBe('msg-1');
      expect(response.modelVersion).toBe('claude-test');
      expect(response.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
      expect(response.usageMetadata).toEqual({
        promptTokenCount: 3,
        candidatesTokenCount: 5,
        totalTokenCount: 8,
      });

      const parts = response.candidates?.[0]?.content?.parts || [];
      expect(parts).toEqual([
        { text: 'thought', thought: true, thoughtSignature: 'sig' },
        { text: 'hello' },
        { functionCall: { id: 't1', name: 'tool', args: { x: 1 } } },
        { text: '', thought: true },
      ]);
    });

    it('handles tool_use input that is a JSON string', () => {
      const response = converter.convertAnthropicResponseToGemini({
        id: 'msg-1',
        model: 'claude-test',
        stop_reason: null,
        content: [
          { type: 'tool_use', id: 't1', name: 'tool', input: '{"x":1}' },
        ],
      } as unknown as Anthropic.Message);

      const parts = response.candidates?.[0]?.content?.parts || [];
      expect(parts).toEqual([
        { functionCall: { id: 't1', name: 'tool', args: { x: 1 } } },
      ]);
    });
  });

  describe('mapAnthropicFinishReasonToGemini', () => {
    it('maps known reasons', () => {
      expect(converter.mapAnthropicFinishReasonToGemini('end_turn')).toBe(
        FinishReason.STOP,
      );
      expect(converter.mapAnthropicFinishReasonToGemini('max_tokens')).toBe(
        FinishReason.MAX_TOKENS,
      );
      expect(converter.mapAnthropicFinishReasonToGemini('content_filter')).toBe(
        FinishReason.SAFETY,
      );
    });

    it('returns undefined for null/empty', () => {
      expect(converter.mapAnthropicFinishReasonToGemini(null)).toBeUndefined();
      expect(converter.mapAnthropicFinishReasonToGemini('')).toBeUndefined();
    });
  });
});
