/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OpenAIContentConverter } from './converter.js';
import { StreamingToolCallParser } from './streamingToolCallParser.js';
import { TaggedThinkingParser } from './taggedThinkingParser.js';
import type { RequestContext } from './types.js';
import {
  Type,
  FinishReason,
  type GenerateContentParameters,
  type Content,
  type Part,
  type Tool,
  type CallableTool,
} from '@google/genai';
import type OpenAI from 'openai';
import { convertToFunctionResponse } from '../coreToolScheduler.js';

describe('OpenAIContentConverter', () => {
  let converter: typeof OpenAIContentConverter;
  let requestContext: RequestContext;

  beforeEach(() => {
    converter = OpenAIContentConverter;
    requestContext = {
      model: 'test-model',
      modalities: {
        image: true,
        pdf: true,
        audio: true,
        video: true,
      },
      startTime: 0,
    };
  });

  function withStreamParser(
    toolCallParser: StreamingToolCallParser = new StreamingToolCallParser(),
  ): RequestContext {
    return {
      ...requestContext,
      toolCallParser,
    };
  }

  function withTaggedThinkingOptions(): RequestContext {
    return {
      ...requestContext,
      responseParsingOptions: { taggedThinkingTags: true },
    };
  }

  function withTaggedThinkingStreamParser(): RequestContext {
    return {
      ...withStreamParser(),
      responseParsingOptions: { taggedThinkingTags: true },
      taggedThinkingParser: new TaggedThinkingParser(),
    };
  }

  describe('stream-local parser state', () => {
    it('creates fresh parser instances', () => {
      const ctx1 = new StreamingToolCallParser();
      const ctx2 = new StreamingToolCallParser();

      expect(ctx1).toBeInstanceOf(StreamingToolCallParser);
      expect(ctx2).toBeInstanceOf(StreamingToolCallParser);
      expect(ctx1).not.toBe(ctx2);
    });

    it('isolates two contexts so writes to one do not leak into the other', () => {
      // Regression for issue #3516: previously the parser lived on the
      // Converter as an instance field, so two concurrent streams sharing
      // the same Config.contentGenerator would overwrite each other's
      // tool-call buffers. Per-stream contexts eliminate that contention.
      const ctx1 = new StreamingToolCallParser();
      const ctx2 = new StreamingToolCallParser();

      ctx1.addChunk(0, '{"a":1}', 'call_A', 'fn_A');
      ctx2.addChunk(0, '{"b":2}', 'call_B', 'fn_B');

      expect(ctx1.getBuffer(0)).toBe('{"a":1}');
      expect(ctx2.getBuffer(0)).toBe('{"b":2}');
      expect(ctx1.getToolCallMeta(0).id).toBe('call_A');
      expect(ctx2.getToolCallMeta(0).id).toBe('call_B');
    });

    it('demuxes interleaved chunks from two concurrent streams correctly (#3516)', () => {
      // Real-world shape: two subagents share one Config (hence one
      // Converter). Their OpenAI streams run concurrently; chunks arrive
      // interleaved at the event loop. Under the pre-fix architecture
      // this corrupted both tool calls; under per-stream contexts each
      // stream's chunks stay in their own parser and close cleanly.
      const streamA = withStreamParser(new StreamingToolCallParser());
      const streamB = withStreamParser(new StreamingToolCallParser());

      const openerA = {
        object: 'chat.completion.chunk',
        id: 'A-open',
        created: 1,
        model: 'test',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_A',
                  type: 'function' as const,
                  function: {
                    name: 'read_file',
                    arguments: '{"file_path":"/a',
                  },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk;

      const openerB = {
        ...openerA,
        id: 'B-open',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_B',
                  type: 'function' as const,
                  function: {
                    name: 'read_file',
                    arguments: '{"file_path":"/b',
                  },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk;

      const contA = {
        ...openerA,
        id: 'A-cont',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '/x.ts"}' } }],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk;

      const contB = {
        ...openerB,
        id: 'B-cont',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '/y.ts"}' } }],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk;

      const finisher = (id: string) =>
        ({
          object: 'chat.completion.chunk',
          id,
          created: 2,
          model: 'test',
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'tool_calls',
              logprobs: null,
            },
          ],
        }) as unknown as OpenAI.Chat.ChatCompletionChunk;

      // Interleave the two streams. Pre-fix this produced corrupt JSON
      // because every chunk fed the same shared parser.
      converter.convertOpenAIChunkToGemini(openerA, streamA);
      converter.convertOpenAIChunkToGemini(openerB, streamB);
      converter.convertOpenAIChunkToGemini(contA, streamA);
      converter.convertOpenAIChunkToGemini(contB, streamB);

      const resultA = converter.convertOpenAIChunkToGemini(
        finisher('A-finish'),
        streamA,
      );
      const resultB = converter.convertOpenAIChunkToGemini(
        finisher('B-finish'),
        streamB,
      );

      const fnA = resultA.candidates?.[0]?.content?.parts?.find(
        (p: Part) => p.functionCall,
      )?.functionCall;
      const fnB = resultB.candidates?.[0]?.content?.parts?.find(
        (p: Part) => p.functionCall,
      )?.functionCall;

      expect(fnA?.name).toBe('read_file');
      expect(fnA?.args).toEqual({ file_path: '/a/x.ts' });
      expect(fnA?.id).toBe('call_A');

      expect(fnB?.name).toBe('read_file');
      expect(fnB?.args).toEqual({ file_path: '/b/y.ts' });
      expect(fnB?.id).toBe('call_B');
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

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );
      const toolMessage = messages.find((message) => message.role === 'tool');

      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
      }>;
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('Raw output text');
    });

    it('should prioritize error field when present', () => {
      const request = createRequestWithFunctionResponse({
        error: 'Command failed',
      });

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );
      const toolMessage = messages.find((message) => message.role === 'tool');

      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
      }>;
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('Command failed');
    });

    it('should stringify non-string responses', () => {
      const request = createRequestWithFunctionResponse({
        data: { value: 42 },
      });

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );
      const toolMessage = messages.find((message) => message.role === 'tool');

      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
      }>;
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('{"data":{"value":42}}');
    });

    it('should convert function responses with inlineData to tool message with embedded image_url', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
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
                  id: 'call_1',
                  name: 'Read',
                  response: { output: 'Image content' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'image/png',
                        data: 'base64encodedimagedata',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );

      // Should have tool message with both text and image content
      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect((toolMessage as { tool_call_id?: string }).tool_call_id).toBe(
        'call_1',
      );
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('Image content');
      expect(contentArray[1].type).toBe('image_url');
      expect(contentArray[1].image_url?.url).toBe(
        'data:image/png;base64,base64encodedimagedata',
      );

      // No separate user message should be created
      const userMessage = messages.find((message) => message.role === 'user');
      expect(userMessage).toBeUndefined();
    });

    it('should split tool-result media into a follow-up user message when splitToolMedia is enabled (issue #3616)', () => {
      // Same shape as the embedded-image test above, but with the strict
      // OpenAI-compat opt-in flag set. The tool message must stay
      // spec-compliant (string / text-part content only) and the image must
      // arrive in a follow-up user message.
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
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
                  id: 'call_1',
                  name: 'Read',
                  response: { output: 'Image content' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'image/png',
                        data: 'base64encodedimagedata',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const strictContext: RequestContext = {
        ...requestContext,
        splitToolMedia: true,
      };
      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        strictContext,
      );

      const toolMessage = messages.find((m) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
      // Tool message content is a plain string (or text-part array) — no media
      expect(typeof toolMessage?.content === 'string').toBe(true);
      expect(toolMessage?.content).toContain('Image content');

      // The image lives in a follow-up user message
      const userMessage = messages.find((m) => m.role === 'user');
      expect(userMessage).toBeDefined();
      const userContent = userMessage?.content as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
      expect(Array.isArray(userContent)).toBe(true);
      const imagePart = userContent.find((p) => p.type === 'image_url');
      expect(imagePart?.image_url?.url).toBe(
        'data:image/png;base64,base64encodedimagedata',
      );
    });

    it('should keep all tool messages contiguous and merge split media into a single follow-up user message for parallel tool calls (issue #3616)', () => {
      // Two assistant tool calls in parallel. Both responses come back in the
      // same `user` content as separate functionResponse parts. The first
      // returns an image; the second returns text only. OpenAI Chat
      // Completions requires every `role: "tool"` response to appear
      // contiguously before any non-tool message, so the synthesised user
      // message carrying split media MUST come after BOTH tool messages,
      // not interleaved between them.
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_screenshot',
                  name: 'browser_take_screenshot',
                  args: {},
                },
              },
              {
                functionCall: {
                  id: 'call_console',
                  name: 'browser_console_messages',
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
                  id: 'call_screenshot',
                  name: 'browser_take_screenshot',
                  response: { output: 'Captured screenshot' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'image/png',
                        data: 'shotbase64',
                      },
                    },
                  ],
                },
              },
              {
                functionResponse: {
                  id: 'call_console',
                  name: 'browser_console_messages',
                  response: { output: 'no console messages' },
                },
              },
            ],
          },
        ],
      };

      const strictContext: RequestContext = {
        ...requestContext,
        splitToolMedia: true,
      };
      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        strictContext,
      );

      // Locate the assistant turn (with the two tool calls) and assert that
      // the next two messages are both `tool`, contiguously, before any
      // user message.
      const assistantIdx = messages.findIndex((m) => m.role === 'assistant');
      expect(assistantIdx).toBeGreaterThanOrEqual(0);
      expect(messages[assistantIdx + 1]?.role).toBe('tool');
      expect(messages[assistantIdx + 2]?.role).toBe('tool');
      expect(messages[assistantIdx + 3]?.role).toBe('user');

      // Both tool messages have spec-compliant content (string OR array of
      // text-typed parts only — no image_url / input_audio / video_url /
      // file parts allowed by OpenAI on tool messages).
      const isSpecCompliantToolContent = (content: unknown): boolean => {
        if (typeof content === 'string') return true;
        if (!Array.isArray(content)) return false;
        return (content as Array<{ type: string }>).every(
          (p) => p.type === 'text',
        );
      };
      expect(
        isSpecCompliantToolContent(
          (messages[assistantIdx + 1] as { content: unknown }).content,
        ),
      ).toBe(true);
      expect(
        isSpecCompliantToolContent(
          (messages[assistantIdx + 2] as { content: unknown }).content,
        ),
      ).toBe(true);

      // Exactly one synthesised user message exists, and it carries the
      // single image from the first tool response.
      const userMessages = messages.filter((m) => m.role === 'user');
      expect(userMessages).toHaveLength(1);
      const userContent = userMessages[0].content as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
      const imageParts = userContent.filter((p) => p.type === 'image_url');
      expect(imageParts).toHaveLength(1);
      expect(imageParts[0].image_url?.url).toBe(
        'data:image/png;base64,shotbase64',
      );
    });

    it('should merge media from multiple media-bearing parallel tool responses into one follow-up user message (issue #3616)', () => {
      // Both tool responses return images. The accumulator must combine them
      // into a single user message — we should NOT see two separate user
      // messages (which would still violate the contiguity rule because the
      // first user message would split the tool messages apart).
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: { id: 'call_a', name: 'shot_a', args: {} },
              },
              {
                functionCall: { id: 'call_b', name: 'shot_b', args: {} },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_a',
                  name: 'shot_a',
                  response: { output: 'A' },
                  parts: [
                    { inlineData: { mimeType: 'image/png', data: 'aaa' } },
                  ],
                },
              },
              {
                functionResponse: {
                  id: 'call_b',
                  name: 'shot_b',
                  response: { output: 'B' },
                  parts: [
                    { inlineData: { mimeType: 'image/png', data: 'bbb' } },
                  ],
                },
              },
            ],
          },
        ],
      };

      const strictContext: RequestContext = {
        ...requestContext,
        splitToolMedia: true,
      };
      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        strictContext,
      );

      const toolMessages = messages.filter((m) => m.role === 'tool');
      const userMessages = messages.filter((m) => m.role === 'user');
      expect(toolMessages).toHaveLength(2);
      expect(userMessages).toHaveLength(1);

      const userContent = userMessages[0].content as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
      const imageUrls = userContent
        .filter((p) => p.type === 'image_url')
        .map((p) => p.image_url?.url);
      expect(imageUrls).toEqual([
        'data:image/png;base64,aaa',
        'data:image/png;base64,bbb',
      ]);
    });

    it('should not synthesise a follow-up user message when splitToolMedia is enabled but the response has no media (issue #3616)', () => {
      // Regression guard: when the flag is on but a tool response is text-only,
      // the synthesis path must not emit any user message. Without this guard,
      // a future refactor that always emits the follow-up could regress silently.
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [{ functionCall: { id: 'c', name: 'echo', args: {} } }],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'c',
                  name: 'echo',
                  response: { output: 'plain text result' },
                },
              },
            ],
          },
        ],
      };

      const strictContext: RequestContext = {
        ...requestContext,
        splitToolMedia: true,
      };
      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        strictContext,
      );

      const toolMessages = messages.filter((m) => m.role === 'tool');
      const userMessages = messages.filter((m) => m.role === 'user');
      expect(toolMessages).toHaveLength(1);
      expect(userMessages).toHaveLength(0);
    });

    it('should fall back to a placeholder string when the tool response is media-only (issue #3616)', () => {
      // When extractFunctionResponseContent returns empty AND parts contain
      // only media, the tool message must end up with the placeholder string
      // rather than an empty array (which would be invalid spec).
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [{ functionCall: { id: 'c', name: 'shot', args: {} } }],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'c',
                  name: 'shot',
                  // null response triggers extractFunctionResponseContent
                  // to return "" — the empty-text branch we want to cover.
                  response: null as unknown as Record<string, unknown>,
                  parts: [
                    { inlineData: { mimeType: 'image/png', data: 'xxx' } },
                  ],
                },
              },
            ],
          },
        ],
      };

      const strictContext: RequestContext = {
        ...requestContext,
        splitToolMedia: true,
      };
      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        strictContext,
      );

      const toolMessage = messages.find((m) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(toolMessage?.content).toBe(
        '[media attached in following user message]',
      );
      const userMessage = messages.find((m) => m.role === 'user');
      const userContent = userMessage?.content as Array<{
        type: string;
        image_url?: { url: string };
      }>;
      const img = userContent.find((p) => p.type === 'image_url');
      expect(img?.image_url?.url).toBe('data:image/png;base64,xxx');
    });

    it('should preserve prior embedded-media behavior when splitToolMedia is false (default) on parallel tool calls (issue #3616)', () => {
      // Same input as the parallel-tool-calls split test, but with the flag
      // off. Asserts that the opt-in is actually opt-in: media stays embedded
      // in the tool message and no follow-up user message is synthesised.
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              { functionCall: { id: 'c1', name: 's1', args: {} } },
              { functionCall: { id: 'c2', name: 's2', args: {} } },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'c1',
                  name: 's1',
                  response: { output: 'r1' },
                  parts: [
                    { inlineData: { mimeType: 'image/png', data: 'aaa' } },
                  ],
                },
              },
              {
                functionResponse: {
                  id: 'c2',
                  name: 's2',
                  response: { output: 'r2' },
                },
              },
            ],
          },
        ],
      };

      // requestContext default has splitToolMedia undefined / false
      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );

      const toolMessages = messages.filter((m) => m.role === 'tool');
      const userMessages = messages.filter((m) => m.role === 'user');
      expect(toolMessages).toHaveLength(2);
      expect(userMessages).toHaveLength(0);
      // First tool message should still carry the embedded image
      const firstToolContent = toolMessages[0].content as Array<{
        type: string;
        image_url?: { url: string };
      }>;
      const img = firstToolContent.find((p) => p.type === 'image_url');
      expect(img?.image_url?.url).toBe('data:image/png;base64,aaa');
    });

    it('should convert function responses with fileData to tool message with embedded image_url', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
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
                  id: 'call_1',
                  name: 'Read',
                  response: { output: 'File content' },
                  parts: [
                    {
                      fileData: {
                        mimeType: 'image/jpeg',
                        fileUri: 'base64imagedata',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );

      // Should have tool message with both text and image content
      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('File content');
      expect(contentArray[1].type).toBe('image_url');
      expect(contentArray[1].image_url?.url).toBe('base64imagedata');

      // No separate user message should be created
      const userMessage = messages.find((message) => message.role === 'user');
      expect(userMessage).toBeUndefined();
    });

    it('should convert PDF inlineData to tool message with embedded input_file', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
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
                  id: 'call_1',
                  name: 'Read',
                  response: { output: 'PDF content' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'application/pdf',
                        data: 'base64pdfdata',
                        displayName: 'document.pdf',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );

      // Should have tool message with both text and file content
      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
        file?: { filename: string; file_data: string };
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('PDF content');
      expect(contentArray[1].type).toBe('file');
      expect(contentArray[1].file?.filename).toBe('document.pdf');
      expect(contentArray[1].file?.file_data).toBe(
        'data:application/pdf;base64,base64pdfdata',
      );

      // No separate user message should be created
      const userMessage = messages.find((message) => message.role === 'user');
      expect(userMessage).toBeUndefined();
    });

    it('should convert audio parts to tool message with embedded input_audio', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
                  name: 'Record',
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
                  name: 'Record',
                  response: { output: 'Audio recorded' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'audio/wav',
                        data: 'audiobase64data',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );

      // Should have tool message with both text and audio content
      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
        input_audio?: { data: string; format: string };
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('Audio recorded');
      expect(contentArray[1].type).toBe('input_audio');
      expect(contentArray[1].input_audio?.data).toBe(
        'data:audio/wav;base64,audiobase64data',
      );
      expect(contentArray[1].input_audio?.format).toBe('wav');

      // No separate user message should be created
      const userMessage = messages.find((message) => message.role === 'user');
      expect(userMessage).toBeUndefined();
    });

    it('should convert image fileData URL to tool message with embedded image_url', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
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
                  id: 'call_1',
                  name: 'Read',
                  response: { output: 'Image content' },
                  parts: [
                    {
                      fileData: {
                        mimeType: 'image/jpeg',
                        fileUri:
                          'https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg',
                        displayName: 'ant.jpg',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );

      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('Image content');
      expect(contentArray[1].type).toBe('image_url');
      expect(contentArray[1].image_url?.url).toBe(
        'https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg',
      );
    });

    it('should convert PDF fileData URL to tool message with embedded file', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
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
                  id: 'call_1',
                  name: 'Read',
                  response: { output: 'PDF content' },
                  parts: [
                    {
                      fileData: {
                        mimeType: 'application/pdf',
                        fileUri:
                          'https://assets.anthropic.com/m/1cd9d098ac3e6467/original/Claude-3-Model-Card-October-Addendum.pdf',
                        displayName: 'document.pdf',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );

      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
        file?: { filename: string; file_data: string };
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('PDF content');
      expect(contentArray[1].type).toBe('file');
      expect(contentArray[1].file?.filename).toBe('document.pdf');
      expect(contentArray[1].file?.file_data).toBe(
        'https://assets.anthropic.com/m/1cd9d098ac3e6467/original/Claude-3-Model-Card-October-Addendum.pdf',
      );
    });

    it('should convert video inlineData to tool message with embedded video_url', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
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
                  id: 'call_1',
                  name: 'Read',
                  response: { output: 'Video content' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'video/mp4',
                        data: 'videobase64data',
                        displayName: 'recording.mp4',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );

      // Should have tool message with both text and video content
      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
        video_url?: { url: string };
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('Video content');
      expect(contentArray[1].type).toBe('video_url');
      expect(contentArray[1].video_url?.url).toBe(
        'data:video/mp4;base64,videobase64data',
      );

      // No separate user message should be created
      const userMessage = messages.find((message) => message.role === 'user');
      expect(userMessage).toBeUndefined();
    });

    it('should convert video fileData URL to tool message with embedded video_url', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
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
                  id: 'call_1',
                  name: 'Read',
                  response: { output: 'Video content' },
                  parts: [
                    {
                      fileData: {
                        mimeType: 'video/mp4',
                        fileUri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                        displayName: 'recording.mp4',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );

      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
        video_url?: { url: string };
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('Video content');
      expect(contentArray[1].type).toBe('video_url');
      expect(contentArray[1].video_url?.url).toBe(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      );
    });

    it('should render unsupported inlineData file types as a text block', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
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
                  id: 'call_1',
                  name: 'Read',
                  response: { output: 'File content' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'application/zip',
                        data: 'base64zipdata',
                        displayName: 'archive.zip',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );

      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('File content');
      expect(contentArray[1].type).toBe('text');
      expect(contentArray[1].text).toContain('Unsupported inline media type');
      expect(contentArray[1].text).toContain('application/zip');
      expect(contentArray[1].text).toContain('archive.zip');
    });

    it('should render unsupported fileData types (including audio) as a text block', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
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
                  id: 'call_1',
                  name: 'Read',
                  response: { output: 'File content' },
                  parts: [
                    {
                      fileData: {
                        mimeType: 'audio/mpeg',
                        fileUri: 'https://example.com/audio.mp3',
                        displayName: 'audio.mp3',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );

      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('File content');
      expect(contentArray[1].type).toBe('text');
      expect(contentArray[1].text).toContain('Unsupported file media type');
      expect(contentArray[1].text).toContain('audio/mpeg');
      expect(contentArray[1].text).toContain('audio.mp3');
    });

    it('should create tool message with text-only content when no media parts', () => {
      const request = createRequestWithFunctionResponse({
        output: 'Plain text output',
      });

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );
      const toolMessage = messages.find((message) => message.role === 'tool');

      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
      }>;
      expect(contentArray).toHaveLength(1);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('Plain text output');

      // No user message should be created when there's no media
      const userMessage = messages.find((message) => message.role === 'user');
      expect(userMessage).toBeUndefined();
    });

    it('should create tool message with empty content for empty function responses', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                text: 'Let me read that file.',
              },
              {
                functionCall: {
                  id: 'call_1',
                  name: 'read_file',
                  args: { path: 'test.txt' },
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
                  name: 'read_file',
                  response: { output: '' },
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );

      // Should create an assistant message with tool call and a tool message with empty content
      // This is required because OpenAI API expects every tool call to have a corresponding response
      expect(messages.length).toBeGreaterThanOrEqual(2);

      const toolMessage = messages.find(
        (m) =>
          m.role === 'tool' &&
          'tool_call_id' in m &&
          m.tool_call_id === 'call_1',
      );
      expect(toolMessage).toBeDefined();
      expect(toolMessage).toMatchObject({
        role: 'tool',
        tool_call_id: 'call_1',
        content: '',
      });
    });

    describe('assistant message with reasoning-only content (issue #3421)', () => {
      /**
       * Regression tests for https://github.com/QwenLM/qwen-code/issues/3421
       *
       * When a model (e.g. Ollama qwen3.5:9b) returns a response that contains
       * reasoning content but an empty text body, the converted assistant message
       * must use content: "" instead of content: null.
       * Some OpenAI-compatible providers reject content: null with HTTP 400 when
       * reasoning_content is also present.
       */
      it('should use empty string instead of null for content when assistant has only reasoning parts', () => {
        const request: GenerateContentParameters = {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Think about this.' }] },
            {
              // Assistant turn that only produced a thought, no visible text
              role: 'model',
              parts: [{ text: 'I reasoned about it.', thought: true }],
            },
            { role: 'user', parts: [{ text: 'What did you conclude?' }] },
          ],
        };

        const messages = converter.convertGeminiRequestToOpenAI(
          request,
          requestContext,
        );

        const assistantMsg = messages.find((m) => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        // Must NOT be null – Ollama and other providers reject null content
        // when reasoning_content is present (HTTP 400).
        expect((assistantMsg as { content: unknown }).content).toBe('');
        // reasoning_content should still be preserved
        expect(
          (assistantMsg as { reasoning_content?: string }).reasoning_content,
        ).toBe('I reasoned about it.');
      });

      it('should keep content null when assistant has only tool_calls and no reasoning', () => {
        const request: GenerateContentParameters = {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Call the tool.' }] },
            {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'call_1',
                    name: 'some_tool',
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
                    name: 'some_tool',
                    response: { output: 'done' },
                  },
                },
              ],
            },
          ],
        };

        const messages = converter.convertGeminiRequestToOpenAI(
          request,
          requestContext,
        );

        const assistantMsg = messages.find((m) => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        // Tool-call-only messages follow the OpenAI spec: content should be null
        expect((assistantMsg as { content: unknown }).content).toBeNull();
      });

      it('should use actual text content when assistant has both reasoning and text', () => {
        const request: GenerateContentParameters = {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Explain.' }] },
            {
              role: 'model',
              parts: [
                { text: 'My hidden reasoning.', thought: true },
                { text: 'Here is my answer.' },
              ],
            },
          ],
        };

        const messages = converter.convertGeminiRequestToOpenAI(
          request,
          requestContext,
        );

        const assistantMsg = messages.find((m) => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        expect((assistantMsg as { content: unknown }).content).toBe(
          'Here is my answer.',
        );
        expect(
          (assistantMsg as { reasoning_content?: string }).reasoning_content,
        ).toBe('My hidden reasoning.');
      });
    });
  });

  describe('MCP multi-part tool results (issue #1520)', () => {
    /**
     * Regression tests for https://github.com/QwenLM/qwen-code/issues/1520
     *
     * Ensures that when an MCP tool returns multiple content blocks
     * (e.g., text + image, or multiple text sections), all content
     * ends up inside the tool message – NOT in a separate user message.
     *
     * These tests simulate the data shape produced by the *fixed*
     * convertToFunctionResponse(), where all text is joined into
     * `response.output` and media is placed in `response.parts`.
     */

    it('should include all text content in tool message when function response has joined text', () => {
      // After the fix, convertToFunctionResponse joins multiple text parts
      // into the FunctionResponse.response.output.
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_mcp_1',
                  name: 'figma_get_code',
                  args: { nodeId: '38:521' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_mcp_1',
                  name: 'figma_get_code',
                  response: {
                    output:
                      '<div data-node-id="38:521">...</div>\nSUPER CRITICAL: The generated React+Tailwind code MUST be converted...',
                  },
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );

      const toolMessage = messages.find((m) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect((toolMessage as { tool_call_id?: string }).tool_call_id).toBe(
        'call_mcp_1',
      );

      // All content is in the tool message
      const toolContent = toolMessage?.content;
      expect(Array.isArray(toolContent)).toBe(true);
      const toolTexts = (toolContent as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === 'text')
        .map((p) => p.text);
      expect(toolTexts).toHaveLength(1);
      expect(toolTexts[0]).toContain('data-node-id');
      expect(toolTexts[0]).toContain('SUPER CRITICAL');

      // No user message should be created
      const userMessages = messages.filter((m) => m.role === 'user');
      expect(userMessages).toHaveLength(0);
    });

    it('should include text and image in tool message when function response has media parts', () => {
      // After the fix, convertToFunctionResponse puts media into
      // FunctionResponse.parts, which the OpenAI converter picks up
      // in createToolMessage().
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_mcp_2',
                  name: 'figma_get_screenshot',
                  args: { nodeId: '38:521' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_mcp_2',
                  name: 'figma_get_screenshot',
                  response: {
                    output:
                      "[Tool 'figma' provided the following image data with mime-type: image/png]",
                  },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'image/png',
                        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );

      const toolMessage = messages.find((m) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect((toolMessage as { tool_call_id?: string }).tool_call_id).toBe(
        'call_mcp_2',
      );

      // Tool message should contain both text and image
      const toolContent = toolMessage?.content;
      expect(Array.isArray(toolContent)).toBe(true);
      const contentArray = toolContent as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toContain('image data');
      expect(contentArray[1].type).toBe('image_url');
      expect(contentArray[1].image_url?.url).toContain('data:image/png');

      // No user message should be created
      const userMessages = messages.filter((m) => m.role === 'user');
      expect(userMessages).toHaveLength(0);
    });
  });

  describe('convertOpenAIResponseToGemini', () => {
    it('should handle empty choices array without crashing', () => {
      const response = converter.convertOpenAIResponseToGemini(
        {
          object: 'chat.completion',
          id: 'chatcmpl-empty',
          created: 123,
          model: 'test-model',
          choices: [],
        } as unknown as OpenAI.Chat.ChatCompletion,
        requestContext,
      );

      expect(response.candidates).toEqual([]);
    });
  });

  describe('OpenAI -> Gemini reasoning content', () => {
    it('should convert reasoning_content to a thought part for non-streaming responses', () => {
      const response = converter.convertOpenAIResponseToGemini(
        {
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
        } as unknown as OpenAI.Chat.ChatCompletion,
        requestContext,
      );

      const parts = response.candidates?.[0]?.content?.parts;
      expect(parts?.[0]).toEqual(
        expect.objectContaining({ thought: true, text: 'chain-of-thought' }),
      );
      expect(parts?.[1]).toEqual(
        expect.objectContaining({ text: 'final answer' }),
      );
    });

    it('should convert reasoning to a thought part for non-streaming responses', () => {
      const response = converter.convertOpenAIResponseToGemini(
        {
          object: 'chat.completion',
          id: 'chatcmpl-2',
          created: 123,
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'final answer',
                reasoning: 'chain-of-thought',
              },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletion,
        requestContext,
      );

      const parts = response.candidates?.[0]?.content?.parts;
      expect(parts?.[0]).toEqual(
        expect.objectContaining({ thought: true, text: 'chain-of-thought' }),
      );
      expect(parts?.[1]).toEqual(
        expect.objectContaining({ text: 'final answer' }),
      );
    });

    it('should convert streaming reasoning_content delta to a thought part', () => {
      const chunk = converter.convertOpenAIChunkToGemini(
        {
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
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        withStreamParser(new StreamingToolCallParser()),
      );

      const parts = chunk.candidates?.[0]?.content?.parts;
      expect(parts?.[0]).toEqual(
        expect.objectContaining({ thought: true, text: 'thinking...' }),
      );
      expect(parts?.[1]).toEqual(
        expect.objectContaining({ text: 'visible text' }),
      );
    });

    it('should convert streaming reasoning delta to a thought part', () => {
      const chunk = converter.convertOpenAIChunkToGemini(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-1b',
          created: 456,
          choices: [
            {
              index: 0,
              delta: {
                content: 'visible text',
                reasoning: 'thinking...',
              },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          model: 'gpt-test',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        withStreamParser(new StreamingToolCallParser()),
      );

      const parts = chunk.candidates?.[0]?.content?.parts;
      expect(parts?.[0]).toEqual(
        expect.objectContaining({ thought: true, text: 'thinking...' }),
      );
      expect(parts?.[1]).toEqual(
        expect.objectContaining({ text: 'visible text' }),
      );
    });

    it('should not throw when streaming chunk has no delta', () => {
      const chunk = converter.convertOpenAIChunkToGemini(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-2',
          created: 456,
          choices: [
            {
              index: 0,
              // Some OpenAI-compatible providers may omit delta entirely.
              delta: undefined,
              finish_reason: null,
              logprobs: null,
            },
          ],
          model: 'gpt-test',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        withStreamParser(new StreamingToolCallParser()),
      );

      const parts = chunk.candidates?.[0]?.content?.parts;
      expect(parts).toEqual([]);
    });

    it('should normalize cumulative streaming content deltas to suffixes', () => {
      const ctx = withStreamParser();
      const chunks = [
        'Here',
        'Here is a Flowchart Syntax Reference:',
        'Here is a Flowchart Syntax Reference:\n| `flowchart TD` | Direction |',
        'Here is a Flowchart Syntax Reference:\n| `flowchart TD` | Direction |\n| `A[Text]` | Node |',
      ];

      const emitted = chunks.map((content, index) => {
        const chunk = converter.convertOpenAIChunkToGemini(
          {
            object: 'chat.completion.chunk',
            id: `chunk-cumulative-${index}`,
            created: 456 + index,
            choices: [
              {
                index: 0,
                delta: { content },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        );

        return chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      });

      expect(emitted).toEqual([
        'Here',
        ' is a Flowchart Syntax Reference:',
        '\n| `flowchart TD` | Direction |',
        '\n| `A[Text]` | Node |',
      ]);
      expect(emitted.join('')).toBe(chunks[chunks.length - 1]);
    });

    it('should ignore repeated cumulative chunks with no new suffix', () => {
      const ctx = withStreamParser();
      // Must be ≥ CUMULATIVE_DELTA_EXACT_REPEAT_MIN_LENGTH (64 chars) so the
      // exact-repeat branch enters cumulative mode rather than treating this
      // as a short legitimate repeat. Realistic cumulative providers replay
      // buffers of hundreds of bytes, so this length is representative.
      const content =
        'The following section starts with more than enough text for cumulative-mode detection.';
      const emitted = [content, content].map((chunkContent, index) => {
        const chunk = converter.convertOpenAIChunkToGemini(
          {
            object: 'chat.completion.chunk',
            id: `chunk-cumulative-repeat-${index}`,
            created: 456 + index,
            choices: [
              {
                index: 0,
                delta: { content: chunkContent },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        );

        return chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      });

      expect(emitted).toEqual([content, '']);
    });

    it('should preserve repeated short incremental content chunks', () => {
      const ctx = withStreamParser();
      const emitted = ['ha', 'ha'].map((content, index) => {
        const chunk = converter.convertOpenAIChunkToGemini(
          {
            object: 'chat.completion.chunk',
            id: `chunk-repeat-${index}`,
            created: 456 + index,
            choices: [
              {
                index: 0,
                delta: { content },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        );

        return chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      });

      expect(emitted).toEqual(['ha', 'ha']);
    });

    it('should normalize cumulative streaming reasoning_content deltas to suffixes', () => {
      const ctx = withStreamParser();
      const chunks = [
        'Let me think',
        'Let me think about the request carefully.',
        'Let me think about the request carefully.\nFirst, identify the table format.',
      ];

      const emitted = chunks.map((reasoning_content, index) => {
        const chunk = converter.convertOpenAIChunkToGemini(
          {
            object: 'chat.completion.chunk',
            id: `chunk-reasoning-cumulative-${index}`,
            created: 456 + index,
            choices: [
              {
                index: 0,
                delta: { reasoning_content },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        );

        const part = chunk.candidates?.[0]?.content?.parts?.[0];
        return { text: part?.text ?? '', thought: part?.thought ?? false };
      });

      expect(emitted).toEqual([
        { text: 'Let me think', thought: true },
        { text: ' about the request carefully.', thought: true },
        { text: '\nFirst, identify the table format.', thought: true },
      ]);
      expect(emitted.map((e) => e.text).join('')).toBe(
        chunks[chunks.length - 1],
      );
    });

    it('should exit cumulative mode when a chunk does not match prior accumulated text', () => {
      const ctx = withStreamParser();
      // Three chunks that establish cumulative mode, then one that breaks it.
      const chunks = [
        'Step one is to gather inputs.',
        'Step one is to gather inputs.\nStep two is to validate them.',
        'Brand new unrelated message.',
      ];

      const emitted = chunks.map((content, index) => {
        const chunk = converter.convertOpenAIChunkToGemini(
          {
            object: 'chat.completion.chunk',
            id: `chunk-cumulative-exit-${index}`,
            created: 456 + index,
            choices: [
              {
                index: 0,
                delta: { content },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        );

        return chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      });

      // Chunk 1: emits as-is (initial)
      // Chunk 2: cumulative mode entered, emits suffix only
      // Chunk 3: NOT a prefix-extension — cumulative mode must exit and the
      //          new chunk must be appended verbatim (no silent loss)
      expect(emitted[0]).toBe('Step one is to gather inputs.');
      expect(emitted[1]).toBe('\nStep two is to validate them.');
      expect(emitted[2]).toBe('Brand new unrelated message.');
    });

    it('should resume prefix detection cleanly after exiting cumulative mode', () => {
      const ctx = withStreamParser();
      // Establish cumulative mode, then break it, then send another cumulative
      // stream — the fresh baseline should allow re-entry into cumulative mode.
      const chunks = [
        'Step one is to gather inputs.',
        'Step one is to gather inputs.\nStep two is to validate them.',
        'Brand new unrelated message.',
        'Brand new unrelated message. And more.',
      ];

      const emitted = chunks.map(
        (content, index) =>
          converter.convertOpenAIChunkToGemini(
            {
              object: 'chat.completion.chunk',
              id: `chunk-reentry-${index}`,
              created: 456 + index,
              choices: [
                {
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
              model: 'gpt-test',
            } as unknown as OpenAI.Chat.ChatCompletionChunk,
            ctx,
          ).candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      );

      expect(emitted[0]).toBe('Step one is to gather inputs.');
      expect(emitted[1]).toBe('\nStep two is to validate them.');
      // Cumulative mode exits; fresh baseline = chunk 3
      expect(emitted[2]).toBe('Brand new unrelated message.');
      // Chunk 4 prefix-extends chunk 3 — re-enters cumulative, emits suffix only
      expect(emitted[3]).toBe(' And more.');
    });

    it('should not poison the baseline when short chunks repeat before threshold', () => {
      const ctx = withStreamParser();
      // Short exact-repeat followed by a prefix-extending chunk.
      // The repeat must NOT corrupt emittedText so the extension is detected.
      const chunks = ['Hi', 'Hi', 'Hi there, how are you today?'];

      const emitted = chunks.map(
        (content, index) =>
          converter.convertOpenAIChunkToGemini(
            {
              object: 'chat.completion.chunk',
              id: `chunk-short-repeat-${index}`,
              created: 456 + index,
              choices: [
                {
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
              model: 'gpt-test',
            } as unknown as OpenAI.Chat.ChatCompletionChunk,
            ctx,
          ).candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      );

      // Chunk 1: initial
      expect(emitted[0]).toBe('Hi');
      // Chunk 2: short exact repeat — passthrough, baseline stays 'Hi'
      expect(emitted[1]).toBe('Hi');
      // Chunk 3: prefix-extends 'Hi' — enters cumulative, emits suffix
      expect(emitted[2]).toBe(' there, how are you today?');
    });

    it('should normalize cumulative reasoning_content deltas across multi-line growth (newline-prefixed suffixes)', () => {
      // Distinct from the single-line cumulative reasoning test above:
      // this case grows the accumulated text across newline boundaries so the
      // emitted suffixes themselves begin with '\n', exercising the slice
      // arithmetic at the newline.
      const ctx = withStreamParser();
      const chunks = [
        'Let me reason step by step.',
        'Let me reason step by step.\nFirst: check the inputs.',
        'Let me reason step by step.\nFirst: check the inputs.\nSecond: validate.',
      ];

      const emitted = chunks.map((reasoning_content, index) => {
        const part = converter.convertOpenAIChunkToGemini(
          {
            object: 'chat.completion.chunk',
            id: `chunk-reasoning-cumulative2-${index}`,
            created: 456 + index,
            choices: [
              {
                index: 0,
                delta: { reasoning_content },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        ).candidates?.[0]?.content?.parts?.[0];
        return { text: part?.text ?? '', thought: part?.thought ?? false };
      });

      expect(emitted[0]).toEqual({
        text: 'Let me reason step by step.',
        thought: true,
      });
      expect(emitted[1]).toEqual({
        text: '\nFirst: check the inputs.',
        thought: true,
      });
      expect(emitted[2]).toEqual({
        text: '\nSecond: validate.',
        thought: true,
      });
    });

    it('should ignore repeated cumulative reasoning_content chunks with no new suffix', () => {
      // Mirrors the content-channel `should ignore repeated cumulative chunks
      // with no new suffix` test: the reasoning channel uses a separate state
      // object, so the exact-repeat entry path is exercised independently.
      const ctx = withStreamParser();
      // Must be ≥ CUMULATIVE_DELTA_EXACT_REPEAT_MIN_LENGTH (64 chars).
      const reasoning =
        'The reasoning section also starts with more than enough text to pass detection.';
      const emitted = [reasoning, reasoning].map((reasoning_content, index) => {
        const part = converter.convertOpenAIChunkToGemini(
          {
            object: 'chat.completion.chunk',
            id: `chunk-reasoning-repeat-${index}`,
            created: 456 + index,
            choices: [
              {
                index: 0,
                delta: { reasoning_content },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        ).candidates?.[0]?.content?.parts?.[0];
        return { text: part?.text ?? '', thought: part?.thought ?? false };
      });

      // Chunk 1: emits as a thought part.
      expect(emitted[0]).toEqual({ text: reasoning, thought: true });
      // Chunk 2: exact repeat — enters cumulative mode, suppressed (no part).
      expect(emitted[1]).toEqual({ text: '', thought: false });
    });

    it('should exit cumulative mode on reasoning_content channel when chunk does not match prior accumulated text', () => {
      // Mirrors the content-channel `should exit cumulative mode` test against
      // the reasoning channel's independent state.
      const ctx = withStreamParser();
      const chunks = [
        'Step one of my reasoning is to gather inputs.',
        'Step one of my reasoning is to gather inputs.\nStep two: validate.',
        'Brand new unrelated reasoning.',
      ];

      const emitted = chunks.map((reasoning_content, index) => {
        const part = converter.convertOpenAIChunkToGemini(
          {
            object: 'chat.completion.chunk',
            id: `chunk-reasoning-exit-${index}`,
            created: 456 + index,
            choices: [
              {
                index: 0,
                delta: { reasoning_content },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        ).candidates?.[0]?.content?.parts?.[0];
        return { text: part?.text ?? '', thought: part?.thought ?? false };
      });

      // Chunk 1: initial passthrough.
      expect(emitted[0]).toEqual({
        text: 'Step one of my reasoning is to gather inputs.',
        thought: true,
      });
      // Chunk 2: cumulative mode entered, emits suffix only.
      expect(emitted[1]).toEqual({
        text: '\nStep two: validate.',
        thought: true,
      });
      // Chunk 3: NOT a prefix-extension — cumulative mode must exit and the
      //          new chunk must be appended verbatim (no silent loss).
      expect(emitted[2]).toEqual({
        text: 'Brand new unrelated reasoning.',
        thought: true,
      });
    });

    it('should resume prefix detection on reasoning_content channel after exiting cumulative mode', () => {
      // Mirrors the content-channel `should resume prefix detection cleanly
      // after exiting cumulative mode` test. After the exit path resets the
      // baseline to the new chunk, the reasoning channel must be able to
      // re-enter cumulative mode on the next prefix-extending chunk.
      const ctx = withStreamParser();
      const chunks = [
        'Step one of my reasoning is to gather inputs.',
        'Step one of my reasoning is to gather inputs.\nStep two: validate.',
        'Brand new unrelated reasoning.',
        'Brand new unrelated reasoning. And further reflection.',
      ];

      const emitted = chunks.map((reasoning_content, index) => {
        const part = converter.convertOpenAIChunkToGemini(
          {
            object: 'chat.completion.chunk',
            id: `chunk-reasoning-reentry-${index}`,
            created: 456 + index,
            choices: [
              {
                index: 0,
                delta: { reasoning_content },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        ).candidates?.[0]?.content?.parts?.[0];
        return { text: part?.text ?? '', thought: part?.thought ?? false };
      });

      expect(emitted[0]).toEqual({
        text: 'Step one of my reasoning is to gather inputs.',
        thought: true,
      });
      expect(emitted[1]).toEqual({
        text: '\nStep two: validate.',
        thought: true,
      });
      // Cumulative mode exits; fresh baseline = chunk 3.
      expect(emitted[2]).toEqual({
        text: 'Brand new unrelated reasoning.',
        thought: true,
      });
      // Chunk 4 prefix-extends chunk 3 — re-enters cumulative, emits suffix only.
      expect(emitted[3]).toEqual({
        text: ' And further reflection.',
        thought: true,
      });
    });

    it('should deduplicate interleaved reasoning_content and content channels independently', () => {
      const ctx = withStreamParser();
      // reasoning_content and content each use a separate state object;
      // cumulative detection in one channel must not bleed into the other.
      const chunks: Array<{ reasoning_content?: string; content?: string }> = [
        { reasoning_content: 'Let me think about this carefully.' },
        { content: 'Here' },
        { reasoning_content: 'Let me think about this carefully.\nStep two.' },
        { content: 'Here is the answer.' },
      ];

      const emitted = chunks.map(
        (delta, index) =>
          converter.convertOpenAIChunkToGemini(
            {
              object: 'chat.completion.chunk',
              id: `chunk-interleaved-${index}`,
              created: 456 + index,
              choices: [
                {
                  index: 0,
                  delta,
                  finish_reason: null,
                  logprobs: null,
                },
              ],
              model: 'gpt-test',
            } as unknown as OpenAI.Chat.ChatCompletionChunk,
            ctx,
          ).candidates?.[0]?.content?.parts ?? [],
      );

      // Reasoning chunk 1: emits as thought
      expect(emitted[0]).toEqual([
        { text: 'Let me think about this carefully.', thought: true },
      ]);
      // Content chunk 1: emits as text (independent state)
      expect(emitted[1]).toEqual([{ text: 'Here' }]);
      // Reasoning chunk 2: cumulative extension — emits suffix only
      expect(emitted[2]).toEqual([{ text: '\nStep two.', thought: true }]);
      // Content chunk 2: cumulative extension of content channel
      expect(emitted[3]).toEqual([{ text: ' is the answer.' }]);
    });

    it('should enter cumulative mode on exact 64-char repeat (at threshold)', () => {
      const ctx = withStreamParser();
      // Exactly 64 chars — meets CUMULATIVE_DELTA_EXACT_REPEAT_MIN_LENGTH.
      // The threshold sits well above realistic legit-repeat lengths (e.g. a
      // duplicate `import { foo } from './module';` is ~31 chars) so that
      // legitimate repeats are never silently suppressed.
      const atThreshold = 'A'.repeat(64);
      const chunks = [atThreshold, atThreshold, atThreshold + ' and more'];

      const emitted = chunks.map(
        (content, index) =>
          converter.convertOpenAIChunkToGemini(
            {
              object: 'chat.completion.chunk',
              id: `chunk-threshold64-${index}`,
              created: 456 + index,
              choices: [
                {
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
              model: 'gpt-test',
            } as unknown as OpenAI.Chat.ChatCompletionChunk,
            ctx,
          ).candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      );

      // Chunk 1: initial passthrough
      expect(emitted[0]).toBe(atThreshold);
      // Chunk 2: exact 64-char repeat — enters cumulative mode, suppressed
      expect(emitted[1]).toBe('');
      // Chunk 3: cumulative extension — emits suffix only
      expect(emitted[2]).toBe(' and more');
    });

    it('should pass through 63-char exact repeat without entering cumulative mode (below threshold)', () => {
      const ctx = withStreamParser();
      // 63 chars — one short of CUMULATIVE_DELTA_EXACT_REPEAT_MIN_LENGTH
      const belowThreshold = 'A'.repeat(63);
      const chunks = [
        belowThreshold,
        belowThreshold,
        belowThreshold + ' extra',
      ];

      const emitted = chunks.map(
        (content, index) =>
          converter.convertOpenAIChunkToGemini(
            {
              object: 'chat.completion.chunk',
              id: `chunk-threshold63-${index}`,
              created: 456 + index,
              choices: [
                {
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
              model: 'gpt-test',
            } as unknown as OpenAI.Chat.ChatCompletionChunk,
            ctx,
          ).candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      );

      // Chunk 1: initial passthrough
      expect(emitted[0]).toBe(belowThreshold);
      // Chunk 2: 63-char repeat — below threshold, passes through unchanged
      expect(emitted[1]).toBe(belowThreshold);
      // Chunk 3: prefix-extends prior — enters cumulative, emits suffix only
      expect(emitted[2]).toBe(' extra');
    });

    it('should preserve legitimate duplicate import-line chunks (regression: silent data loss)', () => {
      // Regression for https://github.com/QwenLM/qwen-code/pull/3896 review
      // (wenshao, 2026-05-13 CHANGES_REQUESTED, finding #1). Realistic
      // incremental streams emit duplicate import/boilerplate lines and the
      // exact-repeat threshold must be high enough that those legitimate
      // repeats are NOT silently suppressed. A duplicate ~31-char import is
      // the canonical motivating case.
      const ctx = withStreamParser();
      const importLine = "import { foo } from './module';"; // 31 chars
      const chunks = [importLine, importLine, '\nconst x = 1;'];

      const emitted = chunks.map(
        (content, index) =>
          converter.convertOpenAIChunkToGemini(
            {
              object: 'chat.completion.chunk',
              id: `chunk-import-${index}`,
              created: 456 + index,
              choices: [
                {
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
              model: 'gpt-test',
            } as unknown as OpenAI.Chat.ChatCompletionChunk,
            ctx,
          ).candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      );

      // All three chunks must reach the user — no suppression.
      expect(emitted[0]).toBe(importLine);
      expect(emitted[1]).toBe(importLine);
      expect(emitted[2]).toBe('\nconst x = 1;');
      // Sanity: the reassembled stream equals the user-visible total.
      expect(emitted.join('')).toBe(importLine + importLine + '\nconst x = 1;');
    });

    it('should pass incremental chunks through verbatim past the detection window cap (none of them overlap)', () => {
      // Incremental providers send fresh, non-overlapping chunks. Even after
      // emittedText growth exceeds CUMULATIVE_DETECTION_WINDOW_BYTES (1024)
      // and the baseline stops growing, every subsequent chunk that lacks
      // prefix overlap with the frozen baseline must still be emitted
      // verbatim (i.e., it must fall through to the final passthrough
      // branch). This guards against any future regression that would, e.g.,
      // wrongly short-circuit the passthrough path once the cap is reached.
      //
      // Note: this test does NOT cover the (currently unhandled) case where a
      // later chunk happens to start with the frozen baseline — that chunk
      // would still trigger prefix-overlap detection against a stale
      // baseline. Such a chunk is vanishingly unlikely on a true incremental
      // stream (≥1024 bytes of exact-prefix coincidence) but is not
      // explicitly defended against here.
      const ctx = withStreamParser();
      // 100 distinct incremental chunks of 20 chars = 2000 chars, well past the cap.
      const incrementalChunks = Array.from(
        { length: 100 },
        (_, i) => `chunk${String(i).padStart(3, '0')}-payload__`,
      );
      const allEmitted = incrementalChunks.map(
        (content, index) =>
          converter.convertOpenAIChunkToGemini(
            {
              object: 'chat.completion.chunk',
              id: `chunk-cap-${index}`,
              created: 456 + index,
              choices: [
                {
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
              model: 'gpt-test',
            } as unknown as OpenAI.Chat.ChatCompletionChunk,
            ctx,
          ).candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      );

      // Every chunk should pass through verbatim — none of them overlap
      // with prior emittedText, so prefix/exact-repeat detection never fires.
      expect(allEmitted).toEqual(incrementalChunks);
    });

    it('should detect cumulative mode even when the first chunk exceeds the detection window cap', () => {
      // Regression for https://github.com/QwenLM/qwen-code/pull/3896 review:
      // Some cumulative providers ship a large initial chunk (>1024 chars)
      // and then accumulate more text on subsequent chunks. The detection
      // window cap must not short-circuit prefix-overlap detection before the
      // second chunk gets a chance to be classified, otherwise the entire
      // first chunk gets duplicated.
      const ctx = withStreamParser();
      const firstChunk = 'A'.repeat(1500); // well past CUMULATIVE_DETECTION_WINDOW_BYTES (1024)
      const secondChunk = firstChunk + 'B'.repeat(200); // cumulative extension
      const thirdChunk = secondChunk + 'C'.repeat(50); // further cumulative extension

      const emitted = [firstChunk, secondChunk, thirdChunk].map(
        (content, index) =>
          converter.convertOpenAIChunkToGemini(
            {
              object: 'chat.completion.chunk',
              id: `chunk-large-first-${index}`,
              created: 789 + index,
              choices: [
                {
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
              model: 'gpt-test',
            } as unknown as OpenAI.Chat.ChatCompletionChunk,
            ctx,
          ).candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      );

      // Chunk 1: initial passthrough.
      expect(emitted[0]).toBe(firstChunk);
      // Chunk 2: prefix-extends → cumulative mode, emits the 200-char suffix only.
      expect(emitted[1]).toBe('B'.repeat(200));
      // Chunk 3: continues in cumulative mode, emits only the new 50-char suffix.
      expect(emitted[2]).toBe('C'.repeat(50));
    });

    it('should not duplicate emitted bytes when an incremental stream transitions into cumulative mode past the window cap', () => {
      // Regression for https://github.com/QwenLM/qwen-code/pull/3896 review
      // (wenshao, 2026-05-13 CHANGES_REQUESTED, finding #2). Hybrid scenario:
      // upstream emits 200 distinct incremental chunks of 8 bytes each (1600
      // bytes of user-visible content, well past the 1024-byte detection-
      // window cap), then sends a single cumulative chunk that replays the
      // full 1600 bytes and appends new content. The internal baseline froze
      // at 1024 bytes; without tracking the true emitted length, the suffix
      // would be sliced from byte 1024 of the cumulative chunk and the user
      // would see bytes 1024..1600 a second time. The fix tracks emittedLength
      // separately so the slice starts from the real user-visible boundary
      // (1600). The chunks must be DISTINCT (otherwise the short-exact-repeat
      // branch keeps emittedText pinned and the cap is never reached).
      const ctx = withStreamParser();
      const incremental = Array.from(
        { length: 200 },
        (_, i) => `c${String(i).padStart(3, '0')}=AB_`, // 8 bytes, distinct per chunk
      );
      const accumulated = incremental.join(''); // 1600 bytes
      const tail = '|CONTINUATION|'; // 14 bytes
      const cumulativeChunk = accumulated + tail; // 1614 bytes

      const incrementalEmitted = incremental.map(
        (content, index) =>
          converter.convertOpenAIChunkToGemini(
            {
              object: 'chat.completion.chunk',
              id: `chunk-hybrid-incr-${index}`,
              created: 1000 + index,
              choices: [
                {
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
              model: 'gpt-test',
            } as unknown as OpenAI.Chat.ChatCompletionChunk,
            ctx,
          ).candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      );

      const cumulativeEmitted =
        converter.convertOpenAIChunkToGemini(
          {
            object: 'chat.completion.chunk',
            id: 'chunk-hybrid-cum',
            created: 2000,
            choices: [
              {
                index: 0,
                delta: { content: cumulativeChunk },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        ).candidates?.[0]?.content?.parts?.[0]?.text ?? '';

      // Incremental phase: every chunk passes through verbatim.
      expect(incrementalEmitted).toEqual(incremental);
      // Cumulative chunk: only the new 14-byte tail must be emitted — not the
      // ~576 bytes between the cap (1024) and the true emitted total (1600).
      expect(cumulativeEmitted).toBe(tail);
      // Sanity: reassembled stream equals the original accumulated text.
      const userVisible = incrementalEmitted.join('') + cumulativeEmitted;
      expect(userVisible).toBe(cumulativeChunk);
      expect(userVisible.length).toBe(1614);
    });

    it('should suppress cumulative rewind (provider re-sends shorter accumulated string)', () => {
      const ctx = withStreamParser();
      // Scenario: provider sends Hello → Hello World (extension) → Hello (rewind) → Hello World! (extension again)
      const chunks = ['Hello', 'Hello World', 'Hello', 'Hello World!'];

      const emitted = chunks.map(
        (content, index) =>
          converter.convertOpenAIChunkToGemini(
            {
              object: 'chat.completion.chunk',
              id: `chunk-rewind-${index}`,
              created: 456 + index,
              choices: [
                {
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
              model: 'gpt-test',
            } as unknown as OpenAI.Chat.ChatCompletionChunk,
            ctx,
          ).candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      );

      // Chunk 1: initial passthrough
      expect(emitted[0]).toBe('Hello');
      // Chunk 2: prefix-extends 'Hello' → enters cumulative, emits suffix
      expect(emitted[1]).toBe(' World');
      // Chunk 3: rewind — 'Hello' is a strict prefix of emitted 'Hello World' → suppressed
      expect(emitted[2]).toBe('');
      // Chunk 4: extension resumes from 'Hello World' → emits '!'
      expect(emitted[3]).toBe('!');
    });

    it('should still call into convertOpenAITextToParts on finish_reason when the cumulative-mode normalized delta is empty', () => {
      // Targets the `normalizedContent || choice.finish_reason` guard on the
      // content path: in cumulative mode an exact-repeat final chunk yields a
      // normalized delta of '' but must still flush buffered tagged-thinking
      // content (and any other finish-time side effects) via
      // convertOpenAITextToParts. The earlier cumulative tests all use
      // `finish_reason: null`, so this exercises the empty-normalized +
      // non-null finish_reason path in a cumulative context.
      const ctx = withStreamParser();
      // 1) Prefix-extension chunk pair establishes cumulative mode and primes
      //    `emittedText` so the next exact-repeat is the cumulative branch.
      converter.convertOpenAIChunkToGemini(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-cum-empty-finish-0',
          created: 456,
          choices: [
            {
              index: 0,
              delta: { content: 'Answer: forty-two' },
              finish_reason: null,
              logprobs: null,
            },
          ],
          model: 'gpt-test',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        ctx,
      );
      converter.convertOpenAIChunkToGemini(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-cum-empty-finish-1',
          created: 457,
          choices: [
            {
              index: 0,
              delta: { content: 'Answer: forty-two and more.' },
              finish_reason: null,
              logprobs: null,
            },
          ],
          model: 'gpt-test',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        ctx,
      );

      // 2) Final chunk: re-sends the accumulated string verbatim along with
      //    `finish_reason: 'stop'`. The normalized delta is '' (cumulative
      //    suffix-of-self), but the finish_reason must still drive
      //    convertOpenAITextToParts.
      const finalChunk = converter.convertOpenAIChunkToGemini(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-cum-empty-finish-2',
          created: 458,
          choices: [
            {
              index: 0,
              delta: { content: 'Answer: forty-two and more.' },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          model: 'gpt-test',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        ctx,
      );

      // The cumulative-suppressed empty delta produces no text part, but
      // because finish_reason is set, the converter still reaches the parts
      // pipeline; on a clean (no buffered tag) state this yields parts: [].
      // The crucial invariant: no exception thrown, finishReason propagates,
      // and no spurious duplicate text emerges.
      expect(finalChunk.candidates?.[0]?.finishReason).toBe('STOP');
      const finalText =
        finalChunk.candidates?.[0]?.content?.parts
          ?.filter((p) => 'text' in p)
          ?.map((p) => (p as { text: string }).text)
          ?.join('') ?? '';
      expect(finalText).toBe('');
    });

    it('should handle a single chunk delta with both reasoning_content and content simultaneously', () => {
      const ctx = withStreamParser();
      const part =
        converter.convertOpenAIChunkToGemini(
          {
            object: 'chat.completion.chunk',
            id: 'chunk-dual-1',
            created: 456,
            choices: [
              {
                index: 0,
                delta: {
                  reasoning_content: 'I need to think.',
                  content: 'Here is my answer.',
                },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        ).candidates?.[0]?.content?.parts ?? [];

      // Both channels should emit independently in the same response
      const thoughtPart = part.find((p) => p.thought === true);
      const textPart = part.find((p) => !p.thought);
      expect(thoughtPart?.text).toBe('I need to think.');
      expect(textPart?.text).toBe('Here is my answer.');
    });
  });

  describe('OpenAI -> Gemini tagged thinking content', () => {
    it('should convert MiniMax <think> content to thought parts for non-streaming responses', () => {
      const response = converter.convertOpenAIResponseToGemini(
        {
          object: 'chat.completion',
          id: 'chatcmpl-minimax-1',
          created: 123,
          model: 'MiniMax-M2.7',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '<think>internal reasoning</think>final answer',
              },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletion,
        withTaggedThinkingOptions(),
      );

      expect(response.candidates?.[0]?.content?.parts).toEqual([
        { text: 'internal reasoning', thought: true },
        { text: 'final answer' },
      ]);
    });

    it('should preserve ordering around <thinking> blocks', () => {
      const response = converter.convertOpenAIResponseToGemini(
        {
          object: 'chat.completion',
          id: 'chatcmpl-minimax-2',
          created: 123,
          model: 'MiniMax-M2.7',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'before<thinking>hidden</thinking>after',
              },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletion,
        withTaggedThinkingOptions(),
      );

      expect(response.candidates?.[0]?.content?.parts).toEqual([
        { text: 'before' },
        { text: 'hidden', thought: true },
        { text: 'after' },
      ]);
    });

    it('should parse multiple tagged thinking blocks case-insensitively', () => {
      const response = converter.convertOpenAIResponseToGemini(
        {
          object: 'chat.completion',
          id: 'chatcmpl-minimax-3',
          created: 123,
          model: 'MiniMax-M2.7',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '<THINK>a</THINK>visible<Thinking>b</Thinking>',
              },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletion,
        withTaggedThinkingOptions(),
      );

      expect(response.candidates?.[0]?.content?.parts).toEqual([
        { text: 'a', thought: true },
        { text: 'visible' },
        { text: 'b', thought: true },
      ]);
    });

    it('should leave tags visible when tagged thinking parsing is disabled', () => {
      const response = converter.convertOpenAIResponseToGemini(
        {
          object: 'chat.completion',
          id: 'chatcmpl-openai-1',
          created: 123,
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '<think>visible xml example</think>',
              },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletion,
        requestContext,
      );

      expect(response.candidates?.[0]?.content?.parts).toEqual([
        { text: '<think>visible xml example</think>' },
      ]);
    });

    it('should preserve incomplete tags as visible text on final non-streaming parse', () => {
      const response = converter.convertOpenAIResponseToGemini(
        {
          object: 'chat.completion',
          id: 'chatcmpl-minimax-4',
          created: 123,
          model: 'MiniMax-M2.7',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'final answer <thi',
              },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletion,
        withTaggedThinkingOptions(),
      );

      expect(response.candidates?.[0]?.content?.parts).toEqual([
        { text: 'final answer <thi' },
      ]);
    });

    it('should parse streaming tags split across chunks', () => {
      const context = withTaggedThinkingStreamParser();

      const firstChunk = converter.convertOpenAIChunkToGemini(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-minimax-1',
          created: 456,
          choices: [
            {
              index: 0,
              delta: { content: 'pre <thi' },
              finish_reason: null,
              logprobs: null,
            },
          ],
          model: 'MiniMax-M2.7',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );
      const secondChunk = converter.convertOpenAIChunkToGemini(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-minimax-2',
          created: 457,
          choices: [
            {
              index: 0,
              delta: { content: 'nk>hidden</thi' },
              finish_reason: null,
              logprobs: null,
            },
          ],
          model: 'MiniMax-M2.7',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );
      const finalChunk = converter.convertOpenAIChunkToGemini(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-minimax-3',
          created: 458,
          choices: [
            {
              index: 0,
              delta: { content: 'nk> visible' },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          model: 'MiniMax-M2.7',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );

      expect(firstChunk.candidates?.[0]?.content?.parts).toEqual([
        { text: 'pre ' },
      ]);
      expect(secondChunk.candidates?.[0]?.content?.parts).toEqual([
        { text: 'hidden', thought: true },
      ]);
      expect(finalChunk.candidates?.[0]?.content?.parts).toEqual([
        { text: ' visible' },
      ]);
    });

    it('should flush unclosed streaming thinking content on finish', () => {
      const context = withTaggedThinkingStreamParser();

      const chunk = converter.convertOpenAIChunkToGemini(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-minimax-unclosed',
          created: 456,
          choices: [
            {
              index: 0,
              delta: { content: 'answer <think>still thinking' },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          model: 'MiniMax-M2.7',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );

      expect(chunk.candidates?.[0]?.content?.parts).toEqual([
        { text: 'answer ' },
        { text: 'still thinking', thought: true },
      ]);
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

  describe('mergeConsecutiveAssistantMessages', () => {
    it('should merge two consecutive assistant messages with string content', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [{ text: 'First part' }],
          },
          {
            role: 'model',
            parts: [{ text: 'Second part' }],
          },
        ],
      };

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('assistant');
      expect(messages[0].content).toBe('First partSecond part');
    });

    it('should merge multiple consecutive assistant messages', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [{ text: 'Part 1' }],
          },
          {
            role: 'model',
            parts: [{ text: 'Part 2' }],
          },
          {
            role: 'model',
            parts: [{ text: 'Part 3' }],
          },
        ],
      };

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('assistant');
      expect(messages[0].content).toBe('Part 1Part 2Part 3');
    });

    it('should merge tool_calls from consecutive assistant messages', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
                  name: 'tool_1',
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
                  name: 'tool_1',
                  response: { output: 'result_1' },
                },
              },
            ],
          },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_2',
                  name: 'tool_2',
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
                  id: 'call_2',
                  name: 'tool_2',
                  response: { output: 'result_2' },
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
        {
          cleanOrphanToolCalls: false,
        },
      );

      // Should have: assistant (tool_call_1), tool (result_1), assistant (tool_call_2), tool (result_2)
      expect(messages).toHaveLength(4);
      expect(messages[0].role).toBe('assistant');
      expect(messages[1].role).toBe('tool');
      expect(messages[2].role).toBe('assistant');
      expect(messages[3].role).toBe('tool');
    });

    it('should not merge assistant messages separated by user messages', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [{ text: 'First assistant' }],
          },
          {
            role: 'user',
            parts: [{ text: 'User message' }],
          },
          {
            role: 'model',
            parts: [{ text: 'Second assistant' }],
          },
        ],
      };

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );

      expect(messages).toHaveLength(3);
      expect(messages[0].role).toBe('assistant');
      expect(messages[1].role).toBe('user');
      expect(messages[2].role).toBe('assistant');
    });

    it('should handle merging when one message has array content and another has string', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [{ text: 'Text part' }],
          },
          {
            role: 'model',
            parts: [{ text: 'Another text' }],
          },
        ],
      };

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Text partAnother text');
    });

    it('should merge empty content correctly', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [{ text: 'First' }],
          },
          {
            role: 'model',
            parts: [],
          },
          {
            role: 'model',
            parts: [{ text: 'Second' }],
          },
        ],
      };

      const messages = converter.convertGeminiRequestToOpenAI(
        request,
        requestContext,
      );

      // Empty messages should be filtered out
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('FirstSecond');
    });
  });
});

describe('MCP tool result end-to-end through OpenAI converter (issue #1520)', () => {
  /**
   * End-to-end regression tests for https://github.com/QwenLM/qwen-code/issues/1520
   *
   * Simulates the full pipeline:
   *   transformMcpContentToParts → convertToFunctionResponse → OpenAI converter
   *
   * Verifies that multi-part MCP tool results are properly carried through
   * into the OpenAI tool message, with no content leaking into user messages.
   */
  let converter: typeof OpenAIContentConverter;
  let requestContext: RequestContext;

  beforeEach(() => {
    converter = OpenAIContentConverter;
    requestContext = {
      model: 'test-model',
      modalities: {
        image: true,
        pdf: true,
        audio: true,
        video: true,
      },
      startTime: 0,
    };
  });

  it('should preserve MCP multi-text content in tool message (not leak to user message)', () => {
    // Step 1: Simulate what transformMcpContentToParts returns for a Figma
    // tool that returns code + instructions as two text blocks
    const mcpTransformedParts: Part[] = [
      { text: '<div data-node-id="38:521"><h1>Welcome</h1></div>' },
      {
        text: 'SUPER CRITICAL: Convert the React+Tailwind code to match the target stack.',
      },
    ];

    // Step 2: convertToFunctionResponse wraps the MCP result
    const callId = 'call_figma_1';
    const toolName = 'figma_get_code';
    const responseParts = convertToFunctionResponse(
      toolName,
      callId,
      mcpTransformedParts,
    );

    // Step 3: Build the conversation history (model tool call + tool result)
    const contents: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: callId,
              name: toolName,
              args: { nodeId: '38:521' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: responseParts,
      },
    ];

    // Step 4: Convert to OpenAI format
    const request: GenerateContentParameters = {
      model: 'models/test',
      contents,
    };
    const messages = converter.convertGeminiRequestToOpenAI(
      request,
      requestContext,
    );

    const toolMessages = messages.filter((m) => m.role === 'tool');
    const userMessages = messages.filter((m) => m.role === 'user');
    const assistantMessages = messages.filter((m) => m.role === 'assistant');

    expect(toolMessages).toHaveLength(1);
    expect(assistantMessages).toHaveLength(1);
    // No content should leak into a user message
    expect(userMessages).toHaveLength(0);

    // Tool message should contain the actual MCP content
    const toolMsg = toolMessages[0];
    expect((toolMsg as { tool_call_id: string }).tool_call_id).toBe(callId);

    const toolContent = toolMsg.content;
    expect(Array.isArray(toolContent)).toBe(true);
    const toolTexts = (toolContent as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === 'text')
      .map((p) => p.text);
    expect(toolTexts).toHaveLength(1);
    expect(toolTexts[0]).toContain('data-node-id');
    expect(toolTexts[0]).toContain('SUPER CRITICAL');
  });

  it('should preserve MCP text+image content in tool message', () => {
    // Simulates MCP tool returning text description + image (e.g., get_screenshot)
    const mcpTransformedParts: Part[] = [
      {
        text: "[Tool 'figma' provided the following image data with mime-type: image/png]",
      },
      {
        inlineData: {
          mimeType: 'image/png',
          data: 'iVBORw0KGgo=',
        },
      },
    ];

    const callId = 'call_figma_2';
    const toolName = 'figma_get_screenshot';
    const responseParts = convertToFunctionResponse(
      toolName,
      callId,
      mcpTransformedParts,
    );

    const contents: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: callId,
              name: toolName,
              args: { nodeId: '38:521' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: responseParts,
      },
    ];

    const request: GenerateContentParameters = {
      model: 'models/test',
      contents,
    };
    const messages = converter.convertGeminiRequestToOpenAI(
      request,
      requestContext,
    );

    const toolMessages = messages.filter((m) => m.role === 'tool');
    const userMessages = messages.filter((m) => m.role === 'user');

    expect(toolMessages).toHaveLength(1);
    // No content should leak into a user message
    expect(userMessages).toHaveLength(0);

    // Tool message should contain both text description and image
    const toolMsg = toolMessages[0];
    const toolContent = toolMsg.content;
    expect(Array.isArray(toolContent)).toBe(true);
    const contentArray = toolContent as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
    expect(contentArray).toHaveLength(2);
    expect(contentArray[0].type).toBe('text');
    expect(contentArray[0].text).toContain('image data');
    expect(contentArray[1].type).toBe('image_url');
    expect(contentArray[1].image_url?.url).toContain('data:image/png');
  });

  it('should work correctly when MCP tool returns a single text part', () => {
    // Single text part — the control case that has always worked
    const mcpTransformedParts: Part[] = [
      { text: 'Single text response from MCP tool' },
    ];

    const callId = 'call_mcp_single';
    const toolName = 'mcp_tool';
    const responseParts = convertToFunctionResponse(
      toolName,
      callId,
      mcpTransformedParts,
    );

    const contents: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: callId,
              name: toolName,
              args: {},
            },
          },
        ],
      },
      {
        role: 'user',
        parts: responseParts,
      },
    ];

    const request: GenerateContentParameters = {
      model: 'models/test',
      contents,
    };
    const messages = converter.convertGeminiRequestToOpenAI(
      request,
      requestContext,
    );

    const toolMessages = messages.filter((m) => m.role === 'tool');
    const userMessages = messages.filter((m) => m.role === 'user');

    expect(toolMessages).toHaveLength(1);
    expect(userMessages).toHaveLength(0);

    const toolMsg = toolMessages[0];
    const toolContent = toolMsg.content;
    expect(Array.isArray(toolContent)).toBe(true);
    const toolTexts = (toolContent as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === 'text')
      .map((p) => p.text);
    expect(toolTexts).toHaveLength(1);
    expect(toolTexts[0]).toBe('Single text response from MCP tool');
  });

  it('should preserve MCP multi-text + multi-image content in tool message', () => {
    // Simulates a complex MCP response with multiple text blocks and images
    const mcpTransformedParts: Part[] = [
      { text: 'Here is the design mockup:' },
      {
        text: "[Tool 'pencil' provided the following image data with mime-type: image/png]",
      },
      {
        inlineData: {
          mimeType: 'image/png',
          data: 'screenshotBase64Data',
        },
      },
      { text: 'And here are the node details...' },
    ];

    const callId = 'call_pencil_1';
    const toolName = 'mcp__pencil__get_screenshot';
    const responseParts = convertToFunctionResponse(
      toolName,
      callId,
      mcpTransformedParts,
    );

    const contents: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: callId,
              name: toolName,
              args: { nodeId: 'vHOGa' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: responseParts,
      },
    ];

    const request: GenerateContentParameters = {
      model: 'models/test',
      contents,
    };
    const messages = converter.convertGeminiRequestToOpenAI(
      request,
      requestContext,
    );

    const toolMessages = messages.filter((m) => m.role === 'tool');
    const userMessages = messages.filter((m) => m.role === 'user');

    expect(toolMessages).toHaveLength(1);
    expect(userMessages).toHaveLength(0);

    const toolMsg = toolMessages[0];
    expect((toolMsg as { tool_call_id: string }).tool_call_id).toBe(callId);

    const toolContent = toolMsg.content;
    expect(Array.isArray(toolContent)).toBe(true);
    const contentArray = toolContent as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;

    // Should have text (all joined) + image
    expect(contentArray).toHaveLength(2);
    expect(contentArray[0].type).toBe('text');
    expect(contentArray[0].text).toContain('design mockup');
    expect(contentArray[0].text).toContain('image data');
    expect(contentArray[0].text).toContain('node details');
    expect(contentArray[1].type).toBe('image_url');
    expect(contentArray[1].image_url?.url).toContain('data:image/png');
  });
});

describe('Truncated tool call detection in streaming', () => {
  let converter: typeof OpenAIContentConverter;

  beforeEach(() => {
    converter = OpenAIContentConverter;
  });

  function createStreamingRequestContext(model = 'test-model'): RequestContext {
    return {
      model,
      modalities: {},
      startTime: 0,
      toolCallParser: new StreamingToolCallParser(),
    };
  }

  /**
   * Helper: feed streaming chunks then a final chunk with finish_reason,
   * and return the Gemini response for the final chunk.
   */
  function feedToolCallChunks(
    conv: typeof OpenAIContentConverter,
    toolCallChunks: Array<{
      index: number;
      id?: string;
      name?: string;
      arguments: string;
    }>,
    finishReason: string,
  ) {
    // One stream-local context covers every chunk of this simulated stream.
    const ctx = createStreamingRequestContext();

    // Feed argument chunks (no finish_reason yet)
    for (const tc of toolCallChunks) {
      conv.convertOpenAIChunkToGemini(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-stream',
          created: 100,
          model: 'test-model',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: tc.index,
                    id: tc.id,
                    type: 'function' as const,
                    function: {
                      name: tc.name,
                      arguments: tc.arguments,
                    },
                  },
                ],
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        ctx,
      );
    }

    // Final chunk with finish_reason
    return conv.convertOpenAIChunkToGemini(
      {
        object: 'chat.completion.chunk',
        id: 'chunk-final',
        created: 101,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: finishReason,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk,
      ctx,
    );
  }

  it('should override finishReason to MAX_TOKENS when tool call JSON is truncated and provider reports "stop"', () => {
    // Simulate: write_file call truncated mid-JSON, provider says "stop"
    const result = feedToolCallChunks(
      converter,
      [
        {
          index: 0,
          id: 'call_1',
          name: 'write_file',
          arguments: '{"file_path": "/tmp/test.cpp"',
          // Missing closing brace and content field — truncated
        },
      ],
      'stop',
    );

    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.MAX_TOKENS);
  });

  it('should override finishReason to MAX_TOKENS when provider reports "tool_calls" but JSON is truncated', () => {
    const result = feedToolCallChunks(
      converter,
      [
        {
          index: 0,
          id: 'call_1',
          name: 'write_file',
          arguments:
            '{"file_path": "/tmp/test.cpp", "content": "partial content',
          // Truncated mid-string
        },
      ],
      'tool_calls',
    );

    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.MAX_TOKENS);
  });

  it('should preserve finishReason STOP when tool call JSON is complete', () => {
    const result = feedToolCallChunks(
      converter,
      [
        {
          index: 0,
          id: 'call_1',
          name: 'write_file',
          arguments: '{"file_path": "/tmp/test.cpp", "content": "hello"}',
        },
      ],
      'stop',
    );

    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
  });

  it('should preserve finishReason MAX_TOKENS when provider already reports "length"', () => {
    const result = feedToolCallChunks(
      converter,
      [
        {
          index: 0,
          id: 'call_1',
          name: 'write_file',
          arguments: '{"file_path": "/tmp/test.cpp"',
        },
      ],
      'length',
    );

    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.MAX_TOKENS);
  });

  it('should still emit the (repaired) function call even when truncated', () => {
    const result = feedToolCallChunks(
      converter,
      [
        {
          index: 0,
          id: 'call_1',
          name: 'write_file',
          arguments: '{"file_path": "/tmp/test.cpp"',
        },
      ],
      'stop',
    );

    const parts = result.candidates?.[0]?.content?.parts ?? [];
    const fnCall = parts.find((p: Part) => p.functionCall);
    expect(fnCall).toBeDefined();
    expect(fnCall?.functionCall?.name).toBe('write_file');
    expect(fnCall?.functionCall?.args).toEqual({
      file_path: '/tmp/test.cpp',
    });
  });

  it('should detect truncation with multi-chunk streaming arguments', () => {
    // Feed arguments in multiple small chunks like real streaming
    const conv = OpenAIContentConverter;
    const ctx = createStreamingRequestContext();

    // Chunk 1: start of JSON with tool metadata
    conv.convertOpenAIChunkToGemini(
      {
        object: 'chat.completion.chunk',
        id: 'c1',
        created: 100,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function' as const,
                  function: { name: 'write_file', arguments: '{"file_' },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk,
      ctx,
    );

    // Chunk 2: more arguments
    conv.convertOpenAIChunkToGemini(
      {
        object: 'chat.completion.chunk',
        id: 'c2',
        created: 100,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: 'path": "/tmp/f.txt", "conten' },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk,
      ctx,
    );

    // Final chunk: finish_reason "stop" but JSON is still incomplete
    const result = conv.convertOpenAIChunkToGemini(
      {
        object: 'chat.completion.chunk',
        id: 'c3',
        created: 101,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk,
      ctx,
    );

    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.MAX_TOKENS);
  });
});

describe('modality filtering', () => {
  function makeRequest(parts: Part[]): GenerateContentParameters {
    return {
      model: 'test-model',
      contents: [{ role: 'user', parts }],
    };
  }

  function makeRequestContext(
    model: string,
    modalities: RequestContext['modalities'],
  ): RequestContext {
    return {
      model,
      modalities,
      startTime: 0,
    };
  }

  function getUserContentParts(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
  ): Array<{ type: string; text?: string }> {
    const userMsg = messages.find((m) => m.role === 'user');
    if (
      !userMsg ||
      !('content' in userMsg) ||
      !Array.isArray(userMsg.content)
    ) {
      return [];
    }
    return userMsg.content as Array<{ type: string; text?: string }>;
  }

  it('replaces image with placeholder when image modality is disabled', () => {
    const conv = OpenAIContentConverter;
    const request = makeRequest([
      {
        inlineData: { mimeType: 'image/png', data: 'abc123' },
        displayName: 'screenshot.png',
      } as unknown as Part,
    ]);
    const messages = conv.convertGeminiRequestToOpenAI(
      request,
      makeRequestContext('deepseek-chat', {}),
    );
    const parts = getUserContentParts(messages);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('image file');
    expect(parts[0].text).toContain('does not support image input');
  });

  it('keeps image when image modality is enabled', () => {
    const conv = OpenAIContentConverter;
    const request = makeRequest([
      {
        inlineData: { mimeType: 'image/png', data: 'abc123' },
      } as unknown as Part,
    ]);
    const messages = conv.convertGeminiRequestToOpenAI(
      request,
      makeRequestContext('gpt-4o', { image: true }),
    );
    const parts = getUserContentParts(messages);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('image_url');
  });

  it('replaces PDF with placeholder when pdf modality is disabled', () => {
    const conv = OpenAIContentConverter;
    const request = makeRequest([
      {
        inlineData: {
          mimeType: 'application/pdf',
          data: 'pdf-data',
          displayName: 'doc.pdf',
        },
      } as unknown as Part,
    ]);
    const messages = conv.convertGeminiRequestToOpenAI(
      request,
      makeRequestContext('test-model', { image: true }),
    );
    const parts = getUserContentParts(messages);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('pdf file');
    expect(parts[0].text).toContain('does not support PDF input');
  });

  it('keeps PDF when pdf modality is enabled', () => {
    const conv = OpenAIContentConverter;
    const request = makeRequest([
      {
        inlineData: {
          mimeType: 'application/pdf',
          data: 'pdf-data',
          displayName: 'doc.pdf',
        },
      } as unknown as Part,
    ]);
    const messages = conv.convertGeminiRequestToOpenAI(
      request,
      makeRequestContext('claude-sonnet', { image: true, pdf: true }),
    );
    const parts = getUserContentParts(messages);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('file');
  });

  it('replaces video with placeholder when video modality is disabled', () => {
    const conv = OpenAIContentConverter;
    const request = makeRequest([
      {
        inlineData: { mimeType: 'video/mp4', data: 'vid-data' },
      } as unknown as Part,
    ]);
    const messages = conv.convertGeminiRequestToOpenAI(
      request,
      makeRequestContext('test-model', {}),
    );
    const parts = getUserContentParts(messages);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('video file');
  });

  it('replaces audio with placeholder when audio modality is disabled', () => {
    const conv = OpenAIContentConverter;
    const request = makeRequest([
      {
        inlineData: { mimeType: 'audio/wav', data: 'audio-data' },
      } as unknown as Part,
    ]);
    const messages = conv.convertGeminiRequestToOpenAI(
      request,
      makeRequestContext('test-model', {}),
    );
    const parts = getUserContentParts(messages);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('audio file');
  });

  it('handles mixed content: keeps text + supported media, replaces unsupported', () => {
    const conv = OpenAIContentConverter;
    const request = makeRequest([
      { text: 'Analyze these files' },
      {
        inlineData: { mimeType: 'image/png', data: 'img-data' },
      } as unknown as Part,
      {
        inlineData: { mimeType: 'video/mp4', data: 'vid-data' },
      } as unknown as Part,
    ]);
    const messages = conv.convertGeminiRequestToOpenAI(
      request,
      makeRequestContext('gpt-4o', { image: true }),
    );
    const parts = getUserContentParts(messages);
    expect(parts).toHaveLength(3);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toBe('Analyze these files');
    expect(parts[1].type).toBe('image_url');
    expect(parts[2].type).toBe('text');
    expect(parts[2].text).toContain('video file');
  });

  it('defaults to text-only when no modalities are specified', () => {
    const conv = OpenAIContentConverter;
    const request = makeRequest([
      {
        inlineData: { mimeType: 'image/png', data: 'img-data' },
      } as unknown as Part,
    ]);
    const messages = conv.convertGeminiRequestToOpenAI(
      request,
      makeRequestContext('unknown-model', {}),
    );
    const parts = getUserContentParts(messages);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('image file');
  });
});
