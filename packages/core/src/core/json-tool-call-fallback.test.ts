/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { tryRecoverJsonToolCalls } from './json-tool-call-fallback.js';

const knownTool = (name: string) => ['agent', 'read_file'].includes(name);

describe('tryRecoverJsonToolCalls', () => {
  it('recovers an array of JSON tool calls from plain text', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123);

    const result = tryRecoverJsonToolCalls(
      JSON.stringify([
        {
          name: 'agent',
          prompt: 'inspect the repo',
          subagent_type: 'general-purpose',
          run_in_background: true,
        },
        { name: 'read_file', file_path: 'src/index.ts' },
      ]),
      knownTool,
    );

    expect(result).toEqual({
      recovered: true,
      functionCallParts: [
        {
          functionCall: {
            id: 'json-recovered-0-123',
            name: 'agent',
            args: {
              prompt: 'inspect the repo',
              subagent_type: 'general-purpose',
              run_in_background: true,
            },
          },
        },
        {
          functionCall: {
            id: 'json-recovered-1-123',
            name: 'read_file',
            args: { file_path: 'src/index.ts' },
          },
        },
      ],
    });
  });

  it('recovers a single object with nested args', () => {
    const result = tryRecoverJsonToolCalls(
      JSON.stringify({
        name: 'read_file',
        args: { file_path: 'src/index.ts' },
      }),
      knownTool,
    );

    expect(result.recovered).toBe(true);
    expect(result.functionCallParts[0]?.functionCall?.name).toBe('read_file');
    expect(result.functionCallParts[0]?.functionCall?.args).toEqual({
      file_path: 'src/index.ts',
    });
  });

  it('rejects unknown tool names', () => {
    expect(
      tryRecoverJsonToolCalls(
        JSON.stringify({ name: 'not_registered', prompt: 'x' }),
        knownTool,
      ),
    ).toEqual({ recovered: false, functionCallParts: [] });
  });

  it('rejects ordinary JSON data that is not shaped like a tool call', () => {
    expect(
      tryRecoverJsonToolCalls(
        JSON.stringify([{ name: 'read_file', title: 'example' }]),
        knownTool,
      ),
    ).toEqual({ recovered: false, functionCallParts: [] });
  });

  it('is safe against __proto__ argument pollution', () => {
    const result = tryRecoverJsonToolCalls(
      '{"name":"read_file","file_path":"a.ts","__proto__":{"polluted":true}}',
      knownTool,
    );

    expect(result.recovered).toBe(true);
    const args = result.functionCallParts[0]?.functionCall?.args as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(args)).toBeNull();
    expect(args['file_path']).toBe('a.ts');
    expect((args as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
