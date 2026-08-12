/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { GenerateContentParameters } from '@google/genai';
import {
  ResponsesStreamState,
  convertResponsesEventToGemini,
  convertGeminiContentsToResponsesInput,
  convertGeminiToolsToResponsesTools,
  cleanOrphanedFunctionCalls,
  normalizeResponsesParameters,
} from './responses-converter.js';
import type {
  ResponsesApiFunctionCallItem,
  ResponsesApiFunctionCallOutputItem,
  ResponsesApiMessageItem,
  ResponsesApiReasoningItem,
  ResponsesSSEEvent,
} from './types.js';
import { getGenAiUsageProvenance } from '../../telemetry/gen-ai-usage.js';

describe('convertResponsesEventToGemini', () => {
  it('emits a plain text chunk for response.output_text.delta', () => {
    const state = new ResponsesStreamState();
    const event: ResponsesSSEEvent = {
      event: 'response.output_text.delta',
      data: { delta: 'hello' },
    };
    const resp = convertResponsesEventToGemini(event, 'gpt-5', state);
    expect(resp?.candidates?.[0]?.content?.parts).toEqual([{ text: 'hello' }]);
  });

  it('emits a thought:true chunk for reasoning_summary_text.delta', () => {
    const state = new ResponsesStreamState();
    const event: ResponsesSSEEvent = {
      event: 'response.reasoning_summary_text.delta',
      data: { delta: 'thinking...' },
    };
    const resp = convertResponsesEventToGemini(event, 'gpt-5', state);
    expect(resp?.candidates?.[0]?.content?.parts).toEqual([
      { text: 'thinking...', thought: true },
    ]);
  });

  it('buffers function_call args across deltas and emits on output_item.done', () => {
    const state = new ResponsesStreamState();
    // The buffering events (output_item.added and each arguments.delta) must
    // return null: emitting a functionCall part early would land a spurious
    // (empty/partial) tool call in history that replays as a duplicate call.
    const added = convertResponsesEventToGemini(
      {
        event: 'response.output_item.added',
        data: {
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read_file',
          },
        },
      },
      'gpt-5',
      state,
    );
    expect(added).toBeNull();
    const delta1 = convertResponsesEventToGemini(
      {
        event: 'response.function_call_arguments.delta',
        data: { output_index: 0, delta: '{"path":' },
      },
      'gpt-5',
      state,
    );
    expect(delta1).toBeNull();
    const delta2 = convertResponsesEventToGemini(
      {
        event: 'response.function_call_arguments.delta',
        data: { output_index: 0, delta: '"a.ts"}' },
      },
      'gpt-5',
      state,
    );
    expect(delta2).toBeNull();
    const resp = convertResponsesEventToGemini(
      {
        event: 'response.output_item.done',
        data: {
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read_file',
          },
        },
      },
      'gpt-5',
      state,
    );
    expect(resp?.candidates?.[0]?.content?.parts).toEqual([
      {
        functionCall: {
          id: 'call_1',
          name: 'read_file',
          args: { path: 'a.ts' },
        },
      },
    ]);
  });

  it('falls back to empty args when function_call arguments are invalid JSON', () => {
    const state = new ResponsesStreamState();
    convertResponsesEventToGemini(
      {
        event: 'response.output_item.added',
        data: {
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'x',
          },
        },
      },
      'gpt-5',
      state,
    );
    convertResponsesEventToGemini(
      {
        event: 'response.function_call_arguments.delta',
        data: { output_index: 0, delta: 'not json' },
      },
      'gpt-5',
      state,
    );
    const resp = convertResponsesEventToGemini(
      {
        event: 'response.output_item.done',
        data: {
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'x',
          },
        },
      },
      'gpt-5',
      state,
    );
    expect(
      (
        resp?.candidates?.[0]?.content?.parts?.[0] as {
          functionCall?: { args?: unknown };
        }
      ).functionCall?.args,
    ).toEqual({});
  });

  it("falls back to the done item's own call_id/name/arguments when output_item.added was missed", () => {
    const state = new ResponsesStreamState();
    // No preceding output_item.added / function_call_arguments.delta — the
    // local buffer is empty, so this must not silently drop the tool call.
    const resp = convertResponsesEventToGemini(
      {
        event: 'response.output_item.done',
        data: {
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read_file',
            arguments: '{"path":"a.ts"}',
          },
        },
      },
      'gpt-5',
      state,
    );
    expect(resp?.candidates?.[0]?.content?.parts).toEqual([
      {
        functionCall: {
          id: 'call_1',
          name: 'read_file',
          args: { path: 'a.ts' },
        },
      },
    ]);
  });

  it("falls back to the done item's arguments when output_item.added created the buffer but no delta events ever arrived", () => {
    // initFunctionCall seeds buf.args to ''. A `??` fallback here would
    // never trigger for an empty string, so a proxy that sends
    // output_item.added followed directly by output_item.done (no
    // function_call_arguments.delta in between) must still fall through to
    // the done item's own complete `arguments` rather than losing every
    // argument to `JSON.parse('')` throwing.
    const state = new ResponsesStreamState();
    state.initFunctionCall(0, 'fc_1', 'call_1', 'read_file');
    const resp = convertResponsesEventToGemini(
      {
        event: 'response.output_item.done',
        data: {
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read_file',
            arguments: '{"path":"a.ts"}',
          },
        },
      },
      'gpt-5',
      state,
    );
    expect(resp?.candidates?.[0]?.content?.parts).toEqual([
      {
        functionCall: {
          id: 'call_1',
          name: 'read_file',
          args: { path: 'a.ts' },
        },
      },
    ]);
  });

  it("prefers the done item's authoritative arguments when the delta buffer is corrupt", () => {
    // A non-compliant proxy delivers output_item.added, a corrupt/partial
    // arguments delta (non-empty, so `||` keeps it), then output_item.done
    // with the complete valid arguments. Without the fallback the corrupt
    // buffer short-circuits and the tool dispatches with empty args.
    const state = new ResponsesStreamState();
    convertResponsesEventToGemini(
      {
        event: 'response.output_item.added',
        data: {
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read_file',
          },
        },
      },
      'gpt-5',
      state,
    );
    convertResponsesEventToGemini(
      {
        event: 'response.function_call_arguments.delta',
        data: { output_index: 0, delta: '{"path":' },
      },
      'gpt-5',
      state,
    );
    const resp = convertResponsesEventToGemini(
      {
        event: 'response.output_item.done',
        data: {
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read_file',
            arguments: '{"path":"a.ts"}',
          },
        },
      },
      'gpt-5',
      state,
    );
    expect(resp?.candidates?.[0]?.content?.parts).toEqual([
      {
        functionCall: {
          id: 'call_1',
          name: 'read_file',
          args: { path: 'a.ts' },
        },
      },
    ]);
  });

  it('repairs malformed-but-repairable tool-call arguments via the jsonrepair fallback (trailing comma)', () => {
    // The authoritative arguments string itself is malformed but repairable
    // (trailing comma). Bare JSON.parse throws; safeJsonParse/jsonrepair
    // recovers it the same way every sibling wire does.
    const state = new ResponsesStreamState();
    convertResponsesEventToGemini(
      {
        event: 'response.output_item.added',
        data: {
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read_file',
          },
        },
      },
      'gpt-5',
      state,
    );
    convertResponsesEventToGemini(
      {
        event: 'response.function_call_arguments.delta',
        data: { output_index: 0, delta: '{"path": "a.ts",}' },
      },
      'gpt-5',
      state,
    );
    const resp = convertResponsesEventToGemini(
      {
        event: 'response.output_item.done',
        data: {
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read_file',
          },
        },
      },
      'gpt-5',
      state,
    );
    expect(resp?.candidates?.[0]?.content?.parts).toEqual([
      {
        functionCall: {
          id: 'call_1',
          name: 'read_file',
          args: { path: 'a.ts' },
        },
      },
    ]);
  });

  it('collapses non-object parsed tool-call arguments to {} (array payload)', () => {
    // A polluted buffer can parse to a valid non-object JSON value (array /
    // null / primitive). Downstream consumers spread args as a Record, so
    // anything non-object must collapse to {}.
    const state = new ResponsesStreamState();
    convertResponsesEventToGemini(
      {
        event: 'response.output_item.added',
        data: {
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'x',
          },
        },
      },
      'gpt-5',
      state,
    );
    convertResponsesEventToGemini(
      {
        event: 'response.function_call_arguments.delta',
        data: { output_index: 0, delta: '["a","b"]' },
      },
      'gpt-5',
      state,
    );
    const resp = convertResponsesEventToGemini(
      {
        event: 'response.output_item.done',
        data: {
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'x',
          },
        },
      },
      'gpt-5',
      state,
    );
    expect(
      (
        resp?.candidates?.[0]?.content?.parts?.[0] as {
          functionCall?: { args?: unknown };
        }
      ).functionCall?.args,
    ).toEqual({});
  });

  describe('reasoning item completion (thoughtSignature round-trip)', () => {
    it('emits a signature-only thought chunk when encrypted_content is present', () => {
      const state = new ResponsesStreamState();
      const resp = convertResponsesEventToGemini(
        {
          event: 'response.output_item.done',
          data: {
            output_index: 0,
            item: {
              type: 'reasoning',
              id: 'rs_123',
              summary: [{ type: 'summary_text', text: 'because X' }],
              encrypted_content: 'enc_blob_abc',
            },
          },
        },
        'gpt-5',
        state,
      );
      const part = resp?.candidates?.[0]?.content?.parts?.[0] as {
        thought?: boolean;
        thoughtSignature?: string;
        text?: string;
      };
      expect(part.thought).toBe(true);
      expect(part.text).toBeUndefined();
      const decoded = JSON.parse(part.thoughtSignature!);
      expect(decoded).toEqual({
        id: 'rs_123',
        encrypted_content: 'enc_blob_abc',
      });
    });

    it('drops the signature (returns null) when encrypted_content is absent', () => {
      const state = new ResponsesStreamState();
      const resp = convertResponsesEventToGemini(
        {
          event: 'response.output_item.done',
          data: {
            output_index: 0,
            item: {
              type: 'reasoning',
              id: 'rs_123',
              summary: [{ type: 'summary_text', text: 'because X' }],
            },
          },
        },
        'gpt-5',
        state,
      );
      expect(resp).toBeNull();
    });
  });

  it('maps response.completed usage into usageMetadata', () => {
    const state = new ResponsesStreamState();
    const resp = convertResponsesEventToGemini(
      {
        event: 'response.completed',
        data: {
          response: {
            id: 'resp_1',
            status: 'completed',
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
              output_tokens_details: { reasoning_tokens: 2 },
              input_tokens_details: { cached_tokens: 1 },
            },
          },
        },
      },
      'gpt-5',
      state,
    );
    expect(resp?.usageMetadata).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
      thoughtsTokenCount: 2,
      cachedContentTokenCount: 1,
    });
    // A successful completed turn must map to STOP; a wrong reason here would
    // trigger MAX_TOKENS truncation recovery downstream on every turn.
    expect(resp?.candidates?.[0]?.finishReason).toBe('STOP');
  });

  it('records cache provenance as reported when cached_tokens is present', () => {
    const state = new ResponsesStreamState();
    const resp = convertResponsesEventToGemini(
      {
        event: 'response.completed',
        data: {
          response: {
            id: 'resp_1',
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
              input_tokens_details: { cached_tokens: 3 },
            },
          },
        },
      },
      'gpt-5',
      state,
    );
    expect(
      getGenAiUsageProvenance(resp?.usageMetadata ?? undefined)
        ?.cachedInputTokensReported,
    ).toBe(true);
  });

  it('records cache provenance as NOT reported when cached_tokens is absent (absent vs zero)', () => {
    // cachedContentTokenCount is always materialized to 0, so provenance is the
    // only signal that distinguishes "provider reported 0" from "not reported".
    const state = new ResponsesStreamState();
    const resp = convertResponsesEventToGemini(
      {
        event: 'response.completed',
        data: {
          response: {
            id: 'resp_1',
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
      },
      'gpt-5',
      state,
    );
    expect(resp?.usageMetadata?.cachedContentTokenCount).toBe(0);
    expect(
      getGenAiUsageProvenance(resp?.usageMetadata ?? undefined)
        ?.cachedInputTokensReported,
    ).toBe(false);
  });

  it('throws on response.failed', () => {
    const state = new ResponsesStreamState();
    expect(() =>
      convertResponsesEventToGemini(
        {
          event: 'response.failed',
          data: { response: { error: { code: 'bad', message: 'nope' } } },
        },
        'gpt-5',
        state,
      ),
    ).toThrow(/Responses API failed: bad: nope/);
  });

  it('throws on a top-level error event', () => {
    const state = new ResponsesStreamState();
    expect(() =>
      convertResponsesEventToGemini(
        { event: 'error', data: { message: 'boom' } },
        'gpt-5',
        state,
      ),
    ).toThrow(/Responses API error: boom/);
  });

  it('stamps .status/.code on a response.failed with a known error code so retry/fallback gates classify it', () => {
    // A mid-stream failure arrives after 200 OK; without .status it classifies
    // as `unknown` and misses every retry / rate-limit / fallback gate.
    const state = new ResponsesStreamState();
    let thrown: unknown;
    try {
      convertResponsesEventToGemini(
        {
          event: 'response.failed',
          data: {
            response: {
              error: { code: 'rate_limit_exceeded', message: 'slow down' },
            },
          },
        },
        'gpt-5',
        state,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { status?: number }).status).toBe(429);
    expect((thrown as { code?: string }).code).toBe('rate_limit_exceeded');
    expect((thrown as Error).message).toContain('rate_limit_exceeded');
  });

  it('maps a mid-stream error event server_error code to HTTP 500 status', () => {
    const state = new ResponsesStreamState();
    let thrown: unknown;
    try {
      convertResponsesEventToGemini(
        { event: 'error', data: { message: 'boom', code: 'server_error' } },
        'gpt-5',
        state,
      );
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { status?: number }).status).toBe(500);
    expect((thrown as { code?: string }).code).toBe('server_error');
  });

  describe('response.incomplete', () => {
    it('extracts usage and maps incomplete_details.reason to MAX_TOKENS', () => {
      const state = new ResponsesStreamState();
      const resp = convertResponsesEventToGemini(
        {
          event: 'response.incomplete',
          data: {
            response: {
              id: 'resp_1',
              status: 'incomplete',
              incomplete_details: { reason: 'max_output_tokens' },
              usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
            },
          },
        },
        'gpt-5',
        state,
      );
      expect(resp?.candidates?.[0]?.finishReason).toBe('MAX_TOKENS');
      expect(resp?.usageMetadata?.totalTokenCount).toBe(6);
    });

    it('maps a content_filter reason to SAFETY, not MAX_TOKENS', () => {
      const state = new ResponsesStreamState();
      const resp = convertResponsesEventToGemini(
        {
          event: 'response.incomplete',
          data: {
            response: {
              id: 'resp_1',
              status: 'incomplete',
              incomplete_details: { reason: 'content_filter' },
            },
          },
        },
        'gpt-5',
        state,
      );
      expect(resp?.candidates?.[0]?.finishReason).toBe('SAFETY');
    });

    it('defaults to MAX_TOKENS when incomplete_details is absent', () => {
      const state = new ResponsesStreamState();
      const resp = convertResponsesEventToGemini(
        { event: 'response.incomplete', data: {} },
        'gpt-5',
        state,
      );
      expect(resp?.candidates?.[0]?.finishReason).toBe('MAX_TOKENS');
    });
  });
});

describe('convertGeminiContentsToResponsesInput', () => {
  function request(
    contents: GenerateContentParameters['contents'],
  ): GenerateContentParameters {
    return { model: 'gpt-5', contents };
  }

  it('converts plain user/model text turns to message items', () => {
    const { input } = convertGeminiContentsToResponsesInput(
      request([
        { role: 'user', parts: [{ text: 'hi' }] },
        { role: 'model', parts: [{ text: 'hello' }] },
      ]),
    );
    expect(input).toEqual([
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'message', role: 'assistant', content: 'hello' },
    ]);
  });

  it('reconstructs a real reasoning item when thoughtSignature decodes cleanly', () => {
    const { input } = convertGeminiContentsToResponsesInput(
      request([
        {
          role: 'model',
          parts: [
            {
              text: 'because X',
              thought: true,
              thoughtSignature: JSON.stringify({
                id: 'rs_123',
                encrypted_content: 'enc_abc',
              }),
            },
          ],
        },
      ]),
    );
    expect(input).toEqual([
      {
        type: 'reasoning',
        id: 'rs_123',
        encrypted_content: 'enc_abc',
        summary: [{ type: 'summary_text', text: 'because X' }],
      } satisfies ResponsesApiReasoningItem,
    ]);
  });

  it('falls back to a plain assistant message when thoughtSignature is missing (does not guess a reasoning item)', () => {
    const { input } = convertGeminiContentsToResponsesInput(
      request([
        {
          role: 'model',
          parts: [{ text: 'because X', thought: true }],
        },
      ]),
    );
    expect(input).toEqual([
      { type: 'message', role: 'assistant', content: 'because X' },
    ]);
  });

  it('falls back to a plain assistant message when thoughtSignature is not our JSON shape', () => {
    const { input } = convertGeminiContentsToResponsesInput(
      request([
        {
          role: 'model',
          parts: [
            {
              text: 'because X',
              thought: true,
              thoughtSignature: 'not-json-and-not-ours',
            },
          ],
        },
      ]),
    );
    expect(input).toEqual([
      { type: 'message', role: 'assistant', content: 'because X' },
    ]);
  });

  it('drops the thought part entirely when both thoughtSignature and text are missing', () => {
    const { input } = convertGeminiContentsToResponsesInput(
      request([
        {
          role: 'model',
          parts: [{ thought: true } as never],
        },
      ]),
    );
    expect(input).toEqual([]);
  });

  it('emits a distinct thoughtSignature chunk per reasoning item within one turn', () => {
    const state = new ResponsesStreamState();
    const first = convertResponsesEventToGemini(
      {
        event: 'response.output_item.done',
        data: {
          output_index: 0,
          item: {
            type: 'reasoning',
            id: 'rs_1',
            summary: [{ type: 'summary_text', text: 'first' }],
            encrypted_content: 'enc_1',
          },
        },
      },
      'gpt-5',
      state,
    );
    const second = convertResponsesEventToGemini(
      {
        event: 'response.output_item.done',
        data: {
          output_index: 1,
          item: {
            type: 'reasoning',
            id: 'rs_2',
            summary: [{ type: 'summary_text', text: 'second' }],
            encrypted_content: 'enc_2',
          },
        },
      },
      'gpt-5',
      state,
    );
    const firstSig = (
      first?.candidates?.[0]?.content?.parts?.[0] as {
        thoughtSignature?: string;
      }
    ).thoughtSignature;
    const secondSig = (
      second?.candidates?.[0]?.content?.parts?.[0] as {
        thoughtSignature?: string;
      }
    ).thoughtSignature;
    expect(JSON.parse(firstSig!)).toEqual({
      id: 'rs_1',
      encrypted_content: 'enc_1',
    });
    expect(JSON.parse(secondSig!)).toEqual({
      id: 'rs_2',
      encrypted_content: 'enc_2',
    });
  });

  it('converts functionCall and functionResponse parts', () => {
    const { input } = convertGeminiContentsToResponsesInput(
      request([
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_1',
                name: 'read_file',
                args: { path: 'a.ts' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { id: 'call_1', response: { content: 'ok' } } },
          ],
        },
      ]),
    );
    expect(input).toEqual([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'a.ts' }),
      } satisfies ResponsesApiFunctionCallItem,
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: JSON.stringify({ content: 'ok' }),
      } satisfies ResponsesApiFunctionCallOutputItem,
    ]);
  });

  it('converts inline image data on user turns to input_image content parts', () => {
    const { input } = convertGeminiContentsToResponsesInput(
      request([
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: 'image/png', data: 'YWJj' } }],
        },
      ]),
    );
    expect(input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,YWJj' },
        ],
      } satisfies ResponsesApiMessageItem,
    ]);
  });

  it('merges a text part and an image part in the same turn into one message with a multi-part content array', () => {
    // Regression guard: pushing one 'message' item per part would make the
    // Responses API treat the question and the image as two separate turns.
    const { input } = convertGeminiContentsToResponsesInput(
      request([
        {
          role: 'user',
          parts: [
            { text: 'What is in this image?' },
            { inlineData: { mimeType: 'image/png', data: 'YWJj' } },
          ],
        },
      ]),
    );
    expect(input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'What is in this image?' },
          { type: 'input_image', image_url: 'data:image/png;base64,YWJj' },
        ],
      } satisfies ResponsesApiMessageItem,
    ]);
  });

  it('flushes accumulated text as its own message before a function_call so relative order is preserved', () => {
    const { input } = convertGeminiContentsToResponsesInput(
      request([
        {
          role: 'model',
          parts: [
            { text: "I'll check that file." },
            {
              functionCall: {
                id: 'call_1',
                name: 'read_file',
                args: { path: 'a.ts' },
              },
            },
          ],
        },
      ]),
    );
    expect(input).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: "I'll check that file.",
      } satisfies ResponsesApiMessageItem,
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'a.ts' }),
      } satisfies ResponsesApiFunctionCallItem,
    ]);
  });

  it('replaces non-image inlineData with a text placeholder instead of silently dropping it', () => {
    const { input } = convertGeminiContentsToResponsesInput(
      request([
        {
          role: 'user',
          parts: [
            { text: 'Summarize my PDF' },
            { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0' } },
          ],
        },
      ]),
    );
    expect(input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Summarize my PDF' },
          {
            type: 'input_text',
            text: '[Unsupported inline media type: application/pdf]',
          },
        ],
      } satisfies ResponsesApiMessageItem,
    ]);
  });

  it('replaces a fileData reference with a text placeholder instead of silently dropping it', () => {
    const { input } = convertGeminiContentsToResponsesInput(
      request([
        {
          role: 'user',
          parts: [
            {
              fileData: {
                mimeType: 'application/pdf',
                fileUri: 'gs://bucket/doc.pdf',
              },
            },
          ],
        },
      ]),
    );
    expect(input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: '[Unsupported file reference: application/pdf]',
      } satisfies ResponsesApiMessageItem,
    ]);
  });

  it('unwraps a { output } tool response envelope to the bare string instead of double-encoding it', () => {
    const { input } = convertGeminiContentsToResponsesInput(
      request([
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_1',
                response: { output: '{"key":"value"}' },
              },
            },
          ],
        },
      ]),
    );
    expect(input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: '{"key":"value"}',
      } satisfies ResponsesApiFunctionCallOutputItem,
    ]);
  });

  it('surfaces tool-result image media as a follow-up user input_image message instead of dropping it', () => {
    // A tool that returns an image stores it in functionResponse.parts; the
    // string-only function_call_output.output can't carry it, so it must be
    // emitted as a follow-up user message rather than silently dropped.
    const { input } = convertGeminiContentsToResponsesInput(
      request([
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_1',
                response: { output: 'see image' },
                parts: [
                  { inlineData: { mimeType: 'image/png', data: 'YWJj' } },
                ],
              },
            },
          ],
        },
      ]),
    );
    expect(input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'see image',
      } satisfies ResponsesApiFunctionCallOutputItem,
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '(attached media from previous tool call)',
          },
          { type: 'input_image', image_url: 'data:image/png;base64,YWJj' },
        ],
      } satisfies ResponsesApiMessageItem,
    ]);
  });

  it('unwraps a { error } tool response envelope to the bare string', () => {
    const { input } = convertGeminiContentsToResponsesInput(
      request([
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_1',
                response: { error: 'file not found' },
              },
            },
          ],
        },
      ]),
    );
    expect(input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'file not found',
      } satisfies ResponsesApiFunctionCallOutputItem,
    ]);
  });

  it('extracts systemInstruction into instructions', () => {
    const { instructions } = convertGeminiContentsToResponsesInput({
      model: 'gpt-5',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      config: { systemInstruction: { parts: [{ text: 'be helpful' }] } },
    });
    expect(instructions).toBe('be helpful');
  });
});

describe('cleanOrphanedFunctionCalls', () => {
  it('drops function_call items with no matching function_call_output', () => {
    const items = cleanOrphanedFunctionCalls([
      { type: 'function_call', call_id: 'a', name: 'f', arguments: '{}' },
      { type: 'function_call', call_id: 'b', name: 'g', arguments: '{}' },
      { type: 'function_call_output', call_id: 'b', output: 'ok' },
    ]);
    expect(items).toEqual([
      { type: 'function_call', call_id: 'b', name: 'g', arguments: '{}' },
      { type: 'function_call_output', call_id: 'b', output: 'ok' },
    ]);
  });

  it('drops function_call_output items with no matching function_call', () => {
    const items = cleanOrphanedFunctionCalls([
      { type: 'function_call_output', call_id: 'a', output: 'orphaned' },
      { type: 'function_call', call_id: 'b', name: 'g', arguments: '{}' },
      { type: 'function_call_output', call_id: 'b', output: 'ok' },
    ]);
    expect(items).toEqual([
      { type: 'function_call', call_id: 'b', name: 'g', arguments: '{}' },
      { type: 'function_call_output', call_id: 'b', output: 'ok' },
    ]);
  });

  it('leaves non function_call items untouched', () => {
    const items = cleanOrphanedFunctionCalls([
      { type: 'message', role: 'user', content: 'hi' },
    ]);
    expect(items).toEqual([{ type: 'message', role: 'user', content: 'hi' }]);
  });
});

describe('convertGeminiToolsToResponsesTools', () => {
  it('converts functionDeclarations to Responses API function tools', () => {
    const tools = convertGeminiToolsToResponsesTools({
      model: 'gpt-5',
      contents: [],
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'read_file',
                description: 'reads a file',
                parametersJsonSchema: {
                  type: 'object',
                  properties: { path: {} },
                },
              },
            ],
          },
        ],
      },
    });
    expect(tools).toEqual([
      {
        type: 'function',
        name: 'read_file',
        description: 'reads a file',
        parameters: { type: 'object', properties: { path: {} } },
      },
    ]);
  });

  it('returns undefined when there are no tools', () => {
    expect(
      convertGeminiToolsToResponsesTools({ model: 'gpt-5', contents: [] }),
    ).toBeUndefined();
  });

  it('converts every declaration across multiple Tool entries (not just the first)', () => {
    const tools = convertGeminiToolsToResponsesTools({
      model: 'gpt-5',
      contents: [],
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'read_file',
                parametersJsonSchema: { type: 'object', properties: {} },
              },
              {
                name: 'write_file',
                parametersJsonSchema: { type: 'object', properties: {} },
              },
            ],
          },
        ],
      },
    });
    expect(tools?.map((t) => t.name)).toEqual(['read_file', 'write_file']);
  });

  it('returns undefined (not tools: []) when declarations are present but empty', () => {
    // Exercises the `result.length > 0 ? result : undefined` ternary: an empty
    // array would otherwise serialize `tools: []` alongside the unconditional
    // tool_choice.
    expect(
      convertGeminiToolsToResponsesTools({
        model: 'gpt-5',
        contents: [],
        config: { tools: [{ functionDeclarations: [] }] },
      }),
    ).toBeUndefined();
  });

  it('normalizes a zero-arg tool schema missing properties (Azure/litellm compatibility)', () => {
    // Every other case here already has `properties`, so
    // normalizeResponsesParameters is a no-op for them -- this is the only
    // case that actually exercises the normalization this function wires
    // in, guarding against a regression that silently drops the call.
    const tools = convertGeminiToolsToResponsesTools({
      model: 'gpt-5',
      contents: [],
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'list_files',
                description: 'lists files with no arguments',
                parametersJsonSchema: { type: 'object' },
              },
            ],
          },
        ],
      },
    });
    expect(tools).toEqual([
      {
        type: 'function',
        name: 'list_files',
        description: 'lists files with no arguments',
        parameters: { type: 'object', properties: {} },
      },
    ]);
  });
});

describe('normalizeResponsesParameters', () => {
  it('adds an empty properties object to a bare object schema', () => {
    expect(normalizeResponsesParameters({ type: 'object' })).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('recurses into nested object schemas under properties/items/anyOf', () => {
    const schema = {
      type: 'object',
      properties: {
        nested: { type: 'object' },
        list: { type: 'array', items: { type: 'object' } },
      },
      anyOf: [{ type: 'object' }],
    };
    expect(normalizeResponsesParameters(schema)).toEqual({
      type: 'object',
      properties: {
        nested: { type: 'object', properties: {} },
        list: { type: 'array', items: { type: 'object', properties: {} } },
      },
      anyOf: [{ type: 'object', properties: {} }],
    });
  });

  it('recurses into bare object schemas nested under oneOf and allOf', () => {
    const schema = {
      type: 'object',
      properties: {},
      oneOf: [{ type: 'object' }],
      allOf: [{ type: 'object' }],
    };
    expect(normalizeResponsesParameters(schema)).toEqual({
      type: 'object',
      properties: {},
      oneOf: [{ type: 'object', properties: {} }],
      allOf: [{ type: 'object', properties: {} }],
    });
  });

  it('passes through a well-formed schema unchanged', () => {
    const schema = { type: 'object', properties: { path: { type: 'string' } } };
    expect(normalizeResponsesParameters(schema)).toEqual(schema);
  });

  it('does not mutate the caller-provided schema object in place', () => {
    // Tool declarations are shared across requests; an in-place mutation would
    // corrupt the caller's object. The normalizer must return a fresh tree.
    const schema = { type: 'object' };
    const snapshot = structuredClone(schema);
    const result = normalizeResponsesParameters(schema);
    expect(schema).toEqual(snapshot);
    expect(result).not.toBe(schema);
    expect(result).toEqual({ type: 'object', properties: {} });
  });

  it('passes through undefined', () => {
    expect(normalizeResponsesParameters(undefined)).toBeUndefined();
  });
});
