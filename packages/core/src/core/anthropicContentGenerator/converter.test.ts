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

      expect(system).toEqual([
        {
          type: 'text',
          text: 'sys',
          cache_control: { type: 'ephemeral' },
        },
      ]);
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

      expect(system).toEqual([
        {
          type: 'text',
          text: 'a\nb',
          cache_control: { type: 'ephemeral' },
        },
      ]);
    });

    it('emits scope:"global" on the system text when useGlobalCacheScope is set', () => {
      // Anthropic-native + caching enabled → generator passes
      // `useGlobalCacheScope: true` and the system prefix participates in
      // cross-session caching under the `prompt-caching-scope-2026-01-05`
      // beta. Non-Anthropic backends pass false (or omit) so they see the
      // standard per-session shape verified by the test above.
      const { system } = converter.convertGeminiRequestToAnthropic(
        {
          model: 'models/test',
          contents: 'hi',
          config: { systemInstruction: 'sys' },
        },
        { useGlobalCacheScope: true },
      );

      expect(system).toEqual([
        {
          type: 'text',
          text: 'sys',
          cache_control: { type: 'ephemeral', scope: 'global' },
        },
      ]);
    });

    it('converts a plain string content into a user message', () => {
      const { messages } = converter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: 'Hello',
      });

      expect(messages).toEqual([
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Hello',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
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
            {
              type: 'text',
              text: 'World',
              cache_control: { type: 'ephemeral' },
            },
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
              cache_control: { type: 'ephemeral' },
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
            cache_control: { type: 'ephemeral' },
          },
        ],
      });
    });

    it('creates tool result with empty content for empty function responses', () => {
      const { messages } = converter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call-1',
                  name: 'read_file',
                  response: { output: '' },
                },
              },
            ],
          },
        ],
      });

      // Should create a tool result with empty string content
      // This is required because Anthropic API expects every tool use to have a corresponding result
      expect(messages[0]).toEqual({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: '',
            cache_control: { type: 'ephemeral' },
          },
        ],
      });
    });

    it('converts function response with inlineData image parts into tool_result with images', () => {
      const { messages } = converter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call-1',
                  name: 'Read',
                  response: { output: 'Image content' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'image/png',
                        data: 'base64encodeddata',
                      },
                    },
                  ],
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
              content: [
                { type: 'text', text: 'Image content' },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'base64encodeddata',
                  },
                },
              ],
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ]);
    });

    it('renders non-image inlineData as a text block (avoids invalid image media_type)', () => {
      const { messages } = converter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call-1',
                  name: 'Read',
                  response: { output: 'Audio content' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'audio/mpeg',
                        data: 'base64encodedaudiodata',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe('user');

      const toolResult = messages[0]?.content?.[0] as {
        type: string;
        content: Array<{ type: string; text?: string }>;
      };
      expect(toolResult.type).toBe('tool_result');
      expect(Array.isArray(toolResult.content)).toBe(true);
      expect(toolResult.content[0]).toEqual({
        type: 'text',
        text: 'Audio content',
      });
      expect(toolResult.content[1]?.type).toBe('text');
      expect(toolResult.content[1]?.text).toContain(
        'Unsupported inline media type',
      );
      expect(toolResult.content[1]?.text).toContain('audio/mpeg');
    });

    it('converts inlineData with PDF into document block', () => {
      const { messages } = converter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call-1',
                  name: 'Read',
                  response: { output: 'PDF content' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'application/pdf',
                        data: 'pdfbase64data',
                      },
                    },
                  ],
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
              content: [
                { type: 'text', text: 'PDF content' },
                {
                  type: 'document',
                  source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: 'pdfbase64data',
                  },
                },
              ],
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ]);
    });

    it('converts fileData with image into image url block', () => {
      const { messages } = converter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call-1',
                  name: 'Read',
                  response: { output: 'Image content' },
                  parts: [
                    {
                      fileData: {
                        mimeType: 'image/jpeg',
                        fileUri:
                          'https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg',
                      },
                    },
                  ],
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
              content: [
                { type: 'text', text: 'Image content' },
                {
                  type: 'image',
                  source: {
                    type: 'url',
                    url: 'https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg',
                  },
                },
              ],
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ]);
    });

    it('converts fileData with PDF into document url block', () => {
      const { messages } = converter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call-1',
                  name: 'Read',
                  response: { output: 'PDF content' },
                  parts: [
                    {
                      fileData: {
                        mimeType: 'application/pdf',
                        fileUri:
                          'https://assets.anthropic.com/m/1cd9d098ac3e6467/original/Claude-3-Model-Card-October-Addendum.pdf',
                      },
                    },
                  ],
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
              content: [
                { type: 'text', text: 'PDF content' },
                {
                  type: 'document',
                  source: {
                    type: 'url',
                    url: 'https://assets.anthropic.com/m/1cd9d098ac3e6467/original/Claude-3-Model-Card-October-Addendum.pdf',
                  },
                },
              ],
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ]);
    });

    it('renders unsupported fileData as a text block', () => {
      const { messages } = converter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call-1',
                  name: 'Read',
                  response: { output: 'File content' },
                  parts: [
                    {
                      fileData: {
                        mimeType: 'application/zip',
                        fileUri: 'https://example.com/archive.zip',
                        displayName: 'archive.zip',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      const toolResult = messages[0]?.content?.[0] as {
        type: string;
        content: Array<{ type: string; text?: string }>;
      };
      expect(toolResult.type).toBe('tool_result');
      expect(toolResult.content[0]).toEqual({
        type: 'text',
        text: 'File content',
      });
      expect(toolResult.content[1]?.type).toBe('text');
      expect(toolResult.content[1]?.text).toContain(
        'Unsupported file media type',
      );
      expect(toolResult.content[1]?.text).toContain('application/zip');
      expect(toolResult.content[1]?.text).toContain('archive.zip');
    });

    it('associates each image with its preceding functionResponse', () => {
      const { messages } = converter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'user',
            parts: [
              // Tool 1 with image 1
              {
                functionResponse: {
                  id: 'call-1',
                  name: 'Read',
                  response: { output: 'File 1' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'image/png',
                        data: 'image1data',
                      },
                    },
                  ],
                },
              },
              // Tool 2 with image 2
              {
                functionResponse: {
                  id: 'call-2',
                  name: 'Read',
                  response: { output: 'File 2' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'image/jpeg',
                        data: 'image2data',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      // Multiple tool_result blocks are emitted in order
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: [
              { type: 'text', text: 'File 1' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'image1data',
                },
              },
            ],
          },
          {
            type: 'tool_result',
            tool_use_id: 'call-2',
            content: [
              { type: 'text', text: 'File 2' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: 'image2data',
                },
              },
            ],
            cache_control: { type: 'ephemeral' },
          },
        ],
      });
    });
  });

  // https://github.com/QwenLM/qwen-code/issues/3786 — DeepSeek's
  // anthropic-compatible API rejects requests in thinking mode when a prior
  // assistant turn carrying `tool_use` omits a thinking block. Plain-text
  // assistant turns without thinking are accepted unchanged, so the converter
  // injects an empty thinking block only on tool-use turns when the caller
  // opts in.
  describe('DeepSeek thinking-mode normalization, injection, and stripping', () => {
    // The two options paired together replicate the DeepSeek "thinking on"
    // behavior wired in AnthropicContentGenerator.buildRequest.
    const enableThinking = {
      normalizeAssistantThinkingSignature: true,
      injectThinkingOnToolUseTurns: true,
    };

    it('does not inject on plain-text assistant turns (DeepSeek tolerates them)', () => {
      // Verified against api.deepseek.com/anthropic: plain-text assistant
      // turns without thinking are accepted. Avoid bloating replay history
      // with synthetic blocks the API does not require.
      const { messages } = converter.convertGeminiRequestToAnthropic(
        {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Hi' }] },
            { role: 'model', parts: [{ text: 'Hello!' }] },
          ],
        },
        enableThinking,
      );

      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
      });
    });

    it('injects an empty thinking block on tool-calling assistant turns missing one', () => {
      const { messages } = converter.convertGeminiRequestToAnthropic(
        {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'List files' }] },
            {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'call-1',
                    name: 'glob',
                    args: { pattern: '**/*.md' },
                  },
                },
              ],
            },
          ],
        },
        enableThinking,
      );

      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: '' },
          {
            type: 'tool_use',
            id: 'call-1',
            name: 'glob',
            input: { pattern: '**/*.md' },
          },
        ],
      });
    });

    it('preserves existing thinking blocks on tool-use assistant turns', () => {
      const { messages } = converter.convertGeminiRequestToAnthropic(
        {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Run tool' }] },
            {
              role: 'model',
              parts: [
                {
                  text: 'Let me think',
                  thought: true,
                  thoughtSignature: 'sig',
                },
                { functionCall: { id: 't1', name: 'tool', args: {} } },
              ],
            },
          ],
        },
        enableThinking,
      );

      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think', signature: 'sig' },
          { type: 'tool_use', id: 't1', name: 'tool', input: {} },
        ],
      });
    });

    it('does not modify user messages', () => {
      const { messages } = converter.convertGeminiRequestToAnthropic(
        {
          model: 'models/test',
          contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
        },
        enableThinking,
      );

      expect(messages).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hi', cache_control: { type: 'ephemeral' } },
          ],
        },
      ]);
    });

    it('does nothing when option is disabled (default)', () => {
      const { messages } = converter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
          { role: 'model', parts: [{ text: 'Hello!' }] },
        ],
      });

      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
      });
    });

    it('injects thinking blocks on every tool-using assistant turn in a multi-turn history', () => {
      const toolUse = (id: string) => ({
        functionCall: { id, name: 'tool', args: {} },
      });
      const toolResult = (id: string) => ({
        functionResponse: { id, name: 'tool', response: { output: 'ok' } },
      });

      const { messages } = converter.convertGeminiRequestToAnthropic(
        {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Q1' }] },
            { role: 'model', parts: [toolUse('t1')] },
            { role: 'user', parts: [toolResult('t1')] },
            { role: 'model', parts: [toolUse('t2')] },
            { role: 'user', parts: [toolResult('t2')] },
          ],
        },
        enableThinking,
      );

      expect(messages[1]).toMatchObject({ role: 'assistant' });
      expect(messages[3]).toMatchObject({ role: 'assistant' });
      expect((messages[1] as { content: unknown[] }).content[0]).toEqual({
        type: 'thinking',
        thinking: '',
        signature: '',
      });
      expect((messages[3] as { content: unknown[] }).content[0]).toEqual({
        type: 'thinking',
        thinking: '',
        signature: '',
      });
    });

    it('preserves thinking-only assistant turns rather than emit empty content (Anthropic rejects content: [])', () => {
      // A turn whose only blocks are thinking/redacted_thinking can occur
      // when a previous round was cut off by max_tokens before any text or
      // tool_use was emitted. Stripping unconditionally would leave
      // `content: []`, which Anthropic API rejects, and dropping the message
      // would break user/assistant alternation. Keep the original blocks
      // instead — DeepSeek empirically tolerates the residual mismatch.
      const { messages } = converter.convertGeminiRequestToAnthropic(
        {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Hi' }] },
            {
              role: 'model',
              parts: [
                {
                  text: 'pondering',
                  thought: true,
                  thoughtSignature: 'sig',
                },
              ],
            },
            { role: 'user', parts: [{ text: 'Continue' }] },
          ],
        },
        { stripAssistantThinking: true },
      );

      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'pondering', signature: 'sig' },
        ],
      });
    });

    it('strips thinking blocks from assistant turns when stripAssistantThinking is set', () => {
      // suggestionGenerator / forkedAgent path: history has real thought
      // parts but the side-query disables thinking. The converter must drop
      // those blocks so the outgoing request matches the absent top-level
      // `thinking` config.
      const { messages } = converter.convertGeminiRequestToAnthropic(
        {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Hi' }] },
            {
              role: 'model',
              parts: [
                {
                  text: 'reasoning',
                  thought: true,
                  thoughtSignature: 'sig',
                },
                { text: 'Hello!' },
              ],
            },
            {
              role: 'model',
              parts: [
                { text: 'more reasoning', thought: true },
                { functionCall: { id: 't1', name: 'tool', args: {} } },
              ],
            },
          ],
        },
        { stripAssistantThinking: true },
      );

      // Both assistant turns have their thinking blocks removed.
      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
      });
      expect(messages[2]).toEqual({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'tool', input: {} }],
      });
    });

    it('strips redacted_thinking blocks too when stripAssistantThinking is set', () => {
      // The strip path must cover both `thinking` and `redacted_thinking`.
      // processContent doesn't synthesize redacted_thinking from Gemini parts,
      // so reach into the private helper directly with a constructed message.
      const messages = [
        {
          role: 'assistant' as const,
          content: [
            { type: 'redacted_thinking', data: 'opaque' },
            { type: 'text', text: 'Hello!' },
            { type: 'thinking', thinking: 'reasoning', signature: 'sig' },
          ],
        },
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (converter as any).stripThinkingFromAssistantMessages(messages);

      expect(messages[0].content).toEqual([{ type: 'text', text: 'Hello!' }]);
    });

    it('treats a redacted_thinking block as already-satisfying (no synthetic injection)', () => {
      // redacted_thinking has no `signature` field by spec — its `data` is
      // the opaque token. Distinct from a non-compliant `thinking` block
      // missing its required signature. The injector must leave redacted
      // turns alone. processContent doesn't synthesize redacted_thinking
      // from Gemini parts, so reach into the private helper directly.
      const messages = [
        {
          role: 'assistant' as const,
          content: [
            { type: 'redacted_thinking', data: 'opaque' },
            { type: 'tool_use', id: 't1', name: 'tool', input: {} },
          ],
        },
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (converter as any).injectEmptyThinkingOnToolUseTurns(messages);

      expect(messages[0].content).toEqual([
        { type: 'redacted_thinking', data: 'opaque' },
        { type: 'tool_use', id: 't1', name: 'tool', input: {} },
      ]);
    });

    it('normalizes a non-compliant thinking block (no signature field) on a tool-use turn', () => {
      // A part `{ text: '', thought: true }` (e.g. round-tripped from a
      // `redacted_thinking` response that lost its `data` field via the
      // Gemini Part representation) converts to a thinking block without a
      // `signature` field. The cleanup adds an empty signature in place;
      // because the normalized block now satisfies the requirement, Step 2
      // does not prepend a synthetic.
      const { messages } = converter.convertGeminiRequestToAnthropic(
        {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Run tool' }] },
            {
              role: 'model',
              parts: [
                { text: '', thought: true },
                { functionCall: { id: 't1', name: 'tool', args: {} } },
              ],
            },
          ],
        },
        enableThinking,
      );

      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: '' },
          { type: 'tool_use', id: 't1', name: 'tool', input: {} },
        ],
      });
    });

    it('preserves an existing compliant thinking block on a tool-use turn', () => {
      // A thinking block with a real `signature` field is fully compliant —
      // the injector must not duplicate it.
      const { messages } = converter.convertGeminiRequestToAnthropic(
        {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Run tool' }] },
            {
              role: 'model',
              parts: [
                {
                  text: 'real thinking',
                  thought: true,
                  thoughtSignature: 'real-sig',
                },
                { functionCall: { id: 't1', name: 'tool', args: {} } },
              ],
            },
          ],
        },
        enableThinking,
      );

      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'real thinking',
            signature: 'real-sig',
          },
          { type: 'tool_use', id: 't1', name: 'tool', input: {} },
        ],
      });
    });

    it('normalizes non-compliant thinking blocks (adds empty signature) on plain-text turns', () => {
      // A part `{ thought: true, text: '...' }` (the normal shape from
      // OpenAI/Gemini/agent-runtime where users may switch providers
      // mid-session, or a `redacted_thinking` round-tripped through Gemini-
      // Part) converts to `{ type: 'thinking', thinking: '...' }` without
      // signature. The cleanup adds an empty signature in place to make the
      // block spec-compliant while preserving the original thinking text.
      // No synthetic is prepended on a plain-text turn (no tool_use).
      const { messages } = converter.convertGeminiRequestToAnthropic(
        {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Hi' }] },
            {
              role: 'model',
              parts: [
                { text: 'cross-provider thoughts', thought: true },
                { text: 'Hello!' },
              ],
            },
          ],
        },
        enableThinking,
      );

      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'cross-provider thoughts',
            signature: '',
          },
          { type: 'text', text: 'Hello!' },
        ],
      });
    });

    it('injects on mixed text+tool_use assistant turns missing thinking', () => {
      // Common shape: model says something, then calls a tool. With no
      // thinking, this is still a tool-use turn that needs the synthetic.
      const { messages } = converter.convertGeminiRequestToAnthropic(
        {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Look this up' }] },
            {
              role: 'model',
              parts: [
                { text: 'Let me check that' },
                { functionCall: { id: 't1', name: 'lookup', args: {} } },
              ],
            },
          ],
        },
        enableThinking,
      );

      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: '' },
          { type: 'text', text: 'Let me check that' },
          { type: 'tool_use', id: 't1', name: 'lookup', input: {} },
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
        cache_control: { type: 'ephemeral' },
      });

      expect(vi.mocked(convertSchema)).toHaveBeenCalledTimes(1);
    });

    it('emits scope:"global" on the last tool when useGlobalCacheScope is set', async () => {
      // Mirror of the system-block scope test: cross-session caching for
      // tools (the largest, slowest-changing prefix) only fires for
      // Anthropic-native baseURLs. The generator latches the predicate
      // once per request and forwards the same value here.
      const tools = [
        {
          functionDeclarations: [
            { name: 'get_weather', description: 'Get weather' },
          ],
        },
      ] as Tool[];

      const result = await converter.convertGeminiToolsToAnthropic(tools, {
        useGlobalCacheScope: true,
      });

      expect(result[0].cache_control).toEqual({
        type: 'ephemeral',
        scope: 'global',
      });
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
        cache_control: { type: 'ephemeral' },
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

    it('skips functions without name or description', async () => {
      const tools = [
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
            {
              // neither name nor description
              parametersJsonSchema: { type: 'object' },
            },
          ],
        },
      ] as Tool[];

      const result = await converter.convertGeminiToolsToAnthropic(tools);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('valid_tool');
    });

    it('skips functions with empty name or description', async () => {
      const tools = [
        {
          functionDeclarations: [
            {
              name: 'valid_tool',
              description: 'A valid tool',
            },
            {
              name: '',
              description: 'Empty name',
            },
            {
              name: 'empty_description',
              description: '',
            },
          ],
        },
      ] as Tool[];

      const result = await converter.convertGeminiToolsToAnthropic(tools);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('valid_tool');
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
        cachedContentTokenCount: 0,
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

    it('forwards cache_read_input_tokens and cache_creation_input_tokens through to usageMetadata', () => {
      // A real Anthropic mid-conversation response carries all three prompt
      // buckets simultaneously: `input_tokens` (the non-cached tail),
      // `cache_read_input_tokens` (the warm prefix served from cache), and
      // `cache_creation_input_tokens` (the new region being written). The
      // converter must forward both cache fields so the normalizer can sum
      // them — dropping either silently undercounts the Footer reading by
      // the size of the dropped bucket.
      const response = converter.convertAnthropicResponseToGemini({
        id: 'msg-1',
        model: 'claude-test',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          input_tokens: 2_500,
          cache_read_input_tokens: 32_088,
          cache_creation_input_tokens: 8_700,
          output_tokens: 400,
        },
      } as unknown as Anthropic.Message);

      expect(response.usageMetadata).toEqual({
        promptTokenCount: 43_288,
        candidatesTokenCount: 400,
        totalTokenCount: 43_688,
        cachedContentTokenCount: 32_088,
      });
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

  describe('enableCacheControl', () => {
    it('does not add cache_control to system when disabled', () => {
      const noCacheConverter = new AnthropicContentConverter(
        'test-model',
        'auto',
        false,
      );
      const { system } = noCacheConverter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: 'hi',
        config: { systemInstruction: 'sys' },
      });

      expect(system).toBe('sys');
    });

    it('does not add cache_control to messages when disabled', () => {
      const noCacheConverter = new AnthropicContentConverter(
        'test-model',
        'auto',
        false,
      );
      const { messages } = noCacheConverter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: 'Hello',
      });

      expect(messages).toEqual([
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
        },
      ]);
    });

    it('marks the last user message with cache_control when its last block is tool_result', () => {
      // Regression: in agentic loops the last user message is typically a
      // tool_result, not a text block. An earlier guard required the last
      // block to be text, which silently dropped the per-turn cache
      // breakpoint from turn 2 onward and collapsed the cacheable region
      // back to system+tools. Anthropic docs explicitly list tool_result
      // as a cacheable block type in messages.content.
      const { messages } = converter.convertGeminiRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'do the thing' }] },
          {
            role: 'model',
            parts: [{ functionCall: { id: 'c1', name: 't', args: {} } }],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'c1',
                  name: 't',
                  response: { output: 'done' },
                },
              },
            ],
          },
        ],
      });

      const lastUser = messages[messages.length - 1];
      expect(lastUser.role).toBe('user');
      const content = Array.isArray(lastUser.content) ? lastUser.content : [];
      const lastBlock = content[content.length - 1] as {
        type: string;
        cache_control?: { type: string };
      };
      expect(lastBlock.type).toBe('tool_result');
      expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('does not add cache_control to tools when disabled', async () => {
      const noCacheConverter = new AnthropicContentConverter(
        'test-model',
        'auto',
        false,
      );
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

      const result =
        await noCacheConverter.convertGeminiToolsToAnthropic(tools);

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
      expect(result[0]).not.toHaveProperty('cache_control');
    });

    describe('per-call options override constructor default', () => {
      // The generator latches `contentGeneratorConfig.enableCacheControl`
      // per request and forwards the live value to the converter, so a
      // `Config.setModel()` flip is reflected without rebuilding the
      // converter. These tests exercise the override directly so the
      // contract is pinned at the converter level too.
      const tools = [
        {
          functionDeclarations: [
            { name: 'get_weather', description: 'Get weather' },
          ],
        },
      ] as Tool[];

      it('overrides constructor false → true for system + messages + tools', async () => {
        const constructedWithCacheOff = new AnthropicContentConverter(
          'test-model',
          'auto',
          false,
        );

        const { system, messages } =
          constructedWithCacheOff.convertGeminiRequestToAnthropic(
            {
              model: 'models/test',
              contents: 'Hello',
              config: { systemInstruction: 'sys' },
            },
            { enableCacheControl: true, useGlobalCacheScope: true },
          );

        expect(system).toEqual([
          {
            type: 'text',
            text: 'sys',
            cache_control: { type: 'ephemeral', scope: 'global' },
          },
        ]);
        // Last user-text block gets per-session cache_control (no scope).
        expect(messages).toEqual([
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Hello',
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
        ]);

        const result =
          await constructedWithCacheOff.convertGeminiToolsToAnthropic(tools, {
            enableCacheControl: true,
            useGlobalCacheScope: true,
          });
        expect(result[0].cache_control).toEqual({
          type: 'ephemeral',
          scope: 'global',
        });
      });

      it('overrides constructor true → false (cache fully off)', async () => {
        // Default ctor: enableCacheControl true. Per-call override flips to
        // false, mirroring a runtime `setModel()` that switches into a
        // cache-disabled provider config.
        const constructedWithCacheOn = new AnthropicContentConverter(
          'test-model',
          'auto',
          true,
        );

        const { system, messages } =
          constructedWithCacheOn.convertGeminiRequestToAnthropic(
            {
              model: 'models/test',
              contents: 'Hello',
              config: { systemInstruction: 'sys' },
            },
            { enableCacheControl: false },
          );

        expect(system).toBe('sys');
        expect(messages).toEqual([
          { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        ]);

        const result =
          await constructedWithCacheOn.convertGeminiToolsToAnthropic(tools, {
            enableCacheControl: false,
          });
        expect(result[0]).not.toHaveProperty('cache_control');
      });

      it('honors useGlobalCacheScope independently of enableCacheControl source', async () => {
        // Cache on (per-call), scope off (per-call default). Verify the
        // emitted shape is per-session even though cache_control IS
        // attached — non-Anthropic baseURL behavior in one call.
        const converterDefault = new AnthropicContentConverter(
          'test-model',
          'auto',
        );
        const { system } = converterDefault.convertGeminiRequestToAnthropic(
          {
            model: 'models/test',
            contents: 'Hello',
            config: { systemInstruction: 'sys' },
          },
          {
            enableCacheControl: true /* useGlobalCacheScope omitted → false */,
          },
        );
        expect(system).toEqual([
          {
            type: 'text',
            text: 'sys',
            cache_control: { type: 'ephemeral' },
          },
        ]);

        const result = await converterDefault.convertGeminiToolsToAnthropic(
          tools,
          { enableCacheControl: true },
        );
        expect(result[0].cache_control).toEqual({ type: 'ephemeral' });
      });
    });
  });
});
