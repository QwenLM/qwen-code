/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  FunctionResponsePart,
  GenerateContentParameters,
  Part,
  Tool,
} from '@google/genai';
import { FunctionCallingConfigMode } from '@google/genai';
import type { ContentGeneratorConfig } from '../contentGenerator.js';
import {
  buildDashScopeRequest,
  canonicalizeToolJson,
  cleanOrphanedToolCalls,
  convertGeminiContentsToDashScopeMessages,
  convertGeminiToolsToDashScopeTools,
} from './request-converter.js';
import type { DashScopeMessage, DashScopeTool } from './types.js';

function createTestConfig(
  overrides: Partial<ContentGeneratorConfig> = {},
): ContentGeneratorConfig {
  return {
    apiKey: 'test-key',
    model: 'qwen3.8-max',
    ...overrides,
  } as ContentGeneratorConfig;
}

function build(
  request: GenerateContentParameters,
  configOverrides: Partial<ContentGeneratorConfig> = {},
  streaming = false,
) {
  return buildDashScopeRequest(request, {
    contentGeneratorConfig: createTestConfig(configOverrides),
    streaming,
  });
}

describe('buildDashScopeRequest — system instruction', () => {
  it('flattens a string systemInstruction into the first message', () => {
    const result = build(
      {
        model: 'qwen3.8-max',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        config: { systemInstruction: 'be helpful' },
      },
      { enableCacheControl: false },
    );

    expect(result.input.messages[0]).toEqual({
      role: 'system',
      content: [{ text: 'be helpful' }],
    });
  });

  it('flattens a Content systemInstruction', () => {
    const result = build(
      {
        model: 'qwen3.8-max',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        config: {
          systemInstruction: {
            role: 'system',
            parts: [{ text: 'be helpful' }],
          },
        },
      },
      { enableCacheControl: false },
    );

    expect(result.input.messages[0]).toEqual({
      role: 'system',
      content: [{ text: 'be helpful' }],
    });
  });

  it('flattens a Part[] systemInstruction', () => {
    const result = build(
      {
        model: 'qwen3.8-max',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        config: { systemInstruction: [{ text: 'be helpful' }] },
      },
      { enableCacheControl: false },
    );

    expect(result.input.messages[0]).toEqual({
      role: 'system',
      content: [{ text: 'be helpful' }],
    });
  });

  it('omits the system message when systemInstruction is empty', () => {
    const result = build({
      model: 'qwen3.8-max',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });

    expect(result.input.messages[0]!.role).toBe('user');
  });
});

describe('convertGeminiContentsToDashScopeMessages — user content', () => {
  it('converts a plain string content to a user text block', () => {
    const messages = convertGeminiContentsToDashScopeMessages('hi', {
      splitToolMedia: true,
    });
    expect(messages).toEqual([{ role: 'user', content: [{ text: 'hi' }] }]);
  });

  it('normalizes a bare text part into a user message', () => {
    const messages = convertGeminiContentsToDashScopeMessages(
      { text: 'hello' },
      { splitToolMedia: true },
    );
    expect(messages).toEqual([{ role: 'user', content: [{ text: 'hello' }] }]);
  });

  it('normalizes a bare part array into one user message', () => {
    const messages = convertGeminiContentsToDashScopeMessages(
      [
        { text: 'hello' },
        { inlineData: { mimeType: 'image/png', data: 'abc' } },
      ],
      { splitToolMedia: true },
    );
    expect(messages).toEqual([
      {
        role: 'user',
        content: [{ text: 'hello' }, { image: 'data:image/png;base64,abc' }],
      },
    ]);
  });

  it('rejects bare function call and response parts', () => {
    const parts: Part[] = [
      { functionCall: { name: 'get_weather', args: {} } },
      {
        functionResponse: {
          name: 'get_weather',
          response: { output: 'sunny' },
        },
      },
    ];

    for (const part of parts) {
      expect(() =>
        convertGeminiContentsToDashScopeMessages(part, {
          splitToolMedia: true,
        }),
      ).toThrow(/wrap them in a Content object/);
      expect(() =>
        convertGeminiContentsToDashScopeMessages([part], {
          splitToolMedia: true,
        }),
      ).toThrow(/wrap them, and any other parts, in Content objects/);
    }
  });

  it('maps inline PNG data to an image block', () => {
    const messages = convertGeminiContentsToDashScopeMessages(
      [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: 'image/png', data: 'abc' } }],
        },
      ],
      { splitToolMedia: true },
    );
    expect(messages).toEqual([
      {
        role: 'user',
        content: [{ image: 'data:image/png;base64,abc' }],
      },
    ]);
  });

  it('maps inline and file audio data to audio blocks', () => {
    const messages = convertGeminiContentsToDashScopeMessages(
      [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'audio/mpeg', data: 'abc' } },
            {
              fileData: {
                mimeType: 'audio/wav',
                fileUri: 'https://example.test/audio.wav',
              },
            },
          ],
        },
      ],
      { splitToolMedia: true },
    );
    expect(messages).toEqual([
      {
        role: 'user',
        content: [
          { audio: 'data:audio/mpeg;base64,abc' },
          { audio: 'https://example.test/audio.wav' },
        ],
      },
    ]);
  });

  it('maps an unsupported mime type to a text placeholder', () => {
    const messages = convertGeminiContentsToDashScopeMessages(
      [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: 'application/zip', data: 'abc' } }],
        },
      ],
      { splitToolMedia: true },
    );
    expect(messages).toEqual([
      {
        role: 'user',
        content: [{ text: '[Unsupported content type: application/zip]' }],
      },
    ]);
  });
});

describe('convertGeminiContentsToDashScopeMessages — assistant content', () => {
  it('concatenates thought parts into reasoning_content', () => {
    const messages = convertGeminiContentsToDashScopeMessages(
      [
        {
          role: 'model',
          parts: [
            { text: 'step one ', thought: true },
            { text: 'step two', thought: true },
            { text: 'answer' },
          ],
        },
      ],
      { splitToolMedia: true },
    );
    expect(messages).toEqual([
      {
        role: 'assistant',
        content: [{ text: 'answer' }],
        reasoning_content: 'step one step two',
      },
    ]);
  });

  it('emits content: [] when only tool_calls are present', () => {
    const messages = convertGeminiContentsToDashScopeMessages(
      [
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'get_weather', args: { city: 'Paris' } },
            },
          ],
        },
      ],
      { splitToolMedia: true },
    );
    expect(messages).toHaveLength(1);
    const message = messages[0]!;
    expect(message.role).toBe('assistant');
    expect(message.content).toEqual([]);
    expect(message.tool_calls).toHaveLength(1);
    expect(message.tool_calls![0]!.function.name).toBe('get_weather');
    expect(message.tool_calls![0]!.function.arguments).toBe('{"city":"Paris"}');
  });

  it('synthesizes deterministic ids stable across two independent builds', () => {
    const contents: GenerateContentParameters['contents'] = [
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
        ],
      },
    ];

    const first = convertGeminiContentsToDashScopeMessages(contents, {
      splitToolMedia: true,
    });
    const second = convertGeminiContentsToDashScopeMessages(contents, {
      splitToolMedia: true,
    });

    const firstId = first[0]!.tool_calls![0]!.id;
    const secondId = second[0]!.tool_calls![0]!.id;
    expect(firstId).toMatch(/^call_[0-9a-f]{24}$/);
    expect(firstId).toBe(secondId);
  });

  it('uses the explicit functionCall id when present', () => {
    const messages = convertGeminiContentsToDashScopeMessages(
      [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_explicit',
                name: 'get_weather',
                args: {},
              },
            },
          ],
        },
      ],
      { splitToolMedia: true },
    );
    expect(messages[0]!.tool_calls![0]!.id).toBe('call_explicit');
  });
});

describe('convertGeminiContentsToDashScopeMessages — tool results', () => {
  it('emits a separate tool message with a matching tool_call_id', () => {
    const messages = convertGeminiContentsToDashScopeMessages(
      [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_1',
                name: 'get_weather',
                args: { city: 'Paris' },
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
                name: 'get_weather',
                response: { output: '22C sunny' },
              },
            },
          ],
        },
      ],
      { splitToolMedia: true },
    );

    expect(messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: [{ text: '22C sunny' }],
    });
  });

  it('matches a functionResponse with no id by name and call order', () => {
    const messages = convertGeminiContentsToDashScopeMessages(
      [
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'get_weather',
                response: { output: '22C sunny' },
              },
            },
          ],
        },
      ],
      { splitToolMedia: true },
    );

    const callId = messages[0]!.tool_calls![0]!.id;
    expect(messages[1]!.tool_call_id).toBe(callId);
  });

  it('advances call-order matching after an explicit-id response', () => {
    const messages = convertGeminiContentsToDashScopeMessages(
      [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_1',
                name: 'get_weather',
                args: { city: 'Paris' },
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
                name: 'get_weather',
                response: { output: '22C sunny' },
              },
            },
          ],
        },
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'get_weather', args: { city: 'Tokyo' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'get_weather',
                response: { output: '28C sunny' },
              },
            },
          ],
        },
      ],
      { splitToolMedia: true },
    );

    const secondCallId = messages[2]!.tool_calls![0]!.id;
    expect(messages[3]!.tool_call_id).toBe(secondCallId);
  });

  it('preserves text parts in a functionResponse', () => {
    const messages = convertGeminiContentsToDashScopeMessages(
      [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_1',
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
                id: 'call_1',
                name: 'read_file',
                response: { output: 'file contents' },
                parts: [
                  {
                    text: '[Image omitted during compaction]',
                  } as FunctionResponsePart,
                ],
              },
            },
          ],
        },
      ],
      { splitToolMedia: true },
    );

    expect(messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: [
        { text: 'file contents' },
        { text: '[Image omitted during compaction]' },
      ],
    });
  });
});

describe('cleanOrphanedToolCalls', () => {
  it('drops an orphaned tool_calls entry and keeps the message if content survives', () => {
    const messages: DashScopeMessage[] = [
      {
        role: 'assistant',
        content: [{ text: 'ok' }],
        tool_calls: [
          {
            id: 'call_orphan',
            index: 0,
            type: 'function',
            function: { name: 'noop', arguments: '{}' },
          },
        ],
      },
    ];
    const cleaned = cleanOrphanedToolCalls(messages);
    expect(cleaned).toEqual([{ role: 'assistant', content: [{ text: 'ok' }] }]);
  });

  it('drops an assistant message left empty after orphan removal', () => {
    const messages: DashScopeMessage[] = [
      {
        role: 'assistant',
        content: [],
        tool_calls: [
          {
            id: 'call_orphan',
            index: 0,
            type: 'function',
            function: { name: 'noop', arguments: '{}' },
          },
        ],
      },
    ];
    expect(cleanOrphanedToolCalls(messages)).toEqual([]);
  });

  it('drops an orphaned tool message with no matching tool_calls entry', () => {
    const messages: DashScopeMessage[] = [
      { role: 'tool', tool_call_id: 'call_missing', content: [{ text: 'x' }] },
    ];
    expect(cleanOrphanedToolCalls(messages)).toEqual([]);
  });

  it('keeps a matched tool_calls/tool pair', () => {
    const messages: DashScopeMessage[] = [
      {
        role: 'assistant',
        content: [],
        tool_calls: [
          {
            id: 'call_1',
            index: 0,
            type: 'function',
            function: { name: 'get_weather', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: [{ text: 'ok' }] },
    ];
    expect(cleanOrphanedToolCalls(messages)).toEqual(messages);
  });
});

describe('convertGeminiToolsToDashScopeTools + canonicalizeToolJson', () => {
  function makeTool(order: 'a' | 'b'): Tool {
    const propsA = { city: { type: 'string' }, unit: { type: 'string' } };
    const propsB = { unit: { type: 'string' }, city: { type: 'string' } };
    return {
      functionDeclarations: [
        {
          name: 'get_weather',
          description: 'Get weather',
          parametersJsonSchema: {
            type: 'object',
            properties: order === 'a' ? propsA : propsB,
            required: ['city'],
          },
        },
      ],
    };
  }

  it('produces byte-identical JSON regardless of source property order', () => {
    const toolsA = convertGeminiToolsToDashScopeTools([makeTool('a')]);
    const toolsB = convertGeminiToolsToDashScopeTools([makeTool('b')]);
    expect(JSON.stringify(toolsA)).toBe(JSON.stringify(toolsB));
  });

  it('orders schema keys deterministically', () => {
    const tool: DashScopeTool = {
      type: 'function',
      function: {
        name: 'f',
        parameters: {
          required: ['b'],
          properties: { b: { type: 'string' }, a: { type: 'string' } },
          type: 'object',
        },
      },
    };
    const canonical = canonicalizeToolJson(tool);
    expect(Object.keys(canonical.function.parameters!)).toEqual([
      'type',
      'properties',
      'required',
    ]);
    expect(
      Object.keys(canonical.function.parameters!['properties'] as object),
    ).toEqual(['a', 'b']);
  });

  it('drops CallableTool entries (async resolution unsupported here)', () => {
    const callable = { tool: async () => ({ functionDeclarations: [] }) };
    const result = convertGeminiToolsToDashScopeTools([callable as never]);
    expect(result).toBeUndefined();
  });
});

describe('buildDashScopeRequest — tools + cache_control', () => {
  const tools: Tool[] = [
    {
      functionDeclarations: [
        { name: 'tool_a', parametersJsonSchema: { type: 'object' } },
      ],
    },
    {
      functionDeclarations: [
        { name: 'tool_b', parametersJsonSchema: { type: 'object' } },
      ],
    },
  ];

  it('sets cache_control only on the last tool when caching is enabled', () => {
    const result = build({
      model: 'qwen3.8-max',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      config: { tools },
    });
    const wireTools = result.parameters['tools'] as DashScopeTool[];
    expect(wireTools[0]!.cache_control).toBeUndefined();
    expect(wireTools[1]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('omits cache_control on tools when caching is disabled', () => {
    const result = build(
      {
        model: 'qwen3.8-max',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        config: { tools },
      },
      { enableCacheControl: false },
    );
    expect(JSON.stringify(result.parameters['tools'])).not.toContain(
      'cache_control',
    );
  });
});

describe('buildDashScopeRequest — parameters assembly', () => {
  const baseRequest: GenerateContentParameters = {
    model: 'qwen3.8-max',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  };

  it('uses the request model with the configured model as fallback', () => {
    expect(build({ ...baseRequest, model: 'per-request-model' }).model).toBe(
      'per-request-model',
    );
    expect(build({ ...baseRequest, model: '' }).model).toBe('qwen3.8-max');
  });

  it('does not apply configured mandatory thinking to a model override', () => {
    const result = build(
      { ...baseRequest, model: 'per-request-model' },
      {
        thinkingMandatory: true,
        extra_body: { enable_thinking: false },
      },
    );
    expect(result.parameters['reasoning_effort']).toBe('none');
  });

  it.each(['low', 'medium', 'xhigh'] as const)(
    'emits supported qwen3.8-max effort tier %s',
    (effort) => {
      const result = build(baseRequest, { reasoning: { effort } });
      expect(result.parameters['reasoning_effort']).toBe(effort);
    },
  );

  it.each(['high', 'max'] as const)(
    'clamps legacy qwen3.8-max effort tier %s to xhigh',
    (effort) => {
      const result = build(baseRequest, { reasoning: { effort } });
      expect(result.parameters['reasoning_effort']).toBe('xhigh');
    },
  );

  it('does not constrain an editable native model with another id', () => {
    const result = build(
      { ...baseRequest, model: 'custom-model' },
      { reasoning: { effort: 'high' } },
    );
    expect(result.parameters['reasoning_effort']).toBe('high');
  });

  it('preserves an explicit raw reasoning_effort override', () => {
    const result = build(baseRequest, {
      reasoning: { effort: 'low' },
      extra_body: { reasoning_effort: 'max' },
    });
    expect(result.parameters['reasoning_effort']).toBe('max');
  });

  it('always sets result_format: message', () => {
    const result = build(baseRequest);
    expect(result.parameters['result_format']).toBe('message');
  });

  it('sets incremental_output only when streaming', () => {
    expect(build(baseRequest, {}, true).parameters['incremental_output']).toBe(
      true,
    );
    expect(
      build(baseRequest, {}, false).parameters['incremental_output'],
    ).toBeUndefined();
  });

  it('maps maxOutputTokens to max_tokens and never emits max_completion_tokens', () => {
    const result = build({
      ...baseRequest,
      config: { maxOutputTokens: 1024 },
    });
    expect(result.parameters['max_tokens']).toBe(1024);
    expect(result.parameters['max_completion_tokens']).toBeUndefined();
  });

  it('maps request-level sampling controls', () => {
    const result = build({
      ...baseRequest,
      config: {
        topK: 12,
        presencePenalty: 0.25,
        frequencyPenalty: -0.5,
      },
    });

    expect(result.parameters['top_k']).toBe(12);
    expect(result.parameters['presence_penalty']).toBe(0.25);
    expect(result.parameters['frequency_penalty']).toBe(-0.5);
  });

  it('maps configured frequency and repetition penalties', () => {
    const result = build(baseRequest, {
      samplingParams: {
        frequency_penalty: 0.3,
        repetition_penalty: 1.1,
      },
    });

    expect(result.parameters['frequency_penalty']).toBe(0.3);
    expect(result.parameters['repetition_penalty']).toBe(1.1);
  });

  it('prefers request-level sampling controls over configured values', () => {
    const result = build(
      {
        ...baseRequest,
        config: {
          topK: 12,
          presencePenalty: 0.25,
          frequencyPenalty: -0.5,
        },
      },
      {
        samplingParams: {
          top_k: 20,
          presence_penalty: 0.4,
          frequency_penalty: 0.6,
        },
      },
    );

    expect(result.parameters['top_k']).toBe(12);
    expect(result.parameters['presence_penalty']).toBe(0.25);
    expect(result.parameters['frequency_penalty']).toBe(-0.5);
  });

  it('lets extra_body pass max_completion_tokens through explicitly', () => {
    const result = build(baseRequest, {
      extra_body: { max_completion_tokens: 2048 },
    });
    expect(result.parameters['max_completion_tokens']).toBe(2048);
  });

  it('passes an unknown extra_body key through and intercepts thinking keys', () => {
    const result = build(baseRequest, {
      extra_body: {
        some_future_key: 'value',
        enable_thinking: false,
        reasoning_effort: 'low',
        thinking_budget: 999,
      },
    });
    expect(result.parameters['some_future_key']).toBe('value');
    expect(result.parameters['enable_thinking']).toBeUndefined();
    expect(result.parameters['reasoning_effort']).toBe('none');
    expect(result.parameters['thinking_budget']).toBeUndefined();
  });

  it('omits tool_choice for AUTO mode', () => {
    const result = build({
      ...baseRequest,
      config: {
        tools: [
          {
            functionDeclarations: [
              { name: 'a', parametersJsonSchema: { type: 'object' } },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
        },
      },
    });
    expect(result.parameters['tool_choice']).toBeUndefined();
  });

  it('maps ANY with a single allowed name to a named tool_choice object', () => {
    const result = build({
      ...baseRequest,
      config: {
        tools: [
          {
            functionDeclarations: [
              { name: 'a', parametersJsonSchema: { type: 'object' } },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
            allowedFunctionNames: ['a'],
          },
        },
      },
    });
    expect(result.parameters['tool_choice']).toEqual({
      type: 'function',
      function: { name: 'a' },
    });
  });

  it('maps ANY with multiple/no allowed names to required', () => {
    const result = build({
      ...baseRequest,
      config: {
        tools: [
          {
            functionDeclarations: [
              { name: 'a', parametersJsonSchema: { type: 'object' } },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: { mode: FunctionCallingConfigMode.ANY },
        },
      },
    });
    expect(result.parameters['tool_choice']).toBe('required');
  });

  it('maps NONE to "none"', () => {
    const result = build({
      ...baseRequest,
      config: {
        tools: [
          {
            functionDeclarations: [
              { name: 'a', parametersJsonSchema: { type: 'object' } },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: { mode: FunctionCallingConfigMode.NONE },
        },
      },
    });
    expect(result.parameters['tool_choice']).toBe('none');
  });

  it('downgrades a forced tool_choice to auto when thinking is mandatory', () => {
    const result = build(
      {
        ...baseRequest,
        config: {
          tools: [
            {
              functionDeclarations: [
                { name: 'a', parametersJsonSchema: { type: 'object' } },
              ],
            },
          ],
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingConfigMode.ANY },
          },
        },
      },
      { thinkingMandatory: true },
    );
    expect(result.parameters['tool_choice']).toBe('auto');
    expect(result.parameters['reasoning_effort']).toBeUndefined();
  });

  it('forces reasoning_effort:none for a forced tool_choice when not mandatory', () => {
    const result = build({
      ...baseRequest,
      config: {
        tools: [
          {
            functionDeclarations: [
              { name: 'a', parametersJsonSchema: { type: 'object' } },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: { mode: FunctionCallingConfigMode.ANY },
        },
      },
    });
    expect(result.parameters['reasoning_effort']).toBe('none');
    expect(result.parameters['tool_choice']).toBe('required');
  });
});
