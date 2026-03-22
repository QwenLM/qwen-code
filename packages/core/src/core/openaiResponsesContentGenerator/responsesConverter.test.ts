/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FinishReason } from '@google/genai';
import type { ResponsesSSEEvent } from './types.js';
import {
  ResponsesStreamState,
  convertResponsesEventToGemini,
  convertGeminiContentsToResponsesInput,
  convertGeminiToolsToResponsesTools,
} from './responsesConverter.js';
import type { GenerateContentParameters } from '@google/genai';

describe('ResponsesConverter', () => {
  let state: ResponsesStreamState;
  const model = 'codex-mini';

  beforeEach(() => {
    state = new ResponsesStreamState();
  });

  describe('convertResponsesEventToGemini', () => {
    it('should store responseId on response.created', () => {
      const event: ResponsesSSEEvent = {
        event: 'response.created',
        data: { id: 'resp_abc123' },
      };
      const result = convertResponsesEventToGemini(event, model, state);
      expect(result).toBeNull();
      expect(state.responseId).toBe('resp_abc123');
    });

    it('should return null for response.in_progress', () => {
      const event: ResponsesSSEEvent = {
        event: 'response.in_progress',
        data: {},
      };
      expect(convertResponsesEventToGemini(event, model, state)).toBeNull();
    });

    it('should yield text delta as Gemini text part', () => {
      state.responseId = 'resp_1';
      const event: ResponsesSSEEvent = {
        event: 'response.output_text.delta',
        data: { delta: 'Hello world' },
      };
      const result = convertResponsesEventToGemini(event, model, state);
      expect(result).not.toBeNull();
      expect(result!.candidates?.[0]?.content?.parts).toEqual([
        { text: 'Hello world' },
      ]);
      expect(result!.responseId).toBe('resp_1');
    });

    it('should yield reasoning delta as thought part', () => {
      const event: ResponsesSSEEvent = {
        event: 'response.reasoning_summary_text.delta',
        data: { delta: 'Let me think...' },
      };
      const result = convertResponsesEventToGemini(event, model, state);
      expect(result!.candidates?.[0]?.content?.parts).toEqual([
        { text: 'Let me think...', thought: true },
      ]);
    });

    it('should buffer function call arguments and emit on output_item.done', () => {
      const addedEvent: ResponsesSSEEvent = {
        event: 'response.output_item.added',
        data: {
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_abc',
            name: 'read_file',
            arguments: '',
          },
        },
      };
      expect(
        convertResponsesEventToGemini(addedEvent, model, state),
      ).toBeNull();

      const delta1: ResponsesSSEEvent = {
        event: 'response.function_call_arguments.delta',
        data: { output_index: 0, delta: '{"path":' },
      };
      expect(convertResponsesEventToGemini(delta1, model, state)).toBeNull();

      const delta2: ResponsesSSEEvent = {
        event: 'response.function_call_arguments.delta',
        data: { output_index: 0, delta: '"test.ts"}' },
      };
      expect(convertResponsesEventToGemini(delta2, model, state)).toBeNull();

      const doneEvent: ResponsesSSEEvent = {
        event: 'response.output_item.done',
        data: {
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_abc',
            name: 'read_file',
            arguments: '{"path":"test.ts"}',
          },
        },
      };
      const result = convertResponsesEventToGemini(doneEvent, model, state);
      expect(result).not.toBeNull();
      const parts = result!.candidates?.[0]?.content?.parts ?? [];
      expect(parts).toHaveLength(1);
      const fc = (parts[0] as { functionCall?: unknown }).functionCall as {
        id: string;
        name: string;
        args: Record<string, unknown>;
      };
      expect(fc.id).toBe('call_abc');
      expect(fc.name).toBe('read_file');
      expect(fc.args).toEqual({ path: 'test.ts' });
    });

    it('should handle response.completed with usage', () => {
      state.responseId = 'resp_final';
      const event: ResponsesSSEEvent = {
        event: 'response.completed',
        data: {
          id: 'resp_final',
          status: 'completed',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
            output_tokens_details: { reasoning_tokens: 10 },
            input_tokens_details: { cached_tokens: 20 },
          },
        },
      };
      const result = convertResponsesEventToGemini(event, model, state);
      expect(result).not.toBeNull();
      expect(result!.usageMetadata?.promptTokenCount).toBe(100);
      expect(result!.usageMetadata?.candidatesTokenCount).toBe(50);
      expect(result!.usageMetadata?.totalTokenCount).toBe(150);
      expect(result!.usageMetadata?.thoughtsTokenCount).toBe(10);
      expect(result!.usageMetadata?.cachedContentTokenCount).toBe(20);
      expect(result!.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
    });

    it('should throw on response.failed', () => {
      const event: ResponsesSSEEvent = {
        event: 'response.failed',
        data: { error: { code: 'rate_limit', message: 'Too many requests' } },
      };
      expect(() =>
        convertResponsesEventToGemini(event, model, state),
      ).toThrow('rate_limit');
    });

    it('should return null for unknown events', () => {
      const event: ResponsesSSEEvent = {
        event: 'response.content_part.added' as ResponsesSSEEvent['event'],
        data: {},
      };
      expect(convertResponsesEventToGemini(event, model, state)).toBeNull();
    });

    it('should produce MAX_TOKENS finish reason for response.incomplete', () => {
      state.responseId = 'resp_inc';
      const event: ResponsesSSEEvent = {
        event: 'response.incomplete',
        data: {},
      };
      const result = convertResponsesEventToGemini(event, model, state);
      expect(result).not.toBeNull();
      expect(result!.candidates?.[0]?.finishReason).toBe(
        FinishReason.MAX_TOKENS,
      );
    });

    it('should throw on error SSE event', () => {
      const event: ResponsesSSEEvent = {
        event: 'error',
        data: { message: 'server_error: internal failure' },
      };
      expect(() =>
        convertResponsesEventToGemini(event, model, state),
      ).toThrow('server_error: internal failure');
    });

    it('should return null for output_item.done with non-function-call item', () => {
      const event: ResponsesSSEEvent = {
        event: 'response.output_item.done',
        data: {
          output_index: 0,
          item: {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'hello' }],
          },
        },
      };
      expect(convertResponsesEventToGemini(event, model, state)).toBeNull();
    });

    it('should not crash on output_item.added for a reasoning item', () => {
      const event: ResponsesSSEEvent = {
        event: 'response.output_item.added',
        data: {
          output_index: 0,
          item: {
            type: 'reasoning',
            id: 'rs_1',
            summary: [],
          },
        },
      };
      const result = convertResponsesEventToGemini(event, model, state);
      expect(result).toBeNull();
    });

    it('should handle multiple parallel function calls at different output indices', () => {
      const added0: ResponsesSSEEvent = {
        event: 'response.output_item.added',
        data: {
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_0',
            call_id: 'call_0',
            name: 'read_file',
            arguments: '',
          },
        },
      };
      const added1: ResponsesSSEEvent = {
        event: 'response.output_item.added',
        data: {
          output_index: 1,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'write_file',
            arguments: '',
          },
        },
      };
      convertResponsesEventToGemini(added0, model, state);
      convertResponsesEventToGemini(added1, model, state);

      convertResponsesEventToGemini(
        {
          event: 'response.function_call_arguments.delta',
          data: { output_index: 0, delta: '{"path":"a.ts"}' },
        },
        model,
        state,
      );
      convertResponsesEventToGemini(
        {
          event: 'response.function_call_arguments.delta',
          data: { output_index: 1, delta: '{"path":"b.ts","content":"x"}' },
        },
        model,
        state,
      );

      const done0 = convertResponsesEventToGemini(
        {
          event: 'response.output_item.done',
          data: {
            output_index: 0,
            item: {
              type: 'function_call',
              id: 'fc_0',
              call_id: 'call_0',
              name: 'read_file',
              arguments: '{"path":"a.ts"}',
            },
          },
        },
        model,
        state,
      );
      const done1 = convertResponsesEventToGemini(
        {
          event: 'response.output_item.done',
          data: {
            output_index: 1,
            item: {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_1',
              name: 'write_file',
              arguments: '{"path":"b.ts","content":"x"}',
            },
          },
        },
        model,
        state,
      );

      expect(done0).not.toBeNull();
      expect(done1).not.toBeNull();
      const fc0 = (done0!.candidates?.[0]?.content?.parts?.[0] as {
        functionCall: { id: string; name: string; args: Record<string, unknown> };
      }).functionCall;
      const fc1 = (done1!.candidates?.[0]?.content?.parts?.[0] as {
        functionCall: { id: string; name: string; args: Record<string, unknown> };
      }).functionCall;
      expect(fc0.name).toBe('read_file');
      expect(fc0.id).toBe('call_0');
      expect(fc1.name).toBe('write_file');
      expect(fc1.id).toBe('call_1');
      expect(fc1.args).toEqual({ path: 'b.ts', content: 'x' });
    });

    it('should map finish reasons correctly via makeFinalResponse', () => {
      state.responseId = 'resp_len';
      const incomplete: ResponsesSSEEvent = {
        event: 'response.incomplete',
        data: {},
      };
      const incResult = convertResponsesEventToGemini(
        incomplete,
        model,
        state,
      );
      expect(incResult!.candidates?.[0]?.finishReason).toBe(
        FinishReason.MAX_TOKENS,
      );

      const completed: ResponsesSSEEvent = {
        event: 'response.completed',
        data: { id: 'resp_done', status: 'completed' },
      };
      const compResult = convertResponsesEventToGemini(
        completed,
        model,
        state,
      );
      expect(compResult!.candidates?.[0]?.finishReason).toBe(
        FinishReason.STOP,
      );
    });

    it('should omit usageMetadata when response.completed has no usage', () => {
      state.responseId = 'resp_no_usage';
      const event: ResponsesSSEEvent = {
        event: 'response.completed',
        data: { id: 'resp_no_usage', status: 'completed' },
      };
      const result = convertResponsesEventToGemini(event, model, state);
      expect(result).not.toBeNull();
      expect(result!.usageMetadata).toBeUndefined();
      expect(result!.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
    });

    it('should throw on response.failed without error object', () => {
      const event: ResponsesSSEEvent = {
        event: 'response.failed',
        data: {},
      };
      expect(() =>
        convertResponsesEventToGemini(event, model, state),
      ).toThrow('Response failed');
    });

    it('should store encrypted_content on output_item.done for reasoning type', () => {
      const event: ResponsesSSEEvent = {
        event: 'response.output_item.done',
        data: {
          output_index: 0,
          item: {
            type: 'reasoning',
            id: 'rs_enc',
            summary: [],
            encrypted_content: 'enc_abc123',
          },
        },
      };
      const result = convertResponsesEventToGemini(event, model, state);
      expect(result).toBeNull();
      expect(state.encryptedContentItems).toHaveLength(1);
      expect(state.encryptedContentItems[0]).toEqual({
        type: 'reasoning',
        id: 'rs_enc',
        encrypted_content: 'enc_abc123',
      });
    });
  });

  describe('convertGeminiContentsToResponsesInput', () => {
    it('should extract system instruction', () => {
      const request = {
        contents: [],
        config: {
          systemInstruction: 'You are a helpful assistant',
        },
      } as unknown as GenerateContentParameters;
      const { instructions, input } =
        convertGeminiContentsToResponsesInput(request);
      expect(instructions).toBe('You are a helpful assistant');
      expect(input).toEqual([]);
    });

    it('should convert user text content', () => {
      const request = {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Hello' }],
          },
        ],
      } as unknown as GenerateContentParameters;
      const { input } = convertGeminiContentsToResponsesInput(request);
      expect(input).toHaveLength(1);
      expect(input[0]).toEqual({
        type: 'message',
        role: 'user',
        content: 'Hello',
      });
    });

    it('should convert function call and response', () => {
      const request = {
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
                  name: 'read_file',
                  args: { path: 'test.ts' },
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
                  response: 'file contents here',
                },
              },
            ],
          },
        ],
      } as unknown as GenerateContentParameters;
      const { input } = convertGeminiContentsToResponsesInput(request);
      expect(input).toHaveLength(2);
      expect(input[0]!.type).toBe('function_call');
      expect(input[1]!.type).toBe('function_call_output');
    });

    it('should skip thought parts', () => {
      const request = {
        contents: [
          {
            role: 'model',
            parts: [
              { text: 'thinking...', thought: true },
              { text: 'actual response' },
            ],
          },
        ],
      } as unknown as GenerateContentParameters;
      const { input } = convertGeminiContentsToResponsesInput(request);
      expect(input).toHaveLength(1);
      expect(input[0]).toEqual({
        type: 'message',
        role: 'assistant',
        content: 'actual response',
      });
    });

    it('should extract system instruction from object format with parts array', () => {
      const request = {
        contents: [],
        config: {
          systemInstruction: {
            parts: [{ text: 'Be concise.' }, { text: 'Be accurate.' }],
          },
        },
      } as unknown as GenerateContentParameters;
      const { instructions } =
        convertGeminiContentsToResponsesInput(request);
      expect(instructions).toBe('Be concise.\nBe accurate.');
    });

    it('should convert string-type contents to user message', () => {
      const request = {
        contents: 'What is 2+2?',
      } as unknown as GenerateContentParameters;
      const { input } = convertGeminiContentsToResponsesInput(request);
      expect(input).toHaveLength(1);
      expect(input[0]).toEqual({
        type: 'message',
        role: 'user',
        content: 'What is 2+2?',
      });
    });

    it('should convert inlineData images to input_image parts', () => {
      const request = {
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: 'iVBORw0KGgo=',
                },
              },
            ],
          },
        ],
      } as unknown as GenerateContentParameters;
      const { input } = convertGeminiContentsToResponsesInput(request);
      expect(input).toHaveLength(1);
      const msg = input[0] as { type: string; role: string; content: unknown[] };
      expect(msg.type).toBe('message');
      expect(msg.role).toBe('user');
      expect(msg.content).toEqual([
        {
          type: 'input_image',
          image_url: 'data:image/png;base64,iVBORw0KGgo=',
        },
      ]);
    });
  });

  describe('convertGeminiToolsToResponsesTools', () => {
    it('should convert Gemini tools to Responses format', () => {
      const request = {
        contents: [],
        config: {
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'read_file',
                  description: 'Read a file',
                  parameters: {
                    type: 'object',
                    properties: {
                      path: { type: 'string' },
                    },
                  },
                },
              ],
            },
          ],
        },
      } as unknown as GenerateContentParameters;
      const tools = convertGeminiToolsToResponsesTools(request);
      expect(tools).toHaveLength(1);
      expect(tools![0]).toEqual({
        type: 'function',
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      });
    });

    it('should return undefined when no tools', () => {
      const request = {
        contents: [],
      } as unknown as GenerateContentParameters;
      expect(convertGeminiToolsToResponsesTools(request)).toBeUndefined();
    });
  });
});
