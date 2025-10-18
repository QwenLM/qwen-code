/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { FatalInputError } from '@qwen-code/qwen-code-core';
import {
  parseStreamJsonInputFromIterable,
  type ParsedStreamJsonInput,
} from './input.js';

function createAsyncIterable(lines: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const line of lines) {
        yield line;
      }
    },
  };
}

describe('parseStreamJsonInputFromIterable', () => {
  it('parses user messages from stream-json lines', async () => {
    const lines = createAsyncIterable([
      JSON.stringify({
        type: 'user',
        message: {
          content: 'Hello world',
        },
      }),
    ]);

    const result = await parseStreamJsonInputFromIterable(lines);

    expect(result).toEqual<ParsedStreamJsonInput>({ prompt: 'Hello world' });
  });

  it('emits success control_response for initialize request', async () => {
    const emitted: unknown[] = [];
    const lines = createAsyncIterable([
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-1',
        request: { subtype: 'initialize' },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: 'Start' },
      }),
    ]);

    const result = await parseStreamJsonInputFromIterable(lines, (envelope) => {
      emitted.push(envelope);
    });

    expect(result.prompt).toBe('Start');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'control_response',
      request_id: 'req-1',
      success: true,
    });
  });

  it('throws when no user message is provided', async () => {
    const lines = createAsyncIterable([
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-2',
        request: { subtype: 'initialize' },
      }),
    ]);

    await expect(
      parseStreamJsonInputFromIterable(lines),
    ).rejects.toBeInstanceOf(FatalInputError);
  });
});
