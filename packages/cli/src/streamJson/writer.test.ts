/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Config,
  ToolCallRequestInfo,
} from '@qwen-code/qwen-code-core';
import { StreamJsonWriter } from './writer.js';

function createConfig(): Config {
  return {
    getSessionId: () => 'session-test',
    getModel: () => 'model-test',
  } as unknown as Config;
}

function parseEnvelopes(writes: string[]): unknown[] {
  return writes
    .join('')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

describe('StreamJsonWriter', () => {
  let writes: string[];

  beforeEach(() => {
    writes = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(
      (chunk: string | Uint8Array) => {
        if (typeof chunk === 'string') {
          writes.push(chunk);
        } else {
          writes.push(Buffer.from(chunk).toString('utf8'));
        }
        return true;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits result envelopes with usage and cost details', () => {
    const writer = new StreamJsonWriter(createConfig(), false);
    writer.emitResult({
      isError: false,
      numTurns: 2,
      durationMs: 1200,
      apiDurationMs: 800,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        cache_read_input_tokens: 2,
      },
      totalCostUsd: 0.123,
      summary: 'Completed',
      subtype: 'session_summary',
    });

    const [envelope] = parseEnvelopes(writes) as Array<Record<string, unknown>>;
    expect(envelope).toMatchObject({
      type: 'result',
      duration_ms: 1200,
      duration_api_ms: 800,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        cache_read_input_tokens: 2,
      },
      total_cost_usd: 0.123,
      summary: 'Completed',
      subtype: 'session_summary',
      is_error: false,
    });
  });

  it('emits thinking deltas and assistant messages for thought blocks', () => {
    const writer = new StreamJsonWriter(createConfig(), true);
    const builder = writer.createAssistantBuilder();
    builder.appendThinking('Reflecting');
    builder.appendThinking(' more');
    builder.finalize();

    const envelopes = parseEnvelopes(writes) as Array<Record<string, unknown>>;

    expect(
      envelopes.some(
        (env) =>
          env.type === 'stream_event' &&
          env.event?.type === 'content_block_delta' &&
          env.event?.delta?.type === 'thinking_delta',
      ),
    ).toBe(true);

    const assistantEnvelope = envelopes.find((env) => env.type === 'assistant');
    expect(assistantEnvelope?.message?.content?.[0]).toEqual({
      type: 'thinking',
      thinking: 'Reflecting more',
    });
  });

  it('emits input_json_delta events when tool calls are appended', () => {
    const writer = new StreamJsonWriter(createConfig(), true);
    const builder = writer.createAssistantBuilder();
    const request: ToolCallRequestInfo = {
      callId: 'tool-123',
      name: 'write_file',
      args: { path: 'foo.ts', content: 'console.log(1);' },
      isClientInitiated: false,
      prompt_id: 'prompt-1',
    };

    builder.appendToolUse(request);
    builder.finalize();

    const envelopes = parseEnvelopes(writes) as Array<Record<string, unknown>>;

    expect(
      envelopes.some(
        (env) =>
          env.type === 'stream_event' &&
          env.event?.type === 'content_block_delta' &&
          env.event?.delta?.type === 'input_json_delta',
      ),
    ).toBe(true);
  });

  it('includes session id in system messages', () => {
    const writer = new StreamJsonWriter(createConfig(), false);
    writer.emitSystemMessage('init', { foo: 'bar' });

    const [envelope] = parseEnvelopes(writes) as Array<Record<string, unknown>>;
    expect(envelope).toMatchObject({
      type: 'system',
      subtype: 'init',
      session_id: 'session-test',
      data: { foo: 'bar' },
    });
  });
});
