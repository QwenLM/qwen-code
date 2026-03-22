/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { GenerateContentResponse } from '@google/genai';
import {
  ResponsesPipeline,
  mergeStreamResponses,
} from './responsesPipeline.js';
import type { ResponsesPipelineState } from './responsesPipeline.js';
import type { ContentGeneratorConfig } from '../contentGenerator.js';
import type { ResponsesApiRequest } from './types.js';

function makeConfig(
  overrides: Partial<ContentGeneratorConfig> = {},
): ContentGeneratorConfig {
  return {
    model: 'codex-mini',
    apiKey: 'test-key',
    baseUrl: 'https://api.test.com',
    ...overrides,
  } as ContentGeneratorConfig;
}

function makeRequest(
  contents: Array<{ role: string; parts: Array<{ text: string }> }>,
): unknown {
  return { model: 'codex-mini', contents };
}

function callBuildRequest(
  pipeline: ResponsesPipeline,
  request: unknown,
  promptId: string,
): ResponsesApiRequest {
  return (
    pipeline as unknown as {
      buildRequest: (req: unknown, promptId: string) => ResponsesApiRequest;
    }
  ).buildRequest(request, promptId);
}

function getInternalState(
  pipeline: ResponsesPipeline,
): ResponsesPipelineState {
  return (pipeline as unknown as { state: ResponsesPipelineState }).state;
}

describe('ResponsesPipeline', () => {
  describe('state management', () => {
    it('should initialize with null state', () => {
      const pipeline = new ResponsesPipeline(makeConfig());
      const state = pipeline.getState();
      expect(state.lastResponseId).toBeNull();
      expect(state.lastInputItemCount).toBe(0);
    });

    it('should reset state', () => {
      const pipeline = new ResponsesPipeline(makeConfig());
      pipeline.resetState();
      const state = pipeline.getState();
      expect(state.lastResponseId).toBeNull();
      expect(state.lastInputItemCount).toBe(0);
    });
  });

  describe('reasoning config', () => {
    it('should build reasoning with effort and auto summary', () => {
      const pipeline = new ResponsesPipeline(
        makeConfig({
          reasoning: { effort: 'high' },
        }),
      );
      const reasoning = (
        pipeline as unknown as { buildReasoning: () => unknown }
      ).buildReasoning();
      expect(reasoning).toEqual({ effort: 'high', summary: 'auto' });
    });

    it('should respect explicit summary', () => {
      const pipeline = new ResponsesPipeline(
        makeConfig({
          reasoning: { effort: 'medium', summary: 'concise' },
        }),
      );
      const reasoning = (
        pipeline as unknown as { buildReasoning: () => unknown }
      ).buildReasoning();
      expect(reasoning).toEqual({ effort: 'medium', summary: 'concise' });
    });

    it('should return undefined when reasoning is false', () => {
      const pipeline = new ResponsesPipeline(
        makeConfig({ reasoning: false }),
      );
      const reasoning = (
        pipeline as unknown as { buildReasoning: () => unknown }
      ).buildReasoning();
      expect(reasoning).toBeUndefined();
    });

    it('should return undefined when reasoning is not set', () => {
      const pipeline = new ResponsesPipeline(makeConfig());
      const reasoning = (
        pipeline as unknown as { buildReasoning: () => unknown }
      ).buildReasoning();
      expect(reasoning).toBeUndefined();
    });
  });

  describe('text controls', () => {
    it('should build verbosity control', () => {
      const pipeline = new ResponsesPipeline(
        makeConfig({ verbosity: 'low' }),
      );
      const text = (
        pipeline as unknown as { buildTextControls: () => unknown }
      ).buildTextControls();
      expect(text).toEqual({ verbosity: 'low' });
    });

    it('should return undefined when no verbosity', () => {
      const pipeline = new ResponsesPipeline(makeConfig());
      const text = (
        pipeline as unknown as { buildTextControls: () => unknown }
      ).buildTextControls();
      expect(text).toBeUndefined();
    });
  });

  describe('buildRequest() output validation', () => {
    it('should include standard request fields', () => {
      const pipeline = new ResponsesPipeline(makeConfig());
      const request = makeRequest([
        { role: 'user', parts: [{ text: 'hello' }] },
      ]);
      const result = callBuildRequest(pipeline, request, 'prompt-1');

      expect(result.model).toBe('codex-mini');
      expect(result.truncation).toEqual({ type: 'auto' });
      expect(result.parallel_tool_calls).toBe(true);
      expect(result.tool_choice).toBe('auto');
      expect(result.stream).toBe(true);
      expect(result.store).toBe(true);
      expect(result.prompt_cache_key).toBe('prompt-1');
    });

    it('should include user input items', () => {
      const pipeline = new ResponsesPipeline(makeConfig());
      const request = makeRequest([
        { role: 'user', parts: [{ text: 'hello' }] },
      ]);
      const result = callBuildRequest(pipeline, request, 'p-1');

      expect(result.input).toHaveLength(1);
      expect(result.input[0]).toEqual({
        type: 'message',
        role: 'user',
        content: 'hello',
      });
    });

    it('should not set previous_response_id by default', () => {
      const pipeline = new ResponsesPipeline(makeConfig());
      const request = makeRequest([
        { role: 'user', parts: [{ text: 'hello' }] },
      ]);
      const result = callBuildRequest(pipeline, request, 'p-1');

      expect(result.previous_response_id).toBeUndefined();
    });
  });

  describe('buildRequest() with previous_response_id', () => {
    it('should set previous_response_id and slice input', () => {
      const pipeline = new ResponsesPipeline(makeConfig());
      const state = getInternalState(pipeline);
      state.lastResponseId = 'resp-abc';
      state.lastInputItemCount = 1;

      const request = makeRequest([
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'reply' }] },
        { role: 'user', parts: [{ text: 'second' }] },
      ]);
      const result = callBuildRequest(pipeline, request, 'p-1');

      expect(result.previous_response_id).toBe('resp-abc');
      expect(result.input).toHaveLength(2);
    });

    it('should send full input when count does not exceed lastInputItemCount', () => {
      const pipeline = new ResponsesPipeline(makeConfig());
      const state = getInternalState(pipeline);
      state.lastResponseId = 'resp-abc';
      state.lastInputItemCount = 1;

      const request = makeRequest([
        { role: 'user', parts: [{ text: 'hello' }] },
      ]);
      const result = callBuildRequest(pipeline, request, 'p-1');

      expect(result.previous_response_id).toBeUndefined();
      expect(result.input).toHaveLength(1);
    });

    it('should drain pendingEncryptedItems into input', () => {
      const pipeline = new ResponsesPipeline(makeConfig());
      const state = getInternalState(pipeline);
      state.pendingEncryptedItems = [
        { type: 'reasoning', id: 'r1', encrypted_content: 'enc-data' },
      ];

      const request = makeRequest([
        { role: 'user', parts: [{ text: 'hello' }] },
      ]);
      const result = callBuildRequest(pipeline, request, 'p-1');

      expect(result.input.length).toBeGreaterThanOrEqual(2);
      expect(state.pendingEncryptedItems).toHaveLength(0);
    });
  });

  describe('buildRequest() with extra_body', () => {
    it('should merge extra_body fields into the request', () => {
      const pipeline = new ResponsesPipeline(
        makeConfig({
          extra_body: {
            metadata: { session_id: 'abc' },
            custom_field: 42,
          },
        }),
      );
      const request = makeRequest([
        { role: 'user', parts: [{ text: 'hello' }] },
      ]);
      const result = callBuildRequest(pipeline, request, 'p-1') as unknown as Record<
        string,
        unknown
      >;

      expect(result['metadata']).toEqual({ session_id: 'abc' });
      expect(result['custom_field']).toBe(42);
    });
  });

  describe('buildRequest() with sampling params', () => {
    it('should include temperature, top_p, and max_output_tokens', () => {
      const pipeline = new ResponsesPipeline(
        makeConfig({
          samplingParams: {
            temperature: 0.7,
            top_p: 0.9,
            max_tokens: 4096,
          },
        }),
      );
      const request = makeRequest([
        { role: 'user', parts: [{ text: 'hello' }] },
      ]);
      const result = callBuildRequest(pipeline, request, 'p-1');

      expect(result.temperature).toBe(0.7);
      expect(result.top_p).toBe(0.9);
      expect(result.max_output_tokens).toBe(4096);
    });

    it('should omit unset sampling params', () => {
      const pipeline = new ResponsesPipeline(
        makeConfig({
          samplingParams: { temperature: 0.5 },
        }),
      );
      const request = makeRequest([
        { role: 'user', parts: [{ text: 'hello' }] },
      ]);
      const result = callBuildRequest(pipeline, request, 'p-1');

      expect(result.temperature).toBe(0.5);
      expect(result.top_p).toBeUndefined();
      expect(result.max_output_tokens).toBeUndefined();
    });

    it('should not set sampling params when not configured', () => {
      const pipeline = new ResponsesPipeline(makeConfig());
      const request = makeRequest([
        { role: 'user', parts: [{ text: 'hello' }] },
      ]);
      const result = callBuildRequest(pipeline, request, 'p-1');

      expect(result.temperature).toBeUndefined();
      expect(result.top_p).toBeUndefined();
      expect(result.max_output_tokens).toBeUndefined();
    });
  });

  describe('buildRequest() with service_tier', () => {
    it('should include service_tier when configured', () => {
      const pipeline = new ResponsesPipeline(
        makeConfig({ serviceTier: 'priority' }),
      );
      const request = makeRequest([
        { role: 'user', parts: [{ text: 'hello' }] },
      ]);
      const result = callBuildRequest(pipeline, request, 'p-1');

      expect(result.service_tier).toBe('priority');
    });

    it('should omit service_tier when not configured', () => {
      const pipeline = new ResponsesPipeline(makeConfig());
      const request = makeRequest([
        { role: 'user', parts: [{ text: 'hello' }] },
      ]);
      const result = callBuildRequest(pipeline, request, 'p-1');

      expect(result.service_tier).toBeUndefined();
    });
  });

  describe('buildRequest() with reasoning in request', () => {
    it('should include reasoning and include array', () => {
      const pipeline = new ResponsesPipeline(
        makeConfig({ reasoning: { effort: 'high' } }),
      );
      const request = makeRequest([
        { role: 'user', parts: [{ text: 'hello' }] },
      ]);
      const result = callBuildRequest(pipeline, request, 'p-1');

      expect(result.reasoning).toEqual({ effort: 'high', summary: 'auto' });
      expect(result.include).toEqual(['reasoning.encrypted_content']);
    });

    it('should not set reasoning or include when reasoning is false', () => {
      const pipeline = new ResponsesPipeline(
        makeConfig({ reasoning: false }),
      );
      const request = makeRequest([
        { role: 'user', parts: [{ text: 'hello' }] },
      ]);
      const result = callBuildRequest(pipeline, request, 'p-1');

      expect(result.reasoning).toBeUndefined();
      expect(result.include).toBeUndefined();
    });
  });

  describe('resetState() clears all fields', () => {
    it('should clear all state including pendingEncryptedItems', () => {
      const pipeline = new ResponsesPipeline(makeConfig());
      const state = getInternalState(pipeline);
      state.lastResponseId = 'resp-xyz';
      state.lastInputItemCount = 5;
      state.pendingEncryptedItems = [
        { type: 'reasoning', id: 'r1', encrypted_content: 'data1' },
        { type: 'compaction', encrypted_content: 'data2' },
      ];

      pipeline.resetState();

      const newState = pipeline.getState();
      expect(newState.lastResponseId).toBeNull();
      expect(newState.lastInputItemCount).toBe(0);
      expect(newState.pendingEncryptedItems).toHaveLength(0);
    });
  });

  describe('mergeStreamResponses()', () => {
    it('should return empty candidates for 0 chunks', () => {
      const result = mergeStreamResponses([]);
      expect(result.candidates).toEqual([]);
    });

    it('should return the single chunk for 1 chunk', () => {
      const chunk = new GenerateContentResponse();
      chunk.candidates = [
        {
          content: { parts: [{ text: 'hello' }], role: 'model' },
        },
      ] as GenerateContentResponse['candidates'];
      const result = mergeStreamResponses([chunk]);
      expect(result).toBe(chunk);
    });

    it('should merge parts from multiple chunks', () => {
      const chunk1 = new GenerateContentResponse();
      chunk1.candidates = [
        {
          content: { parts: [{ text: 'hel' }], role: 'model' },
        },
      ] as GenerateContentResponse['candidates'];
      const chunk2 = new GenerateContentResponse();
      chunk2.candidates = [
        {
          content: { parts: [{ text: 'lo' }], role: 'model' },
        },
      ] as GenerateContentResponse['candidates'];
      const result = mergeStreamResponses([chunk1, chunk2]);

      expect(result.candidates).toHaveLength(1);
      expect(result.candidates![0]!.content!.parts).toHaveLength(2);
      expect(result.candidates![0]!.content!.parts![0]).toEqual({
        text: 'hel',
      });
      expect(result.candidates![0]!.content!.parts![1]).toEqual({
        text: 'lo',
      });
    });
  });
});
