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
import { getGenAiUsageProvenance } from '../../telemetry/gen-ai-usage.js';

describe('AnthropicContentConverter', () => {
  let converter: AnthropicContentConverter;

  beforeEach(() => {
    vi.clearAllMocks();
    converter = new AnthropicContentConverter('test-model', 'auto');
  });

  describe('convertLlmRequestToAnthropic', () => {
    it('extracts systemInstruction text from string', () => {
      const { system } = converter.convertLlmRequestToAnthropic({
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
      const { system } = converter.convertLlmRequestToAnthropic({
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
      const { system } = converter.convertLlmRequestToAnthropic(
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

    describe('staticSystemPrefix split', () => {
      const staticPrefix = 'core prompt + memory';
      const volatileSuffix = '\n\n# Git Status\nbranch: main';
      const fullSystem = staticPrefix + volatileSuffix;

      it('splits the system prompt at the static prefix boundary, scoping only the prefix', () => {
        const { system } = converter.convertLlmRequestToAnthropic(
          {
            model: 'models/test',
            contents: 'hi',
            config: { systemInstruction: fullSystem },
          },
          { useGlobalCacheScope: true, staticSystemPrefix: staticPrefix },
        );

        expect(system).toEqual([
          {
            type: 'text',
            text: staticPrefix,
            cache_control: { type: 'ephemeral', scope: 'global' },
          },
          {
            // The volatile tail (git status, session-start context) always
            // carries the per-session shape — it differs across sessions,
            // so a global entry here would churn cache for zero hits.
            type: 'text',
            text: volatileSuffix,
            cache_control: { type: 'ephemeral' },
          },
        ]);
      });

      it('splits without scope when useGlobalCacheScope is off', () => {
        const { system } = converter.convertLlmRequestToAnthropic(
          {
            model: 'models/test',
            contents: 'hi',
            config: { systemInstruction: fullSystem },
          },
          { staticSystemPrefix: staticPrefix },
        );

        expect(system).toEqual([
          {
            type: 'text',
            text: staticPrefix,
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'text',
            text: volatileSuffix,
            cache_control: { type: 'ephemeral' },
          },
        ]);
      });

      it('falls back to a single block when the prefix does not match (subagent prompt)', () => {
        const { system } = converter.convertLlmRequestToAnthropic(
          {
            model: 'models/test',
            contents: 'hi',
            config: { systemInstruction: 'a different subagent prompt' },
          },
          { useGlobalCacheScope: true, staticSystemPrefix: staticPrefix },
        );

        expect(system).toEqual([
          {
            type: 'text',
            text: 'a different subagent prompt',
            cache_control: { type: 'ephemeral', scope: 'global' },
          },
        ]);
      });

      it('falls back to a single block when there is no suffix beyond the prefix', () => {
        // Not a git repo → the system prompt IS the static prefix. A split
        // would leave an empty second block, which Anthropic rejects.
        const { system } = converter.convertLlmRequestToAnthropic(
          {
            model: 'models/test',
            contents: 'hi',
            config: { systemInstruction: staticPrefix },
          },
          { useGlobalCacheScope: true, staticSystemPrefix: staticPrefix },
        );

        expect(system).toEqual([
          {
            type: 'text',
            text: staticPrefix,
            cache_control: { type: 'ephemeral', scope: 'global' },
          },
        ]);
      });
    });

    it('converts a plain string content into a user message', () => {
      const { messages } = converter.convertLlmRequestToAnthropic({
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
      const { messages } = converter.convertLlmRequestToAnthropic({
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

    it('preserves ordered multi-part startup reminder user content', () => {
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'user',
            parts: [
              { text: '<system-reminder>\ndeferred tools' },
              { text: '<system-reminder>\nstartup context' },
            ],
          },
        ],
      });

      expect(messages).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: '<system-reminder>\ndeferred tools' },
            {
              type: 'text',
              text: '<system-reminder>\nstartup context',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ]);
    });

    it('converts assistant thought parts into Anthropic thinking blocks', () => {
      const { messages } = converter.convertLlmRequestToAnthropic({
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
      const { messages } = converter.convertLlmRequestToAnthropic({
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

      expect(messages[0]).toEqual({
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
      });
    });

    it('normalizes legacy dotted MCP names before sending history', () => {
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call-legacy-mcp',
                  name: 'mcp__zybio__database.query_uniprot',
                  args: { query: 'P12345' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call-legacy-mcp',
                  name: 'mcp__zybio__database.query_uniprot',
                  response: { output: 'ok' },
                },
              },
            ],
          },
        ],
      });
      const assistant = messages[0];
      const toolUse = Array.isArray(assistant?.content)
        ? assistant.content.find((block) => block.type === 'tool_use')
        : undefined;

      expect(toolUse?.type).toBe('tool_use');
      if (toolUse?.type === 'tool_use') {
        expect(toolUse.name).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
        expect(toolUse.name).not.toContain('.');
      }
    });

    it('converts functionResponse parts into user tool_result messages', () => {
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call-1',
                  name: 'tool_name',
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
                  id: 'call-1',
                  name: 'tool_name',
                  response: { output: 'ok' },
                },
              },
            ],
          },
        ],
      });

      expect(messages[1]).toEqual({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: 'ok',
            cache_control: { type: 'ephemeral' },
          },
        ],
      });
    });

    it('extracts function response error field when present', () => {
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call-1',
                  name: 'tool_name',
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
                  id: 'call-1',
                  name: 'tool_name',
                  response: { error: 'boom' },
                },
              },
            ],
          },
        ],
      });

      expect(messages[1]).toEqual({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: 'boom',
            is_error: true,
            cache_control: { type: 'ephemeral' },
          },
        ],
      });
    });

    it('creates tool result with empty content for empty function responses', () => {
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call-1',
                  name: 'read_file',
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
      expect(messages[1]).toEqual({
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
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call-1',
                  name: 'Read',
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

      expect(messages[1]).toEqual({
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
      });
    });

    it.each(['audio/mpeg', 'image/bmp'])(
      'renders unsupported %s inlineData as a text block',
      (mimeType) => {
        const { messages } = converter.convertLlmRequestToAnthropic({
          model: 'models/test',
          contents: [
            {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'call-1',
                    name: 'Read',
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
                    id: 'call-1',
                    name: 'Read',
                    response: { output: 'Unsupported content' },
                    parts: [
                      {
                        inlineData: {
                          mimeType,
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

        expect(messages).toHaveLength(2);
        expect(messages[1]?.role).toBe('user');

        const toolResult = messages[1]?.content?.[0] as {
          type: string;
          content: Array<{ type: string; text?: string }>;
        };
        expect(toolResult.type).toBe('tool_result');
        expect(Array.isArray(toolResult.content)).toBe(true);
        expect(toolResult.content[0]).toEqual({
          type: 'text',
          text: 'Unsupported content',
        });
        expect(toolResult.content[1]?.type).toBe('text');
        expect(toolResult.content[1]?.text).toContain(
          'Unsupported inline media type',
        );
        expect(toolResult.content[1]?.text).toContain(mimeType);
      },
    );

    it('converts inlineData with PDF into document block', () => {
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call-1',
                  name: 'Read',
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

      expect(messages[1]).toEqual({
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
      });
    });

    it('converts fileData with image into image url block', () => {
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call-1',
                  name: 'Read',
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

      expect(messages[1]).toEqual({
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
      });
    });

    it('converts fileData with PDF into document url block', () => {
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call-1',
                  name: 'Read',
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

      expect(messages[1]).toEqual({
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
      });
    });

    it('renders unsupported fileData as a text block', () => {
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call-1',
                  name: 'Read',
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

      const toolResult = messages[1]?.content?.[0] as {
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
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call-1',
                  name: 'Read',
                  args: {},
                },
              },
              {
                functionCall: {
                  id: 'call-2',
                  name: 'Read',
                  args: {},
                },
              },
            ],
          },
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
      expect(messages).toHaveLength(2);
      expect(messages[1]).toEqual({
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

    it('merges consecutive assistant messages into one', () => {
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
          { role: 'model', parts: [{ text: 'Hello!' }] },
          {
            role: 'model',
            parts: [{ functionCall: { id: 't1', name: 'tool', args: {} } }],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 't1',
                  name: 'tool',
                  response: { output: 'ok' },
                },
              },
            ],
          },
        ],
      });

      expect(messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Hello!' },
            { type: 'tool_use', id: 't1', name: 'tool', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: 'ok',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ]);
    });

    it('merges thinking blocks before non-thinking blocks', () => {
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
          {
            role: 'model',
            parts: [
              { text: 'thought A', thought: true, thoughtSignature: 'sigA' },
              { text: 'text A' },
            ],
          },
          {
            role: 'model',
            parts: [
              { text: 'thought B', thought: true, thoughtSignature: 'sigB' },
              { functionCall: { id: 't1', name: 'tool', args: {} } },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 't1',
                  name: 'tool',
                  response: { output: 'ok' },
                },
              },
            ],
          },
        ],
      });

      const assistant = messages[1];
      expect(assistant?.role).toBe('assistant');
      const blocks = assistant?.content as Array<{ type: string }>;
      expect(blocks[0]?.type).toBe('thinking');
      expect(blocks[1]?.type).toBe('thinking');
      expect(blocks[2]?.type).toBe('text');
      expect(blocks[3]?.type).toBe('tool_use');
    });

    it('cleans orphaned tool_use blocks without matching tool_result', () => {
      // A genuine orphan requires a subsequent message that was actually
      // scanned and found lacking a matching tool_result -- not merely the
      // absence of any subsequent message (see the "trailing tool_use"
      // test below for that case).
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
          {
            role: 'model',
            parts: [
              { text: 'Let me help' },
              { functionCall: { id: 'orphan', name: 'tool', args: {} } },
            ],
          },
          { role: 'user', parts: [{ text: 'never mind' }] },
        ],
      });

      expect(messages).toEqual([
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hi' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Let me help' }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'never mind',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ]);
    });

    it('does not strip a trailing tool_use that has no subsequent message yet (unresolved, not orphaned)', () => {
      // "History ends on a pending tool_use" is not evidence the call is
      // orphaned -- the tool may simply not have finished executing yet,
      // or this conversion may be happening for a reason other than
      // sending the completed turn to Anthropic (token counting, a
      // resumed/replayed session snapshot, ...). Regression test for the
      // bug where this exact shape had its tool_use silently deleted.
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'What is the weather in Paris?' }] },
          {
            role: 'model',
            parts: [
              { text: 'Let me check the weather.' },
              {
                functionCall: {
                  id: 'toolu_pending',
                  name: 'get_weather',
                  args: { city: 'Paris' },
                },
              },
            ],
          },
        ],
      });

      const lastMsg = messages[messages.length - 1];
      expect(lastMsg.role).toBe('assistant');
      expect(lastMsg.content).toEqual([
        { type: 'text', text: 'Let me check the weather.' },
        {
          type: 'tool_use',
          id: 'toolu_pending',
          name: 'get_weather',
          input: { city: 'Paris' },
        },
      ]);
    });

    it('cascade-strips a signed thinking block when its sibling tool_use is orphaned in the same pass', () => {
      // A thinking block's signature is computed over the full sibling
      // content of its turn. If a sibling tool_use is stripped as an
      // orphan, the signature no longer matches and replaying it 400s:
      // "thinking blocks in the latest assistant message cannot be
      // modified". So the thinking block must go with it.
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
          {
            role: 'model',
            parts: [
              { text: 'reasoning', thought: true, thoughtSignature: 'sig' },
              { text: 'Let me help' },
              { functionCall: { id: 'orphan', name: 'tool', args: {} } },
            ],
          },
          { role: 'user', parts: [{ text: 'never mind' }] },
        ],
      });

      const assistantMsg = messages.find((m) => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.content).toEqual([
        { type: 'text', text: 'Let me help' },
      ]);
    });

    it('does not cascade-strip thinking when a sibling tool_use survives alongside an orphaned one', () => {
      // Partial-orphan case: turn = [thinking, tool_use A, tool_use B],
      // only A's result comes back -- B is a genuine orphan and is
      // stripped, but A survives. The thinking sibling must stay too: it's
      // still needed to satisfy Anthropic's manual-mode "final turn must
      // begin with thinking when a tool_use is present" rule, and
      // cascading here would trade one 400 for another.
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
          {
            role: 'model',
            parts: [
              { text: 'reasoning', thought: true, thoughtSignature: 'sig' },
              { functionCall: { id: 'a', name: 'tool', args: {} } },
              { functionCall: { id: 'b', name: 'tool', args: {} } },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'a',
                  name: 'tool',
                  response: { output: 'ok' },
                },
              },
            ],
          },
        ],
      });

      const assistantMsg = messages.find((m) => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      const blocks = assistantMsg!.content as Array<{ type: string }>;
      expect(blocks[0]?.type).toBe('thinking');
      expect(blocks.some((b) => b.type === 'tool_use')).toBe(true);
      expect(blocks).toHaveLength(2);
    });

    it('drops the whole message and merges surrounding user turns when a cascade empties out the turn entirely', () => {
      // The bot review's flagged coverage gap: the only existing cascade
      // test leaves a surviving `text` block, so `finalBlocks` is never
      // empty and the `else` drop branch in cleanOrphanedToolCalls is
      // never exercised. Here the turn's only blocks are a signed thinking
      // part and an orphaned tool_use, so after the cascade strips both,
      // finalBlocks is empty and the whole assistant message must be
      // dropped -- and the surrounding user messages must merge.
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'before' }] },
          {
            role: 'model',
            parts: [
              { text: 'reasoning', thought: true, thoughtSignature: 'sig' },
              { functionCall: { id: 'orphan', name: 'tool', args: {} } },
            ],
          },
          { role: 'user', parts: [{ text: 'after' }] },
        ],
      });

      expect(messages.some((m) => m.role === 'assistant')).toBe(false);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.role).toBe('user');
      expect(messages[0]!.content).toEqual([
        { type: 'text', text: 'before' },
        {
          type: 'text',
          text: 'after',
          cache_control: { type: 'ephemeral' },
        },
      ]);
    });

    it('cleans orphaned tool_result blocks without matching tool_use', () => {
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
          { role: 'model', parts: [{ text: 'Hello' }] },
          {
            role: 'user',
            parts: [
              { text: 'extra' },
              {
                functionResponse: {
                  id: 'orphan',
                  name: 'tool',
                  response: { output: 'ok' },
                },
              },
            ],
          },
        ],
      });

      expect(messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'extra',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ]);
    });

    it('drops a duplicate tool_result sharing a tool_use_id within one message', () => {
      // Anthropic rejects a message with two tool_result blocks for the
      // same tool_use_id ("each `tool_use` block must have a single
      // result" -- HTTP 400). This can happen when a tool call's result
      // is recorded twice in history.
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
          {
            role: 'model',
            parts: [{ functionCall: { id: 'dup', name: 'tool', args: {} } }],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'dup',
                  name: 'tool',
                  response: { output: 'first' },
                },
              },
              {
                functionResponse: {
                  id: 'dup',
                  name: 'tool',
                  response: { output: 'second' },
                },
              },
            ],
          },
        ],
      });

      expect(messages).toHaveLength(3);
      const toolResults = (
        messages[2]!.content as Array<{ type: string; tool_use_id?: string }>
      ).filter((b) => b.type === 'tool_result');
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]).toMatchObject({
        tool_use_id: 'dup',
        content: 'first',
      });
    });

    it('drops a duplicate tool_result for one id while keeping a different id in the same message', () => {
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
          {
            role: 'model',
            parts: [
              { functionCall: { id: 'dup', name: 'tool', args: {} } },
              { functionCall: { id: 'other', name: 'tool', args: {} } },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'dup',
                  name: 'tool',
                  response: { output: 'first' },
                },
              },
              {
                functionResponse: {
                  id: 'dup',
                  name: 'tool',
                  response: { output: 'second' },
                },
              },
              {
                functionResponse: {
                  id: 'other',
                  name: 'tool',
                  response: { output: 'other-result' },
                },
              },
            ],
          },
        ],
      });

      const toolResults = (
        messages[2]?.content as Array<{
          type: string;
          tool_use_id?: string;
          content?: string;
        }>
      ).filter((b) => b.type === 'tool_result');
      expect(toolResults).toHaveLength(2);
      expect(toolResults.map((b) => [b.tool_use_id, b.content])).toEqual([
        ['dup', 'first'],
        ['other', 'other-result'],
      ]);
    });

    describe('tool_use id sanitization', () => {
      // Anthropic validates tool_use.id / tool_result.tool_use_id against
      // ^[a-zA-Z0-9_-]+$ server-side (HTTP 400 otherwise), but the Gemini
      // lingua-franca's functionCall.id / functionResponse.id has no such
      // constraint. Verified live: sending an id containing characters
      // outside that set, or an empty tool_use_id, both 400 with
      // "String should match pattern '^[a-zA-Z0-9_-]+$'".
      it('sanitizes a tool_use id containing characters outside [a-zA-Z0-9_-]', () => {
        const rawId = 'call:abc.def/ghi?jkl';
        const { messages } = converter.convertLlmRequestToAnthropic({
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Hi' }] },
            {
              role: 'model',
              parts: [
                {
                  functionCall: { id: rawId, name: 'tool', args: { a: 1 } },
                },
              ],
            },
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: rawId,
                    name: 'tool',
                    response: { output: 'ok' },
                  },
                },
              ],
            },
          ],
        });

        const assistantBlocks = messages[1]?.content as Array<{
          type: string;
          id?: string;
        }>;
        const userBlocks = messages[2]?.content as Array<{
          type: string;
          tool_use_id?: string;
        }>;
        const toolUse = assistantBlocks.find((b) => b.type === 'tool_use');
        const toolResult = userBlocks.find((b) => b.type === 'tool_result');

        expect(toolUse?.id).toMatch(/^[a-zA-Z0-9_-]+$/);
        expect(toolUse?.id).not.toBe(rawId);
        // The sanitized id links the pair back up.
        expect(toolResult?.tool_use_id).toBe(toolUse?.id);
      });

      it('generates a non-empty fallback id when functionCall.id is missing (not an empty string)', () => {
        const { messages } = converter.convertLlmRequestToAnthropic({
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Hi' }] },
            {
              role: 'model',
              parts: [{ functionCall: { name: 'tool', args: {} } }],
            },
          ],
        });

        const assistantBlocks = messages[1]?.content as Array<{
          type: string;
          id?: string;
        }>;
        const toolUse = assistantBlocks.find((b) => b.type === 'tool_use');
        expect(toolUse?.id).toBeTruthy();
        expect(toolUse?.id).toMatch(/^[a-zA-Z0-9_-]+$/);
      });

      // Note: there is no analogous standalone test for "functionResponse.id
      // missing" here -- a tool_result with no id can't be linked to any
      // tool_use by definition (which call is it responding to?), so it is
      // always a genuine orphan and gets cleaned up by cleanOrphanedToolCalls
      // regardless of this fix. tool_result.tool_use_id goes through the
      // exact same resolveToolUseId/nextGeneratedToolId path exercised by
      // the tool_use-side tests above, so the never-empty-string guarantee
      // is already covered.

      it('does not collide fallback ids generated for two different missing-id tool calls in the same request', () => {
        const { messages } = converter.convertLlmRequestToAnthropic({
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Hi' }] },
            {
              role: 'model',
              parts: [
                { functionCall: { name: 'tool_a', args: {} } },
                { functionCall: { name: 'tool_b', args: {} } },
              ],
            },
          ],
        });

        const assistantBlocks = messages[1]?.content as Array<{
          type: string;
          id?: string;
        }>;
        const ids = assistantBlocks
          .filter((b) => b.type === 'tool_use')
          .map((b) => b.id);
        expect(ids).toHaveLength(2);
        expect(new Set(ids).size).toBe(2);
      });

      it('resolves the same source id to the same sanitized id across tool_use and tool_result in different messages', () => {
        const rawId = 'weird/id:1';
        const { messages } = converter.convertLlmRequestToAnthropic({
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Hi' }] },
            {
              role: 'model',
              parts: [{ functionCall: { id: rawId, name: 'tool', args: {} } }],
            },
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: rawId,
                    name: 'tool',
                    response: { output: 'ok' },
                  },
                },
              ],
            },
          ],
        });

        const toolUseId = (
          messages[1]?.content as Array<{ type: string; id?: string }>
        ).find((b) => b.type === 'tool_use')?.id;
        const toolResultId = (
          messages[2]?.content as Array<{
            type: string;
            tool_use_id?: string;
          }>
        ).find((b) => b.type === 'tool_result')?.tool_use_id;

        expect(toolUseId).toBeDefined();
        expect(toolUseId).toBe(toolResultId);
      });
    });

    it('keeps tool results split across consecutive user messages', () => {
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
          {
            role: 'model',
            parts: [
              { functionCall: { id: 'x', name: 'tool', args: {} } },
              { functionCall: { id: 'y', name: 'tool', args: {} } },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'x',
                  name: 'tool',
                  response: { output: 'first' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'y',
                  name: 'tool',
                  response: { output: 'second' },
                },
              },
            ],
          },
        ],
      });

      expect(
        (messages[1]?.content as Array<{ id?: string; type: string }>).filter(
          (block) => block.type === 'tool_use',
        ),
      ).toHaveLength(2);
      expect(messages[2]).toEqual({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'x',
            content: 'first',
          },
          {
            type: 'tool_result',
            tool_use_id: 'y',
            content: 'second',
            cache_control: { type: 'ephemeral' },
          },
        ],
      });
    });

    it('drops a duplicate tool_result for the same id across two consecutive user messages', () => {
      // cleanOrphanedToolCalls only dedupes tool_result blocks within a
      // single message; mergeConsecutiveUserMessages runs afterward and
      // can combine two originally-separate user messages that each
      // independently carried a (individually valid) tool_result for the
      // same tool_use_id. Without a second dedup pass at the merge site,
      // the merged message would resurface the exact "two tool_result
      // blocks for one tool_use_id" shape Anthropic rejects.
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
          {
            role: 'model',
            parts: [{ functionCall: { id: 'dup', name: 'tool', args: {} } }],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'dup',
                  name: 'tool',
                  response: { output: 'first' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'dup',
                  name: 'tool',
                  response: { output: 'second' },
                },
              },
              { text: 'a follow-up note' },
            ],
          },
        ],
      });

      // Full merged content, not just the filtered tool_result blocks --
      // confirms the non-tool_result sibling from the second message
      // survives the merge and still sorts after the (deduped) results.
      expect(messages).toHaveLength(3);
      expect(messages[2]).toEqual({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'dup', content: 'first' },
          {
            type: 'text',
            text: 'a follow-up note',
            cache_control: { type: 'ephemeral' },
          },
        ],
      });
    });

    it('drops duplicate tool_result blocks across three consecutive user messages', () => {
      // Pins that the merge-site dedup accumulates across the whole
      // `combined` array on every iteration, not just pairwise between
      // the two most recently merged messages -- with three originally
      // separate user turns each carrying a tool_result for the same
      // tool_use_id, only the first should survive.
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
          {
            role: 'model',
            parts: [{ functionCall: { id: 'dup3', name: 'tool', args: {} } }],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'dup3',
                  name: 'tool',
                  response: { output: 'first' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'dup3',
                  name: 'tool',
                  response: { output: 'second' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'dup3',
                  name: 'tool',
                  response: { output: 'third' },
                },
              },
            ],
          },
        ],
      });

      expect(messages).toHaveLength(3);
      expect(messages[2]).toEqual({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'dup3',
            content: 'first',
            cache_control: { type: 'ephemeral' },
          },
        ],
      });
    });

    it('merges users when dropping an orphan-only assistant turn', () => {
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'before' }] },
          {
            role: 'model',
            parts: [{ functionCall: { id: 'orphan', name: 'tool', args: {} } }],
          },
          { role: 'user', parts: [{ text: 'after' }] },
        ],
      });

      expect(messages).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'before' },
            {
              type: 'text',
              text: 'after',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ]);
    });

    it('keeps tool results before text when merging consecutive users', () => {
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
          {
            role: 'model',
            parts: [{ functionCall: { id: 't1', name: 'tool', args: {} } }],
          },
          { role: 'user', parts: [{ text: 'preface' }] },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 't1',
                  name: 'tool',
                  response: { output: 'ok' },
                },
              },
            ],
          },
        ],
      });

      expect(messages[2]).toEqual({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'ok',
          },
          {
            type: 'text',
            text: 'preface',
            cache_control: { type: 'ephemeral' },
          },
        ],
      });
    });

    it('reorders a tool_result ahead of other content in the same message rather than dropping it', () => {
      // Anthropic requires tool_result to be the first content in a user
      // message replying to a tool_use. A text part preceding the
      // functionResponse part within the same Gemini Content used to be
      // treated by cleanOrphanedToolCalls's own "seenNonToolResult" gate as
      // if the tool_result never showed up at all -- silently discarding
      // both the tool_result AND its paired tool_use, rather than fixing
      // the order. Now the blocks are reordered before that gate runs, so
      // the pairing is recognized and everything survives.
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
          {
            role: 'model',
            parts: [{ functionCall: { id: 't1', name: 'tool', args: {} } }],
          },
          {
            role: 'user',
            parts: [
              { text: 'preface' },
              {
                functionResponse: {
                  id: 't1',
                  name: 'tool',
                  response: { output: 'late' },
                },
              },
            ],
          },
        ],
      });

      expect(messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'tool', input: {} }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'late' },
            {
              type: 'text',
              text: 'preface',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ]);
    });

    it('preserves relative order among multiple tool_result blocks when reordering ahead of text', () => {
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
          {
            role: 'model',
            parts: [
              { functionCall: { id: 't1', name: 'tool', args: {} } },
              { functionCall: { id: 't2', name: 'tool', args: {} } },
            ],
          },
          {
            role: 'user',
            parts: [
              { text: 'preface' },
              {
                functionResponse: {
                  id: 't1',
                  name: 'tool',
                  response: { output: 'first' },
                },
              },
              {
                functionResponse: {
                  id: 't2',
                  name: 'tool',
                  response: { output: 'second' },
                },
              },
            ],
          },
        ],
      });

      const lastMsg = messages[messages.length - 1];
      expect(lastMsg.content).toEqual([
        { type: 'tool_result', tool_use_id: 't1', content: 'first' },
        { type: 'tool_result', tool_use_id: 't2', content: 'second' },
        {
          type: 'text',
          text: 'preface',
          cache_control: { type: 'ephemeral' },
        },
      ]);
    });

    it('deduplicates tool_use blocks by id during merge', () => {
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
          {
            role: 'model',
            parts: [{ functionCall: { id: 'dup', name: 'tool', args: {} } }],
          },
          {
            role: 'model',
            parts: [{ functionCall: { id: 'dup', name: 'tool', args: {} } }],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'dup',
                  name: 'tool',
                  response: { output: 'ok' },
                },
              },
            ],
          },
        ],
      });

      const assistant = messages[1];
      const toolUseBlocks = (
        assistant?.content as Array<{ type: string }>
      ).filter((b) => b.type === 'tool_use');
      expect(toolUseBlocks).toHaveLength(1);
    });
  });

  describe('unsigned proxy thinking history', () => {
    it('drops unsigned thinking while preserving visible content and signed blocks', () => {
      const { messages } = converter.convertLlmRequestToAnthropic(
        {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'First' }] },
            {
              role: 'model',
              parts: [
                { text: 'unsigned', thought: true },
                {
                  text: 'empty signature',
                  thought: true,
                  thoughtSignature: '',
                },
                {
                  text: 'signed',
                  thought: true,
                  thoughtSignature: 'real-signature',
                },
                { text: 'Visible answer' },
              ],
            },
            { role: 'user', parts: [{ text: 'Second' }] },
          ],
        },
        {
          dropUnsignedAssistantThinking: true,
          enableCacheControl: false,
        },
      );

      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'signed',
            signature: 'real-signature',
          },
          { type: 'text', text: 'Visible answer' },
        ],
      });
    });

    it('drops a thinking-only turn and merges the surrounding user turns', () => {
      const { messages } = converter.convertLlmRequestToAnthropic(
        {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'First' }] },
            {
              role: 'model',
              parts: [{ text: 'unsigned', thought: true }],
            },
            { role: 'user', parts: [{ text: 'Second' }] },
          ],
        },
        {
          dropUnsignedAssistantThinking: true,
          enableCacheControl: false,
        },
      );

      expect(messages).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First' },
            { type: 'text', text: 'Second' },
          ],
        },
      ]);
    });

    it('fails locally when an unsigned thinking block belongs to a tool-use turn', () => {
      expect(() =>
        converter.convertLlmRequestToAnthropic(
          {
            model: 'models/test',
            contents: [
              { role: 'user', parts: [{ text: 'Run tool' }] },
              {
                role: 'model',
                parts: [
                  { text: 'unsigned', thought: true },
                  { functionCall: { id: 't1', name: 'tool', args: {} } },
                ],
              },
              {
                role: 'user',
                parts: [
                  {
                    functionResponse: {
                      id: 't1',
                      name: 'tool',
                      response: { output: 'ok' },
                    },
                  },
                ],
              },
            ],
          },
          { dropUnsignedAssistantThinking: true },
        ),
      ).toThrow('proxy omitted the thinking signature');
    });

    it('fails locally, rather than silently dropping the block, when an EMPTY-text unsigned thinking block belongs to a non-latest step of an active tool-use loop', () => {
      // Regression guard for pipeline ordering: dropEmptyTextThinkingBlocks
      // must run AFTER this check, not before. An empty-text thinking
      // block with no signature is unsigned by the same definition this
      // active-loop check uses -- if the empty-text guard ran first it
      // would delete the block before this check ever saw it, silently
      // swallowing exactly the proxy bug this throw exists to surface
      // (the same pass-ordering hazard identified against the removed
      // PATCH-B heuristic).
      //
      // Needs a two-step loop: a single assistant turn is always "the
      // latest", and dropEmptyTextThinkingBlocks unconditionally exempts
      // the latest turn regardless of ordering, so a one-step fixture
      // can't distinguish the two orderings. Step 1's empty-text thinking
      // must be on a NON-latest turn that is still part of the unbroken
      // tool_use/tool_result chain reaching the end of history.
      expect(() =>
        converter.convertLlmRequestToAnthropic(
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
              {
                role: 'user',
                parts: [
                  {
                    functionResponse: {
                      id: 't1',
                      name: 'tool',
                      response: { output: 'ok' },
                    },
                  },
                ],
              },
              {
                role: 'model',
                parts: [
                  {
                    text: 'signed reasoning',
                    thought: true,
                    thoughtSignature: 'sig',
                  },
                  { functionCall: { id: 't2', name: 'tool', args: {} } },
                ],
              },
              {
                role: 'user',
                parts: [
                  {
                    functionResponse: {
                      id: 't2',
                      name: 'tool',
                      response: { output: 'ok' },
                    },
                  },
                ],
              },
            ],
          },
          { dropUnsignedAssistantThinking: true },
        ),
      ).toThrow('proxy omitted the thinking signature');
    });

    it('drops unsigned thinking from a completed tool-use turn', () => {
      const { messages } = converter.convertLlmRequestToAnthropic(
        {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Run tool' }] },
            {
              role: 'model',
              parts: [
                { text: 'unsigned', thought: true },
                { functionCall: { id: 't1', name: 'tool', args: {} } },
              ],
            },
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: 't1',
                    name: 'tool',
                    response: { output: 'ok' },
                  },
                },
              ],
            },
            { role: 'model', parts: [{ text: 'Finished' }] },
            { role: 'user', parts: [{ text: 'Next' }] },
          ],
        },
        { dropUnsignedAssistantThinking: true },
      );

      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'tool', input: {} }],
      });
    });

    it('fails when an earlier step in the active tool loop has unsigned thinking', () => {
      expect(() =>
        converter.convertLlmRequestToAnthropic(
          {
            model: 'models/test',
            contents: [
              { role: 'user', parts: [{ text: 'Run tools' }] },
              {
                role: 'model',
                parts: [
                  { text: 'unsigned', thought: true },
                  { functionCall: { id: 't1', name: 'first', args: {} } },
                ],
              },
              {
                role: 'user',
                parts: [
                  {
                    functionResponse: {
                      id: 't1',
                      name: 'first',
                      response: { output: 'one' },
                    },
                  },
                ],
              },
              {
                role: 'model',
                parts: [
                  {
                    text: 'signed',
                    thought: true,
                    thoughtSignature: 'real-signature',
                  },
                  { functionCall: { id: 't2', name: 'second', args: {} } },
                ],
              },
              {
                role: 'user',
                parts: [
                  {
                    functionResponse: {
                      id: 't2',
                      name: 'second',
                      response: { output: 'two' },
                    },
                  },
                ],
              },
            ],
          },
          { dropUnsignedAssistantThinking: true },
        ),
      ).toThrow('proxy omitted the thinking signature');
    });
  });

  describe('dropEmptyTextThinkingBlocks', () => {
    it('leaves a signed, non-empty thinking block on a non-latest turn untouched', () => {
      // A broader cross-turn heuristic here (detecting "this turn's
      // tool_use went stale in an earlier trim" and downgrading its
      // thinking to text) was removed after review: it couldn't
      // distinguish that state from "this turn was always thinking-only",
      // and live verification showed it rewriting turns that were never
      // actually invalid. Only an empty-text thinking block is
      // unconditionally invalid regardless of tool_use presence; a
      // populated, signed thinking block is left exactly as-is.
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
          {
            role: 'model',
            parts: [
              {
                text: 'stale reasoning',
                thought: true,
                thoughtSignature: 'sig',
              },
            ],
          },
          { role: 'user', parts: [{ text: 'anything else?' }] },
          { role: 'model', parts: [{ text: 'Sure, here you go.' }] },
        ],
      });

      const olderAssistant = messages[1];
      expect(olderAssistant.role).toBe('assistant');
      expect(olderAssistant.content).toEqual([
        { type: 'thinking', thinking: 'stale reasoning', signature: 'sig' },
      ]);
    });

    it('drops an empty redacted_thinking-derived turn entirely (defensive, no plaintext fallback)', () => {
      // convertAnthropicResponseToLlm represents a redacted_thinking
      // block as `{ text: '', thought: true }` (its opaque `data` doesn't
      // survive the Gemini-Part round trip -- see that method's doc). When
      // this round-trips back through processContent it becomes an
      // empty-text `thinking` block on the wire, which this defensive
      // guard drops outright, dropping the whole message since nothing
      // else survives.
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
          {
            role: 'model',
            parts: [{ text: '', thought: true }],
          },
          { role: 'user', parts: [{ text: 'anything else?' }] },
          { role: 'model', parts: [{ text: 'Sure, here you go.' }] },
        ],
      });

      const assistantMessages = messages.filter((m) => m.role === 'assistant');
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].content).toEqual([
        { type: 'text', text: 'Sure, here you go.' },
      ]);
    });

    it('leaves the latest assistant turn untouched even with empty-text thinking', () => {
      // The latestAssistantIdx short-circuit fires before the empty-text
      // filter runs at all, so this must hold regardless of content -- use
      // an actually-empty-text block (matching the title) rather than a
      // populated one, so this test would fail if the exemption were ever
      // narrowed to "non-empty-text latest turns only".
      const { messages } = converter.convertLlmRequestToAnthropic({
        model: 'models/test',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
          {
            role: 'model',
            parts: [{ text: '', thought: true, thoughtSignature: 'sig' }],
          },
        ],
      });

      const lastMsg = messages[messages.length - 1];
      expect(lastMsg.role).toBe('assistant');
      expect(lastMsg.content).toEqual([
        { type: 'thinking', thinking: '', signature: 'sig' },
      ]);
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
      const { messages } = converter.convertLlmRequestToAnthropic(
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
      const { messages } = converter.convertLlmRequestToAnthropic(
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
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: 'call-1',
                    name: 'glob',
                    response: { output: 'ok' },
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
      const { messages } = converter.convertLlmRequestToAnthropic(
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
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: 't1',
                    name: 'tool',
                    response: { output: 'ok' },
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
          { type: 'thinking', thinking: 'Let me think', signature: 'sig' },
          { type: 'tool_use', id: 't1', name: 'tool', input: {} },
        ],
      });
    });

    it('does not modify user messages', () => {
      const { messages } = converter.convertLlmRequestToAnthropic(
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
      const { messages } = converter.convertLlmRequestToAnthropic({
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

      const { messages } = converter.convertLlmRequestToAnthropic(
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
      const { messages } = converter.convertLlmRequestToAnthropic(
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
      const { messages } = converter.convertLlmRequestToAnthropic(
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
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: 't1',
                    name: 'tool',
                    response: { output: 'ok' },
                  },
                },
              ],
            },
          ],
        },
        { stripAssistantThinking: true },
      );

      // Both assistant turns have their thinking blocks removed, and the
      // two consecutive model turns merge into a single assistant message.
      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello!' },
          { type: 'tool_use', id: 't1', name: 'tool', input: {} },
        ],
      });
    });

    it('strips thinking after consecutive assistant turns are merged', () => {
      const { messages } = converter.convertLlmRequestToAnthropic(
        {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Hi' }] },
            {
              role: 'model',
              parts: [
                {
                  text: 'preserved before merge',
                  thought: true,
                  thoughtSignature: 'sig',
                },
              ],
            },
            {
              role: 'model',
              parts: [{ functionCall: { id: 't1', name: 'tool', args: {} } }],
            },
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: 't1',
                    name: 'tool',
                    response: { output: 'ok' },
                  },
                },
              ],
            },
          ],
        },
        { stripAssistantThinking: true },
      );

      expect(messages[1]).toEqual({
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
      const { messages } = converter.convertLlmRequestToAnthropic(
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
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: 't1',
                    name: 'tool',
                    response: { output: 'ok' },
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
          { type: 'tool_use', id: 't1', name: 'tool', input: {} },
        ],
      });
    });

    it('preserves an existing compliant thinking block on a tool-use turn', () => {
      // A thinking block with a real `signature` field is fully compliant —
      // the injector must not duplicate it.
      const { messages } = converter.convertLlmRequestToAnthropic(
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
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: 't1',
                    name: 'tool',
                    response: { output: 'ok' },
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
      const { messages } = converter.convertLlmRequestToAnthropic(
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
      const { messages } = converter.convertLlmRequestToAnthropic(
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
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: 't1',
                    name: 'lookup',
                    response: { output: 'ok' },
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
          { type: 'text', text: 'Let me check that' },
          { type: 'tool_use', id: 't1', name: 'lookup', input: {} },
        ],
      });
    });
  });

  describe('assistant-turn prefill stripping', () => {
    it('drops a trailing empty assistant message when stripTrailingAssistantPrefill is set', () => {
      const { messages } = converter.convertLlmRequestToAnthropic(
        {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Hi' }] },
            // Whitespace-only, not empty: processContent only emits a text
            // block when part.text is truthy, so an actually-empty string
            // never reaches this pass at all (the fixture would be
            // vacuous). isEmptyAssistantMessage's `.trim()` check is what
            // this test needs to exercise.
            { role: 'model', parts: [{ text: '   ' }] },
          ],
        },
        { stripTrailingAssistantPrefill: true, enableCacheControl: false },
      );

      expect(messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      ]);
    });

    it('appends a synthetic user turn when a trailing assistant message has real content', () => {
      const { messages } = converter.convertLlmRequestToAnthropic(
        {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Hi' }] },
            { role: 'model', parts: [{ text: 'Sure, here you go.' }] },
          ],
        },
        { stripTrailingAssistantPrefill: true, enableCacheControl: false },
      );

      expect(messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Sure, here you go.' }],
        },
        { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
      ]);
    });

    it('leaves a trailing user message untouched when stripTrailingAssistantPrefill is set', () => {
      const { messages } = converter.convertLlmRequestToAnthropic(
        {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Hi' }] },
            { role: 'model', parts: [{ text: 'Hello!' }] },
            { role: 'user', parts: [{ text: 'How are you?' }] },
          ],
        },
        { stripTrailingAssistantPrefill: true, enableCacheControl: false },
      );

      expect(messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
        { role: 'user', content: [{ type: 'text', text: 'How are you?' }] },
      ]);
    });

    it('does not strip a trailing assistant message when the option is unset', () => {
      const { messages } = converter.convertLlmRequestToAnthropic(
        {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Hi' }] },
            { role: 'model', parts: [{ text: 'Sure, here you go.' }] },
          ],
        },
        { enableCacheControl: false },
      );

      expect(messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Sure, here you go.' }],
        },
      ]);
    });

    it('keeps a trailing thinking-only assistant message and appends a synthetic user turn', () => {
      // A thinking block is real content (not text/whitespace-only), so it
      // must be preserved rather than dropped as an "empty prefill" —
      // unlike an unanswered tool_use, thinking blocks are never treated
      // as orphans by the earlier merge/clean passes.
      const { messages } = converter.convertLlmRequestToAnthropic(
        {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Hi' }] },
            {
              role: 'model',
              parts: [
                {
                  text: 'pondering the answer',
                  thought: true,
                  thoughtSignature: 'sig',
                },
              ],
            },
          ],
        },
        { stripTrailingAssistantPrefill: true, enableCacheControl: false },
      );

      expect(messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'pondering the answer',
              signature: 'sig',
            },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
      ]);
    });
  });

  describe('convertLlmToolsToAnthropic', () => {
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

      const result = await converter.convertLlmToolsToAnthropic(tools);

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

      const result = await converter.convertLlmToolsToAnthropic(tools, {
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

      const result = await converter.convertLlmToolsToAnthropic(callable);

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

      const result = await converter.convertLlmToolsToAnthropic(tools);

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

      const result = await converter.convertLlmToolsToAnthropic(tools);
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

      const result = await converter.convertLlmToolsToAnthropic(tools);

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

      const result = await converter.convertLlmToolsToAnthropic(tools);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('valid_tool');
    });
  });

  describe('convertAnthropicResponseToLlm', () => {
    it('converts text, tool_use, thinking, and redacted_thinking blocks', () => {
      const response = converter.convertAnthropicResponseToLlm({
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
      expect(getGenAiUsageProvenance(response.usageMetadata)).toEqual({
        cachedInputTokensReported: false,
        cacheCreationInputTokens: undefined,
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
      const response = converter.convertAnthropicResponseToLlm({
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
      const response = converter.convertAnthropicResponseToLlm({
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
      expect(getGenAiUsageProvenance(response.usageMetadata)).toEqual({
        cachedInputTokensReported: true,
        cacheCreationInputTokens: 8_700,
      });
    });

    it('does not substitute the request model when the provider omits its model', () => {
      const response = converter.convertAnthropicResponseToLlm({
        id: 'msg-no-model',
        model: '',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      } as unknown as Anthropic.Message);

      expect(response.modelVersion).toBeUndefined();
    });
  });

  describe('mapAnthropicFinishReasonToLlm', () => {
    it('maps known reasons', () => {
      expect(converter.mapAnthropicFinishReasonToLlm('end_turn')).toBe(
        FinishReason.STOP,
      );
      expect(converter.mapAnthropicFinishReasonToLlm('max_tokens')).toBe(
        FinishReason.MAX_TOKENS,
      );
      expect(converter.mapAnthropicFinishReasonToLlm('content_filter')).toBe(
        FinishReason.SAFETY,
      );
    });

    it('maps refusal into the content-filter family (#9026)', () => {
      // A refusal stop_reason is a provider safety decision. It must map
      // to SAFETY so the quiet post-tool-result acceptance gate in
      // llmChat keeps it fatal; falling through to
      // FINISH_REASON_UNSPECIFIED would let an armed attempt accept the
      // refusal as a quiet "(empty content)" completion.
      expect(converter.mapAnthropicFinishReasonToLlm('refusal')).toBe(
        FinishReason.SAFETY,
      );
    });

    it('returns undefined for null/empty', () => {
      expect(converter.mapAnthropicFinishReasonToLlm(null)).toBeUndefined();
      expect(converter.mapAnthropicFinishReasonToLlm('')).toBeUndefined();
    });
  });

  describe('enableCacheControl', () => {
    it('does not add cache_control to system when disabled', () => {
      const noCacheConverter = new AnthropicContentConverter(
        'test-model',
        'auto',
        false,
      );
      const { system } = noCacheConverter.convertLlmRequestToAnthropic({
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
      const { messages } = noCacheConverter.convertLlmRequestToAnthropic({
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
      const { messages } = converter.convertLlmRequestToAnthropic({
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

      const result = await noCacheConverter.convertLlmToolsToAnthropic(tools);

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
          constructedWithCacheOff.convertLlmRequestToAnthropic(
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

        const result = await constructedWithCacheOff.convertLlmToolsToAnthropic(
          tools,
          {
            enableCacheControl: true,
            useGlobalCacheScope: true,
          },
        );
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
          constructedWithCacheOn.convertLlmRequestToAnthropic(
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

        const result = await constructedWithCacheOn.convertLlmToolsToAnthropic(
          tools,
          {
            enableCacheControl: false,
          },
        );
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
        const { system } = converterDefault.convertLlmRequestToAnthropic(
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

        const result = await converterDefault.convertLlmToolsToAnthropic(
          tools,
          { enableCacheControl: true },
        );
        expect(result[0].cache_control).toEqual({ type: 'ephemeral' });
      });
    });

    describe('cacheRetention', () => {
      it('omits ttl on the system block when cacheRetention is unset (ephemeral default)', () => {
        const { system } = converter.convertLlmRequestToAnthropic({
          model: 'models/test',
          contents: 'hi',
          config: { systemInstruction: 'sys' },
        });
        expect(system).toEqual([
          { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
        ]);
      });

      it("sets ttl:'1h' on system, last tool, and trailing user message when cacheRetention is '1h'", async () => {
        const { system, messages } = converter.convertLlmRequestToAnthropic(
          {
            model: 'models/test',
            contents: 'hi',
            config: { systemInstruction: 'sys' },
          },
          { cacheRetention: '1h' },
        );
        expect(system).toEqual([
          {
            type: 'text',
            text: 'sys',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ]);
        const lastMsg = messages[messages.length - 1];
        const content = Array.isArray(lastMsg.content) ? lastMsg.content : [];
        expect(content[content.length - 1]).toEqual({
          type: 'text',
          text: 'hi',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        });

        const tools = await converter.convertLlmToolsToAnthropic(
          [
            {
              functionDeclarations: [
                { name: 'get_weather', description: 'Get weather' },
              ],
            },
          ],
          { cacheRetention: '1h' },
        );
        expect(tools[0]?.cache_control).toEqual({
          type: 'ephemeral',
          ttl: '1h',
        });
      });

      it('composes ttl with scope:"global" on the same cache_control entry', () => {
        const { system } = converter.convertLlmRequestToAnthropic(
          {
            model: 'models/test',
            contents: 'hi',
            config: { systemInstruction: 'sys' },
          },
          { cacheRetention: '1h', useGlobalCacheScope: true },
        );
        expect(system).toEqual([
          {
            type: 'text',
            text: 'sys',
            cache_control: {
              type: 'ephemeral',
              scope: 'global',
              ttl: '1h',
            },
          },
        ]);
      });

      it('honors a per-anchor cacheRetentionByBlock override, promoting the earlier tool anchor to keep wire order legal', async () => {
        // Anthropic requires cache entries with a longer TTL to appear
        // before shorter ones on the wire (tools -> system -> messages).
        // { system: '1h' } alone would otherwise leave a 5m-default tool
        // anchor ahead of a 1h system anchor -- an ordering violation.
        // resolveCacheRetention promotes every anchor before a '1h' one,
        // so the tool anchor here also resolves to '1h'.
        const { system } = converter.convertLlmRequestToAnthropic(
          {
            model: 'models/test',
            contents: 'hi',
            config: { systemInstruction: 'sys' },
          },
          {
            cacheRetention: 'ephemeral',
            cacheRetentionByBlock: { system: '1h' },
          },
        );
        expect(system).toEqual([
          {
            type: 'text',
            text: 'sys',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ]);

        const tools = await converter.convertLlmToolsToAnthropic(
          [
            {
              functionDeclarations: [
                { name: 'get_weather', description: 'Get weather' },
              ],
            },
          ],
          {
            cacheRetention: 'ephemeral',
            cacheRetentionByBlock: { system: '1h' },
          },
        );
        expect(tools[0]?.cache_control).toEqual({
          type: 'ephemeral',
          ttl: '1h',
        });
      });

      it("does not promote anchors after the overridden one -- { tool: '1h' } alone leaves system/user.last at the default", async () => {
        // tool -> system -> user.last is already longest-to-shortest here,
        // so nothing needs promoting; this is the one override shape that
        // was always legal even before the ordering fix.
        const { system, messages } = converter.convertLlmRequestToAnthropic(
          {
            model: 'models/test',
            contents: 'hi',
            config: { systemInstruction: 'sys' },
          },
          {
            cacheRetention: 'ephemeral',
            cacheRetentionByBlock: { tool: '1h' },
          },
        );
        expect(system).toEqual([
          { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
        ]);
        const lastMsg = messages[messages.length - 1];
        const content = Array.isArray(lastMsg.content) ? lastMsg.content : [];
        expect(content[content.length - 1]).toEqual({
          type: 'text',
          text: 'hi',
          cache_control: { type: 'ephemeral' },
        });

        const tools = await converter.convertLlmToolsToAnthropic(
          [
            {
              functionDeclarations: [
                { name: 'get_weather', description: 'Get weather' },
              ],
            },
          ],
          {
            cacheRetention: 'ephemeral',
            cacheRetentionByBlock: { tool: '1h' },
          },
        );
        expect(tools[0]?.cache_control).toEqual({
          type: 'ephemeral',
          ttl: '1h',
        });
      });

      it("promotes both tool and system when only 'user.last' is overridden to '1h'", async () => {
        // { 'user.last': '1h' } alone would otherwise leave both the tool
        // and system anchors at the 5m default ahead of a 1h trailing
        // user message -- also an ordering violation, and one the
        // reviewer's case analysis called out explicitly (case E).
        const { system, messages } = converter.convertLlmRequestToAnthropic(
          {
            model: 'models/test',
            contents: 'hi',
            config: { systemInstruction: 'sys' },
          },
          {
            cacheRetention: 'ephemeral',
            cacheRetentionByBlock: { 'user.last': '1h' },
          },
        );
        expect(system).toEqual([
          {
            type: 'text',
            text: 'sys',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ]);
        const lastMsg = messages[messages.length - 1];
        const content = Array.isArray(lastMsg.content) ? lastMsg.content : [];
        expect(content[content.length - 1]).toEqual({
          type: 'text',
          text: 'hi',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        });

        const tools = await converter.convertLlmToolsToAnthropic(
          [
            {
              functionDeclarations: [
                { name: 'get_weather', description: 'Get weather' },
              ],
            },
          ],
          {
            cacheRetention: 'ephemeral',
            cacheRetentionByBlock: { 'user.last': '1h' },
          },
        );
        expect(tools[0]?.cache_control).toEqual({
          type: 'ephemeral',
          ttl: '1h',
        });
      });

      it('carries ttl on both halves of a split system prompt (staticSystemPrefix)', () => {
        const { system } = converter.convertLlmRequestToAnthropic(
          {
            model: 'models/test',
            contents: 'hi',
            config: { systemInstruction: 'stable prefixvolatile suffix' },
          },
          { cacheRetention: '1h', staticSystemPrefix: 'stable prefix' },
        );
        expect(system).toEqual([
          {
            type: 'text',
            text: 'stable prefix',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
          {
            type: 'text',
            text: 'volatile suffix',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ]);
      });
    });
  });
});
