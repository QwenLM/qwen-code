/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import type { ContentGeneratorConfig } from '../contentGenerator.js';
import type { ResponsesApiRequest, ResponsesApiInputItem } from './types.js';
import { applyResponsesPromptCaching } from './prompt-caching.js';
import { convertGeminiContentsToResponsesInput } from './responses-converter.js';
import { appendAutoMemoryContext } from '../../memory/request-context.js';
import { REATTACH_BOUNDARY_METADATA } from '../../services/image-payload-references.js';
import {
  content,
  fnCall,
  fnResponse,
  userText,
} from '../../test-utils/model-fixtures.js';

const marker = { mode: 'explicit' as const };
const config: ContentGeneratorConfig = { model: 'gpt-6.1-sol' };

function prepare(
  contents: Content[],
  overrides: Partial<ContentGeneratorConfig> = {},
  options?: ResponsesApiRequest['prompt_cache_options'],
) {
  const original = structuredClone(contents);
  const converted = convertGeminiContentsToResponsesInput({
    model: config.model,
    contents: appendAutoMemoryContext(contents, 'memory catalog'),
  });
  const request: ResponsesApiRequest = {
    model: overrides.model ?? config.model,
    input: converted.input,
    instructions: 'Preserve all safety and permission instructions.',
    prompt_cache_key: 'unchanged-key',
    ...(options ? { prompt_cache_options: options } : {}),
  };
  const before = structuredClone(request);
  const result = applyResponsesPromptCaching(
    request,
    { ...config, ...overrides },
    converted.cacheBoundary,
  );
  expect(contents).toEqual(original);
  expect(request).toEqual(before);
  expect(result.instructions).toBe(request.instructions);
  expect(result.prompt_cache_key).toBe(request.prompt_cache_key);
  const semanticInput = (input: ResponsesApiInputItem[]) =>
    JSON.parse(
      JSON.stringify(
        input.map((item) => {
          if (item.type === 'message' && typeof item.content === 'string') {
            return {
              ...item,
              content: [{ type: 'input_text', text: item.content }],
            };
          }
          if (
            item.type === 'function_call_output' &&
            typeof item.output === 'string'
          ) {
            return {
              ...item,
              output: [{ type: 'input_text', text: item.output }],
            };
          }
          return item;
        }),
        (key, value) => (key === 'prompt_cache_breakpoint' ? undefined : value),
      ),
    );
  expect(semanticInput(result.input)).toEqual(semanticInput(request.input));
  return { request, result };
}

function toolTurn(id: string): Content[] {
  return [
    content('model', fnCall('read_file', { path: id }, id)),
    content('user', fnResponse('read_file', { output: `result ${id}` }, id)),
  ];
}

function blocks(item: ResponsesApiInputItem) {
  const value =
    item.type === 'message'
      ? item.content
      : item.type === 'function_call_output'
        ? item.output
        : undefined;
  return Array.isArray(value) ? value : [];
}

function breakpoints(request: ResponsesApiRequest) {
  return request.input.flatMap((item, itemIndex) =>
    blocks(item).flatMap((block, contentIndex) =>
      block.type === 'input_text' && block.prompt_cache_breakpoint
        ? [{ itemIndex, contentIndex }]
        : [],
    ),
  );
}

describe('Responses stable prefix caching', () => {
  it('marks only the end of a consecutive group of tool outputs', () => {
    const { result } = prepare([
      userText('read both files'),
      content(
        'model',
        fnCall('read_file', {}, 'a'),
        fnCall('read_file', {}, 'b'),
      ),
      content(
        'user',
        fnResponse('read_file', { output: 'A' }, 'a'),
        fnResponse('read_file', { error: 'B failed' }, 'b'),
      ),
    ]);
    expect(result.input.slice(-3)).toEqual([
      {
        type: 'function_call_output',
        call_id: 'a',
        output: [{ type: 'input_text', text: 'A' }],
      },
      {
        type: 'function_call_output',
        call_id: 'b',
        output: [
          {
            type: 'input_text',
            text: 'B failed',
            prompt_cache_breakpoint: marker,
          },
        ],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'memory catalog' }],
      },
    ]);
    expect(breakpoints(result)).toHaveLength(2);
  });

  it('retains matching old endpoints and stable text-block shapes as markers rotate', () => {
    const history = [userText('Read files')];
    let previous: ResponsesApiRequest | undefined;
    for (let turn = 0; turn < 6; turn++) {
      history.push(...toolTurn(`file-${turn}`));
      const { result } = prepare(history);
      const endpoints = breakpoints(result);
      expect(endpoints).toHaveLength(Math.min(turn + 2, 3));
      if (previous) {
        const oldEndpoint = breakpoints(previous).at(-1)!;
        expect(endpoints).toContainEqual(oldEndpoint);
        // Ignoring cache metadata, the serialized stable prefix is unchanged.
        const strip = (value: unknown) =>
          JSON.parse(
            JSON.stringify(value, (key, entry) =>
              key === 'prompt_cache_breakpoint' ? undefined : entry,
            ),
          );
        expect(strip(result.input.slice(0, previous.input.length - 1))).toEqual(
          strip(previous.input.slice(0, -1)),
        );
      }
      previous = result;
    }
    expect(blocks(previous!.input[2]!)[0]).toEqual({
      type: 'input_text',
      text: 'result file-0',
    });
  });

  it('anchors before the whole volatile image region and catalog', () => {
    const converted = convertGeminiContentsToResponsesInput({
      model: config.model,
      contents: appendAutoMemoryContext(
        [
          content(
            'user',
            { text: 'stable question' },
            {
              text: 'reattached images',
              partMetadata: { [REATTACH_BOUNDARY_METADATA]: true },
            },
            { inlineData: { mimeType: 'image/png', data: 'AA==' } },
          ),
        ],
        'memory catalog',
      ),
    });
    const result = applyResponsesPromptCaching(
      { model: config.model, input: converted.input },
      config,
      converted.cacheBoundary,
    );
    expect(breakpoints(result)).toEqual([{ itemIndex: 0, contentIndex: 0 }]);
    expect(blocks(result.input[0]!)).toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain(REATTACH_BOUNDARY_METADATA);
  });

  it('keeps tool-returned images and reasoning in their original order', () => {
    const imageResult = fnResponse(
      'read_file',
      { output: 'image result' },
      'img',
    );
    imageResult.functionResponse!.parts = [
      { inlineData: { mimeType: 'image/png', data: 'AA==' } },
    ];
    const { request, result } = prepare([
      userText('Inspect image'),
      content(
        'model',
        { thought: true, text: 'reasoning summary' },
        fnCall('read_file', {}, 'img'),
      ),
      content('user', imageResult),
    ]);
    expect(result.input.map((item) => item.type)).toEqual(
      request.input.map((item) => item.type),
    );
    expect(result.input.at(-1)).toEqual(request.input.at(-1));
    expect(result.input.at(-2)).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'memory catalog' }],
    });
    expect(result.input[1]).toEqual(request.input[1]);
    expect(breakpoints(result).at(-1)?.itemIndex).toBe(3);
  });

  it.each([
    { model: 'gpt-5.5' },
    { model: 'qwen3-coder-plus', enableCacheControl: true },
    { enableCacheControl: false },
    { baseUrl: 'https://proxy.example/v1' },
    { baseUrl: 'https://api.openai.com.evil.test/v1' },
  ])(
    'leaves unsupported or disabled configurations untouched: %j',
    (overrides) => {
      const { request, result } = prepare(
        [userText('hello'), ...toolTurn('a')],
        overrides,
      );
      expect(result).toBe(request);
    },
  );

  it.each([
    { baseUrl: 'https://proxy.example/v1', enableCacheControl: true },
    { baseUrl: 'https://api.openai.com/v1' },
    { model: 'gpt-5.6-2026-08-01' },
  ])('supports declared cache capability: %j', (overrides) => {
    const { result } = prepare(
      [userText('hello'), ...toolTurn('a')],
      overrides,
    );
    expect(breakpoints(result)).toHaveLength(2);
    expect(result.prompt_cache_options).toEqual({ mode: 'implicit' });
  });

  it('honors proxy opt-in through existing request options without changing the TTL', () => {
    const options = { mode: 'implicit' as const, ttl: '12h' as const };
    const { result } = prepare(
      [userText('hello')],
      { baseUrl: 'https://proxy.example/v1' },
      options,
    );
    expect(breakpoints(result)).toHaveLength(1);
    expect(result.prompt_cache_options).toEqual(options);
  });

  it('preserves caller-owned explicit-only mode', () => {
    const { request, result } = prepare(
      [userText('hello')],
      {},
      { mode: 'explicit', ttl: '30m' },
    );
    expect(result).toBe(request);
  });

  it('preserves existing caller breakpoints', () => {
    const request: ResponsesApiRequest = {
      model: config.model,
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [
            {
              type: 'input_text',
              text: 'caller policy',
              prompt_cache_breakpoint: { mode: 'explicit', ttl: '12h' },
            },
          ],
        },
      ],
    };
    expect(applyResponsesPromptCaching(request, config, { itemIndex: 0 })).toBe(
      request,
    );
  });

  it('keeps existing multimodal output blocks intact', () => {
    const request: ResponsesApiRequest = {
      model: config.model,
      input: [
        {
          type: 'function_call_output',
          call_id: 'image-call',
          output: [
            { type: 'input_text', text: 'image description' },
            { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
          ],
        },
      ],
    };
    const result = applyResponsesPromptCaching(request, config, {
      itemIndex: 0,
    });
    expect(blocks(result.input[0]!)).toEqual([
      {
        type: 'input_text',
        text: 'image description',
        prompt_cache_breakpoint: marker,
      },
      { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
    ]);
    expect(request.input[0]).toEqual({
      type: 'function_call_output',
      call_id: 'image-call',
      output: [
        { type: 'input_text', text: 'image description' },
        { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
      ],
    });
  });

  it('leaves requests without a volatile tail or a stable boundary unchanged', () => {
    const request: ResponsesApiRequest = { model: config.model, input: [] };
    expect(applyResponsesPromptCaching(request, config, undefined)).toBe(
      request,
    );
    const { result } = prepare([]);
    expect(result.prompt_cache_options).toBeUndefined();
    expect(breakpoints(result)).toEqual([]);
  });

  it('does not mark the middle of a mixed function/custom tool-output group', () => {
    const request: ResponsesApiRequest = {
      model: config.model,
      input: [
        { type: 'function_call_output', call_id: 'a', output: 'A' },
        { type: 'custom_tool_call_output', call_id: 'b', output: 'B' },
      ],
    };
    expect(applyResponsesPromptCaching(request, config, { itemIndex: 1 })).toBe(
      request,
    );
  });
});
