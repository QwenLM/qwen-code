/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import {
  extractAnthropicContent,
  extractGeminiContent,
  extractOpenAiContent,
  GenAiOutputAccumulator,
  stringifyGenAiJson,
} from './gen-ai-content.js';

function fixture(name: string): object {
  return JSON.parse(
    readFileSync(
      new URL(`./test-fixtures/gen-ai/${name}`, import.meta.url),
      'utf8',
    ),
  ) as object;
}

describe('GenAI content conversion', () => {
  it('converts final OpenAI messages and tool definitions', () => {
    const content = extractOpenAiContent({
      messages: [
        { role: 'system', content: 'be helpful' },
        { role: 'user', content: [{ type: 'text', text: 'read a' }] },
        {
          role: 'assistant',
          content: 'calling',
          reasoning_content: 'reasoning',
          refusal: 'refused detail',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'read', arguments: '{"path":"a"}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call-1',
          content: '{"output":"ok"}',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
            },
          },
        },
      ],
    });

    expect(content.inputMessages).toEqual([
      {
        role: 'system',
        parts: [{ type: 'text', content: 'be helpful' }],
      },
      {
        role: 'user',
        parts: [{ type: 'text', content: 'read a' }],
      },
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', content: 'reasoning' },
          { type: 'text', content: 'calling' },
          { type: 'refusal', content: 'refused detail' },
          {
            type: 'tool_call',
            id: 'call-1',
            name: 'read',
            arguments: { path: 'a' },
          },
        ],
      },
      {
        role: 'tool',
        parts: [
          {
            type: 'tool_call_response',
            id: 'call-1',
            response: '{"output":"ok"}',
          },
        ],
      },
    ]);
    expect(content.systemInstructions).toBeUndefined();
    expect(content.toolDefinitions).toEqual([
      {
        type: 'function',
        name: 'read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      },
    ]);
  });

  it('converts Anthropic system blocks, messages, and tools', () => {
    const content = extractAnthropicContent({
      system: [{ type: 'text', text: 'be helpful' }],
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'reason' },
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'read',
              input: { path: 'a' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-1',
              content: [{ type: 'text', text: 'ok' }],
            },
            { type: 'text', text: 'continue' },
          ],
        },
      ],
      tools: [
        {
          name: 'read',
          description: 'Read',
          input_schema: { type: 'object' },
        },
      ],
    });

    expect(content.systemInstructions).toEqual([
      { type: 'text', content: 'be helpful' },
    ]);
    expect(content.inputMessages?.[1]).toEqual({
      role: 'assistant',
      parts: [
        { type: 'reasoning', content: 'reason' },
        {
          type: 'tool_call',
          id: 'call-1',
          name: 'read',
          arguments: { path: 'a' },
        },
      ],
    });
    expect(content.inputMessages?.slice(2)).toEqual([
      {
        role: 'tool',
        parts: [
          {
            type: 'tool_call_response',
            id: 'call-1',
            response: [{ type: 'text', text: 'ok' }],
          },
        ],
      },
      {
        role: 'user',
        parts: [{ type: 'text', content: 'continue' }],
      },
    ]);
    expect(content.toolDefinitions).toEqual([
      {
        type: 'function',
        name: 'read',
        description: 'Read',
        parameters: { type: 'object' },
      },
    ]);
  });

  it('converts OpenAI-compatible media from the final adapter request', () => {
    const content = extractOpenAiContent({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              file: {
                filename: 'document.pdf',
                file_data: 'DATA:application/pdf;base64,cGRm',
              },
            },
            {
              type: 'file',
              file: {
                filename: 'remote.pdf',
                file_data: 'https://example.com/document.pdf',
              },
            },
            {
              type: 'input_audio',
              input_audio: {
                data: 'data:audio/wav;base64,YXVkaW8=',
                format: 'wav',
              },
            },
          ],
        },
      ],
    });

    expect(content.inputMessages).toEqual([
      {
        role: 'user',
        parts: [
          {
            type: 'blob',
            mime_type: 'application/pdf',
            modality: 'document',
            content: 'cGRm',
          },
          {
            type: 'uri',
            mime_type: null,
            modality: 'document',
            uri: 'https://example.com/document.pdf',
          },
          {
            type: 'blob',
            mime_type: 'audio/wav',
            modality: 'audio',
            content: 'YXVkaW8=',
          },
        ],
      },
    ]);
  });

  it('converts Gemini media and lowercases JSON Schema types', () => {
    const content = extractGeminiContent({
      contents: [
        {
          role: 'model',
          parts: [
            { text: 'answer' },
            {
              inlineData: {
                mimeType: 'image/png',
                data: 'YWJj',
              },
            },
          ],
        },
      ],
      config: {
        systemInstruction: { parts: [{ text: 'system' }] },
        tools: [
          {
            functionDeclarations: [
              {
                name: 'read',
                parametersJsonSchema: {
                  type: 'object',
                  properties: { path: { type: 'STRING' } },
                  examples: [{ type: 'filesystem-path' }],
                },
              },
            ],
          },
        ],
      },
    });

    expect(content.inputMessages).toEqual([
      {
        role: 'assistant',
        parts: [
          { type: 'text', content: 'answer' },
          {
            type: 'blob',
            mime_type: 'image/png',
            modality: 'image',
            content: 'YWJj',
          },
        ],
      },
    ]);
    expect(content.systemInstructions).toEqual([
      { type: 'text', content: 'system' },
    ]);
    expect(content.toolDefinitions).toEqual([
      {
        type: 'function',
        name: 'read',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          examples: [{ type: 'filesystem-path' }],
        },
      },
    ]);
  });

  it('omits only invalid optional parameters but rejects missing identity', () => {
    expect(
      extractGeminiContent({
        config: {
          tools: [
            {
              functionDeclarations: [
                { name: 'read', parameters: { type: 'NOT_A_SCHEMA_TYPE' } },
                {
                  name: 'write',
                  parametersJsonSchema: {
                    type: 'object',
                    required: 'path',
                  },
                },
                {
                  name: 'list',
                  parametersJsonSchema: { allOf: [] },
                },
                {
                  name: 'search',
                  parametersJsonSchema: {
                    type: 'object',
                    properties: {
                      query: { type: 'string', pattern: '[' },
                    },
                  },
                },
              ],
            },
          ],
        },
      }).toolDefinitions,
    ).toEqual([
      { type: 'function', name: 'read' },
      { type: 'function', name: 'write' },
      { type: 'function', name: 'list' },
      { type: 'function', name: 'search' },
    ]);

    expect(
      extractOpenAiContent({
        tools: [
          { type: 'function', function: { description: 'missing name' } },
        ],
      }).toolDefinitions,
    ).toBeUndefined();
  });

  it('preserves boolean Draft-07 tool parameter schemas', () => {
    expect(
      extractGeminiContent({
        config: {
          tools: [
            {
              functionDeclarations: [
                { name: 'allowed', parametersJsonSchema: true },
                { name: 'impossible', parametersJsonSchema: false },
              ],
            },
          ],
        },
      }).toolDefinitions,
    ).toEqual([
      { type: 'function', name: 'allowed', parameters: true },
      { type: 'function', name: 'impossible', parameters: false },
    ]);
  });

  it('rejects incomplete message snapshots and preserves generic parts', () => {
    expect(
      extractOpenAiContent({
        messages: [
          { role: 'user', content: 'ok' },
          { content: 'missing role' },
        ],
      }).inputMessages,
    ).toBeUndefined();
    expect(
      extractOpenAiContent({
        messages: [
          {
            role: 'user',
            content: [{ type: 'provider_extension', value: 1 }],
          },
        ],
      }).inputMessages,
    ).toEqual([
      {
        role: 'user',
        parts: [{ type: 'provider_extension', value: 1 }],
      },
    ]);
    expect(
      extractOpenAiContent({
        messages: [{ role: 'assistant', content: null }],
      }).inputMessages,
    ).toEqual([{ role: 'assistant', parts: [] }]);
    expect(
      extractOpenAiContent({
        messages: [{ role: 'user', content: [null] }],
      }).inputMessages,
    ).toBeUndefined();
  });

  it('preserves redacted Anthropic thinking as a generic part', () => {
    expect(
      extractAnthropicContent({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'redacted_thinking', data: 'ciphertext' }],
          },
        ],
      }).inputMessages,
    ).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'redacted_thinking', data: 'ciphertext' }],
      },
    ]);
  });
});

describe('GenAI JSON writer', () => {
  it('preserves empty arrays and objects at the exact limit', () => {
    expect(stringifyGenAiJson([], 2)).toBe('[]');
    expect(stringifyGenAiJson({}, 2, true)).toBe('{}');
  });

  it('omits oversized, invalid-root, and cyclic values', () => {
    expect(stringifyGenAiJson({ value: 1 }, 3)).toBeUndefined();
    expect(stringifyGenAiJson([], 100, true)).toBeUndefined();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(stringifyGenAiJson(cyclic, 100)).toBeUndefined();
  });

  it('preserves JSON keys that overlap object prototype accessors', () => {
    const value = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"value"}',
    ) as unknown;

    expect(stringifyGenAiJson(value, 1_000)).toBe(
      '{"__proto__":{"polluted":true},"constructor":"value"}',
    );
    expect(
      (Object.prototype as unknown as Record<string, unknown>)['polluted'],
    ).toBeUndefined();
  });

  it('uses nested toJSON values instead of fabricating empty objects', () => {
    expect(
      stringifyGenAiJson(
        {
          timestamp: new Date('2026-07-24T00:00:00.000Z'),
          custom: { toJSON: () => ({ value: 1 }) },
        },
        1_000,
      ),
    ).toBe('{"timestamp":"2026-07-24T00:00:00.000Z","custom":{"value":1}}');
  });
});

describe('GenAI output accumulation', () => {
  it('collects all non-streaming OpenAI choices in index order', () => {
    const output = new GenAiOutputAccumulator(true, 10_000);
    output.recordOpenAiResponse({
      choices: [
        {
          index: 1,
          message: { role: 'assistant', content: 'B' },
          finish_reason: 'length',
        },
        {
          index: 0,
          message: { role: 'assistant', content: 'A' },
          finish_reason: 'stop',
        },
      ],
    });

    expect(JSON.parse(output.finalize(true)!)).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'A' }],
        finish_reason: 'stop',
      },
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'B' }],
        finish_reason: 'length',
      },
    ]);
  });

  it('collects all OpenAI choices in index order', () => {
    const output = new GenAiOutputAccumulator(true, 10_000);
    output.recordOpenAiChunk({
      choices: [
        { index: 1, delta: { content: 'B' }, finish_reason: null },
        {
          index: 0,
          delta: { reasoning_content: 'R', content: 'A' },
          finish_reason: null,
        },
      ],
    });
    output.recordOpenAiChunk({
      choices: [
        { index: 1, delta: {}, finish_reason: 'length' },
        { index: 0, delta: {}, finish_reason: 'stop' },
      ],
    });

    expect(output.finishReasons).toEqual(['stop', 'length']);
    expect(JSON.parse(output.finalize(true)!)).toEqual([
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', content: 'R' },
          { type: 'text', content: 'A' },
        ],
        finish_reason: 'stop',
      },
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'B' }],
        finish_reason: 'length',
      },
    ]);
  });

  it('merges fragmented tool-call arguments', () => {
    const output = new GenAiOutputAccumulator(true, 10_000);
    output.recordOpenAiChunk({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-1',
                function: { name: 'read', arguments: '{"path":' },
              },
            ],
          },
        },
      ],
    });
    output.recordOpenAiChunk({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"a"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    expect(JSON.parse(output.finalize(true)!)[0].parts).toEqual([
      {
        type: 'tool_call',
        id: 'call-1',
        name: 'read',
        arguments: { path: 'a' },
      },
    ]);
  });

  it('does not invent missing tool-call arguments', () => {
    const output = new GenAiOutputAccumulator(true, 10_000);
    output.recordOpenAiResponse({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'read' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });

    expect(JSON.parse(output.finalize(true)!)[0].parts).toEqual([
      {
        type: 'tool_call',
        id: 'call-1',
        name: 'read',
      },
    ]);
  });

  it('merges Anthropic content blocks by block index', () => {
    const output = new GenAiOutputAccumulator(true, 10_000);
    output.recordAnthropicEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: 'rea' },
    });
    output.recordAnthropicEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'son' },
    });
    output.recordAnthropicEvent({
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'call-1',
        name: 'read',
        input: {},
      },
    });
    output.recordAnthropicEvent({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' },
    });
    output.recordAnthropicEvent({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
    });

    expect(JSON.parse(output.finalize(true)!)).toEqual([
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', content: 'reason' },
          {
            type: 'tool_call',
            id: 'call-1',
            name: 'read',
            arguments: { path: 'a' },
          },
        ],
        finish_reason: 'tool_use',
      },
    ]);
  });

  it('preserves an empty Anthropic tool input when no deltas follow', () => {
    const output = new GenAiOutputAccumulator(true, 10_000);
    output.recordAnthropicEvent({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'call-1',
        name: 'read',
        input: {},
      },
    });
    output.recordAnthropicEvent({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
    });

    expect(JSON.parse(output.finalize(true)!)[0].parts).toEqual([
      {
        type: 'tool_call',
        id: 'call-1',
        name: 'read',
        arguments: {},
      },
    ]);
  });

  it('does not invent an output candidate for Anthropic keepalive events', () => {
    const output = new GenAiOutputAccumulator(true, 10_000);
    output.recordAnthropicEvent({ type: 'ping' });
    expect(output.finalize(false)).toBeUndefined();
    expect(output.finishReasons).toBeUndefined();
  });

  it('uses error for unfinished candidates only on failure', () => {
    const failed = new GenAiOutputAccumulator(true, 10_000);
    failed.recordGeminiResponse({
      candidates: [
        { index: 0, content: { role: 'model', parts: [{ text: 'a' }] } },
      ],
    });
    expect(JSON.parse(failed.finalize(false)!)[0].finish_reason).toBe('error');
    expect(failed.finishReasons).toEqual(['error']);

    const successful = new GenAiOutputAccumulator(true, 10_000);
    successful.recordGeminiResponse({
      candidates: [
        { index: 0, content: { role: 'model', parts: [{ text: 'a' }] } },
      ],
    });
    expect(successful.finalize(true)).toBeUndefined();
  });

  it('tracks non-streaming candidate failures when content capture is off', () => {
    const responses: Array<
      [GenAiOutputAccumulator, (accumulator: GenAiOutputAccumulator) => void]
    > = [
      [
        new GenAiOutputAccumulator(false, 10_000),
        (accumulator) =>
          accumulator.recordOpenAiResponse({
            choices: [
              { index: 0, message: { role: 'assistant', content: '' } },
            ],
          }),
      ],
      [
        new GenAiOutputAccumulator(false, 10_000),
        (accumulator) => accumulator.recordAnthropicResponse({ content: [] }),
      ],
      [
        new GenAiOutputAccumulator(false, 10_000),
        (accumulator) =>
          accumulator.recordGeminiResponse({
            candidates: [{ index: 0, content: { role: 'model', parts: [] } }],
          }),
      ],
    ];

    for (const [accumulator, recordResponse] of responses) {
      recordResponse(accumulator);
      expect(accumulator.finalize(false)).toBeUndefined();
      expect(accumulator.finishReasons).toEqual(['error']);
    }
  });

  it('accumulates Gemini text chunks without replacing earlier content', () => {
    const output = new GenAiOutputAccumulator(true, 10_000);
    output.recordGeminiChunk({
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ text: 'think', thought: true }],
          },
        },
      ],
    });
    output.recordGeminiChunk({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: 'hel' }] },
        },
      ],
    });
    output.recordGeminiChunk({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: 'lo' }] },
          finishReason: 'STOP',
        },
      ],
    });

    expect(JSON.parse(output.finalize(true)!)).toEqual([
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', content: 'think' },
          { type: 'text', content: 'hello' },
        ],
        finish_reason: 'STOP',
      },
    ]);
  });

  it('preserves explicit zero candidates and drops overflowed content', () => {
    const empty = new GenAiOutputAccumulator(true, 10);
    empty.recordOpenAiResponse({ choices: [] });
    expect(empty.finalize(true)).toBe('[]');

    const tooSmallForEmpty = new GenAiOutputAccumulator(true, 1);
    tooSmallForEmpty.recordOpenAiResponse({ choices: [] });
    expect(tooSmallForEmpty.finalize(true)).toBeUndefined();

    const overflow = new GenAiOutputAccumulator(true, 20);
    overflow.recordOpenAiChunk({
      choices: [
        {
          index: 0,
          delta: { content: 'too much content' },
          finish_reason: 'stop',
        },
      ],
    });
    expect(overflow.finishReasons).toEqual(['stop']);
    expect(overflow.finalize(true)).toBeUndefined();
  });

  it('omits an incomplete full snapshot instead of dropping invalid choices', () => {
    const output = new GenAiOutputAccumulator(true, 10_000);
    output.recordOpenAiResponse({
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'valid' },
          finish_reason: 'stop',
        },
        null,
      ],
    });
    expect(output.finalize(true)).toBeUndefined();

    const missing = new GenAiOutputAccumulator(true, 10_000);
    missing.recordGeminiResponse({});
    expect(missing.finalize(false)).toBeUndefined();
  });

  it('budgets many small fragments by final content rather than chunk count', () => {
    const expected = new GenAiOutputAccumulator(true, 10_000);
    for (let index = 0; index < 100; index++) {
      expected.recordOpenAiChunk({
        choices: [{ index: 0, delta: { content: 'a' } }],
      });
    }
    expected.recordOpenAiChunk({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    const serialized = expected.finalize(true)!;

    const exact = new GenAiOutputAccumulator(true, serialized.length);
    const oversized = new GenAiOutputAccumulator(true, serialized.length - 1);
    for (let index = 0; index < 100; index++) {
      const chunk = { choices: [{ index: 0, delta: { content: 'a' } }] };
      exact.recordOpenAiChunk(chunk);
      oversized.recordOpenAiChunk(chunk);
    }
    const finish = {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
    exact.recordOpenAiChunk(finish);
    oversized.recordOpenAiChunk(finish);

    expect(exact.finalize(true)).toBe(serialized);
    expect(oversized.finalize(true)).toBeUndefined();
  });

  it('does not reject an exact-limit response with many small parts', () => {
    const chunk = {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: Array.from({ length: 20 }, () => ({ text: '' })),
          },
          finishReason: 'STOP',
        },
      ],
    };
    const expected = new GenAiOutputAccumulator(true, 10_000);
    expected.recordGeminiChunk(chunk);
    const serialized = expected.finalize(true)!;

    const exact = new GenAiOutputAccumulator(true, serialized.length);
    exact.recordGeminiChunk(chunk);
    expect(exact.finalize(true)).toBe(serialized);
  });
});

describe('pinned OpenTelemetry JSON Schemas', () => {
  it('accepts the canonical values emitted by the converters', () => {
    const ajv = new Ajv({ strict: false });
    const input = extractOpenAiContent({
      messages: [{ role: 'user', content: 'hello' }],
    }).inputMessages;
    const system = extractAnthropicContent({
      system: 'system',
    }).systemInstructions;
    const tools = extractOpenAiContent({
      tools: [
        {
          type: 'function',
          function: {
            name: 'read',
            parameters: { type: 'object' },
          },
        },
      ],
    }).toolDefinitions;
    const accumulator = new GenAiOutputAccumulator(true, 10_000);
    accumulator.recordOpenAiResponse({
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'answer' },
          finish_reason: 'stop',
        },
      ],
    });
    const output = JSON.parse(accumulator.finalize(true)!);

    const cases: Array<[string, unknown]> = [
      ['gen-ai-input-messages.json', input],
      ['gen-ai-output-messages.json', output],
      ['gen-ai-system-instructions.json', system],
      ['gen-ai-tool-definitions.json', tools],
      ['gen-ai-tool-call-arguments.json', { path: 'a' }],
      ['gen-ai-tool-call-result.json', { output: 'ok' }],
    ];
    for (const [name, value] of cases) {
      const validate = ajv.compile(fixture(name));
      const valid = validate(value);
      if (!valid) {
        throw new Error(`${name}: ${JSON.stringify(validate.errors)}`);
      }
      expect(valid).toBe(true);
    }
  });
});
