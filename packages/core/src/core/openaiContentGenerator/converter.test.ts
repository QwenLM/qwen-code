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
  type Part,
  type Tool,
  type CallableTool,
} from '@google/genai';
import type OpenAI from 'openai';
import { convertToFunctionResponse } from '../coreToolScheduler.js';

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

      const messages = converter.convertGeminiRequestToOpenAI(request);
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

      const messages = converter.convertGeminiRequestToOpenAI(request);
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

      const messages = converter.convertGeminiRequestToOpenAI(request);

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

      const messages = converter.convertGeminiRequestToOpenAI(request);

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

      const messages = converter.convertGeminiRequestToOpenAI(request);

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

      const messages = converter.convertGeminiRequestToOpenAI(request);

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

      const messages = converter.convertGeminiRequestToOpenAI(request);

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

      const messages = converter.convertGeminiRequestToOpenAI(request);

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

      const messages = converter.convertGeminiRequestToOpenAI(request);

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

      const messages = converter.convertGeminiRequestToOpenAI(request);

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

      const messages = converter.convertGeminiRequestToOpenAI(request);

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

      const messages = converter.convertGeminiRequestToOpenAI(request);

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

      const messages = converter.convertGeminiRequestToOpenAI(request);
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

      const messages = converter.convertGeminiRequestToOpenAI(request);

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

      const messages = converter.convertGeminiRequestToOpenAI(request);

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

      const messages = converter.convertGeminiRequestToOpenAI(request);

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

    it('should convert reasoning to a thought part for non-streaming responses', () => {
      const response = converter.convertOpenAIResponseToGemini({
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

    it('should convert streaming reasoning delta to a thought part', () => {
      const chunk = converter.convertOpenAIChunkToGemini({
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
      } as unknown as OpenAI.Chat.ChatCompletionChunk);

      const parts = chunk.candidates?.[0]?.content?.parts;
      expect(parts?.[0]).toEqual(
        expect.objectContaining({ thought: true, text: 'thinking...' }),
      );
      expect(parts?.[1]).toEqual(
        expect.objectContaining({ text: 'visible text' }),
      );
    });

    it('should not throw when streaming chunk has no delta', () => {
      const chunk = converter.convertOpenAIChunkToGemini({
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
      } as unknown as OpenAI.Chat.ChatCompletionChunk);

      const parts = chunk.candidates?.[0]?.content?.parts;
      expect(parts).toEqual([]);
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

      const messages = converter.convertGeminiRequestToOpenAI(request);

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

      const messages = converter.convertGeminiRequestToOpenAI(request);

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

      const messages = converter.convertGeminiRequestToOpenAI(request, {
        cleanOrphanToolCalls: false,
      });

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

      const messages = converter.convertGeminiRequestToOpenAI(request);

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

      const messages = converter.convertGeminiRequestToOpenAI(request);

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

      const messages = converter.convertGeminiRequestToOpenAI(request);

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
  let converter: OpenAIContentConverter;

  beforeEach(() => {
    converter = new OpenAIContentConverter('test-model');
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
    const messages = converter.convertGeminiRequestToOpenAI(request);

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
    const messages = converter.convertGeminiRequestToOpenAI(request);

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
    const messages = converter.convertGeminiRequestToOpenAI(request);

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
    const messages = converter.convertGeminiRequestToOpenAI(request);

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
