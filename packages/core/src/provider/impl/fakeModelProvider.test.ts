/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FinishReason,
  type GenerateContentResponse,
  type Part,
} from '@google/genai';
import { ENV_FAKE_STREAM_DELAY_MS } from '../../config/brand.js';
import {
  FakeResponseStore,
  type FakeResponse,
} from '../../core/fakeResponseStore.js';
import type { ModelStreamRequest } from '../modelStreamRequest.js';
import type { ModelStreamResponse } from '../modelStreamResponse.js';
import { FakeModelProvider } from './fakeModelProvider.js';

function frame(
  parts: Part[],
  usageMetadata?: GenerateContentResponse['usageMetadata'],
): GenerateContentResponse {
  return {
    candidates: [
      { content: { role: 'model', parts }, finishReason: FinishReason.STOP },
    ],
    ...(usageMetadata ? { usageMetadata } : {}),
  } as GenerateContentResponse;
}

function setup(
  responses: GenerateContentResponse[],
  prefix: FakeResponse[] = [],
) {
  const store = new FakeResponseStore([
    ...prefix,
    { method: 'generateContentStream', response: responses },
  ]);
  const getResponseStore = vi.fn(async () => store);
  const provider = new FakeModelProvider({
    defaultModelKey: 'ultimate',
    getResponseStore,
  });
  const request = async (signal?: AbortSignal): Promise<ModelStreamRequest> => {
    const main = await provider.getModel('ultimate');
    return {
      resolution: await provider.select({ purpose: 'main', mainModel: main }),
      prompt: { messages: [{ role: 'user', content: 'test' }] },
      ...(signal ? { control: { signal } } : {}),
    };
  };
  return { provider, request, store, getResponseStore };
}

async function firstTextDelta(response: ModelStreamResponse) {
  for await (const event of response.events) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    )
      return event;
  }
  throw new Error('No text delta');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('FakeModelProvider', () => {
  it('provides an offline model catalog and follows the main, parent and override selections', async () => {
    const { provider, request, getResponseStore } = setup([]);
    const main = (await request()).resolution.model;
    expect(await provider.listModels()).toEqual([main]);
    const helper = await provider.getModel('helper');
    provider.setModelConfig(main, { sampling: { temperature: 0.1 } });
    expect(
      (await provider.select({ purpose: 'main', mainModel: main })).config
        .sampling?.temperature,
    ).toBe(0.1);
    const parent = {
      model: helper,
      config: { reasoning: { effort: 'high' as const } },
    };
    expect(
      await provider.select({ purpose: 'compact', parentSelection: parent }),
    ).toEqual(parent);
    expect(
      await provider.select({
        purpose: 'task',
        parentSelection: parent,
        overrideSelection: {
          model: helper,
          config: { sampling: { topP: 0.8 } },
        },
      }),
    ).toEqual({
      model: helper,
      config: { reasoning: { effort: 'high' }, sampling: { topP: 0.8 } },
    });
    expect(getResponseStore).not.toHaveBeenCalled();
  });

  it('keeps replay preferences in memory and supports clearing a field', async () => {
    const { provider } = setup([]);
    const model = await provider.getModel('ultimate');
    provider.setModelConfig(model, {
      context: { maxOutputTokens: 128 },
      sampling: { temperature: 0.1 },
    });
    provider.setModelConfig(model, { context: { maxOutputTokens: undefined } });
    expect(provider.getModelConfig(model)).toEqual({
      context: { maxOutputTokens: undefined },
      sampling: { temperature: 0.1 },
    });
  });

  it('preserves legacy last-frame replay including thought text and tool arguments', async () => {
    vi.stubEnv(ENV_FAKE_STREAM_DELAY_MS, undefined);
    const { provider, request } = setup([
      frame([{ text: 'discarded' }]),
      frame(
        [
          { text: 'thought', thought: true },
          { text: 'answer' },
          { functionCall: { name: 'Read', args: { file_path: '文件.txt' } } },
        ],
        { promptTokenCount: 7, candidatesTokenCount: 11 },
      ),
    ]);
    const response = await provider.inference(await request());
    const completed = await response.completed;
    expect(completed).toMatchObject({
      model: 'ultimate',
      stopReason: 'tool_use',
      usage: { inputTokens: 7, outputTokens: 11 },
      blocks: [
        { type: 'text', text: 'thought' },
        { type: 'text', text: 'answer' },
        { type: 'tool_use', name: 'Read', input: { file_path: '文件.txt' } },
      ],
    });
    expect(completed.blocks[2]).toHaveProperty(
      'id',
      expect.stringMatching(/^toolu_/),
    );
    const events = [];
    for await (const event of response.events) events.push(event);
    expect(
      events.filter((event) => event.type === 'content_block_complete'),
    ).toHaveLength(3);
    expect(events.at(-1)?.type).toBe('message_stop');
  });

  it('replays each visible chunk, collects all tools and skips unrelated method fixtures in paced mode', async () => {
    vi.stubEnv(ENV_FAKE_STREAM_DELAY_MS, '0');
    const { provider, request } = setup(
      [
        frame([
          { text: 'hidden', thought: true },
          { text: 'one' },
          { text: ' two' },
          { functionCall: { name: 'Read', args: { file_path: 'a' } } },
        ]),
        frame([
          { text: ' three' },
          { functionCall: { name: 'Write', args: { file_path: 'b' } } },
        ]),
        frame([], { promptTokenCount: 13, candidatesTokenCount: 17 }),
      ],
      [{ method: 'countTokens', response: { totalTokens: 1 } }],
    );
    const response = await provider.inference(await request());
    const deltas = [];
    for await (const event of response.events) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      )
        deltas.push(event.delta.text);
    }
    expect(deltas).toEqual(['one two', ' three']);
    expect(await response.completed).toMatchObject({
      blocks: [
        { type: 'text', text: 'one two three' },
        { type: 'tool_use', name: 'Read' },
        { type: 'tool_use', name: 'Write' },
      ],
      usage: { inputTokens: 13, outputTokens: 17 },
      stopReason: 'tool_use',
    });
  });

  it('paces chunks against deadlines and completes without an events consumer', async () => {
    vi.useFakeTimers();
    vi.stubEnv(ENV_FAKE_STREAM_DELAY_MS, '100');
    const { provider, request } = setup([
      frame([{ text: 'one' }]),
      frame([{ text: 'two' }]),
      frame([{ text: 'three' }]),
    ]);
    const response = await provider.inference(await request());
    const completed = vi.fn();
    void response.completed.then(completed);
    await vi.advanceTimersByTimeAsync(99);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(101);
    expect(await response.completed).toMatchObject({
      blocks: [{ type: 'text', text: 'onetwothree' }],
      stopReason: 'end_turn',
    });
  });

  it.each(['request', 'response', 'provider'] as const)(
    'cancels a paced replay through the %s boundary',
    async (boundary) => {
      vi.useFakeTimers();
      vi.stubEnv(ENV_FAKE_STREAM_DELAY_MS, '1000');
      const controller = new AbortController();
      const { provider, request } = setup([
        frame([{ text: 'first' }]),
        frame([{ text: 'late' }]),
      ]);
      const response = await provider.inference(
        await request(controller.signal),
      );
      const rejected = response.completed.catch((error: unknown) => error);
      await firstTextDelta(response);
      if (boundary === 'request') controller.abort();
      else if (boundary === 'response') {
        expect(response.cancel).toBeTypeOf('function');
        await response.cancel!();
      } else await provider.stop();
      await expect(rejected).resolves.toMatchObject({ name: 'AbortError' });
      const partial = await response.partial;
      expect(partial.blocks).toEqual([]);
      expect(partial.openBlocks.get(0)).toEqual({
        type: 'text',
        text: 'first',
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not consume a fixture for an already cancelled request', async () => {
    const controller = new AbortController();
    const { provider, request, getResponseStore } = setup([
      frame([{ text: 'available' }]),
    ]);
    const input = await request(controller.signal);
    controller.abort();
    await expect(provider.inference(input)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(getResponseStore).not.toHaveBeenCalled();
    expect(
      await (
        await provider.inference(await request())
      ).completed,
    ).toMatchObject({ blocks: [{ text: 'available' }] });
  });

  it('fails explicitly when the replay fixture is exhausted or empty', async () => {
    const exhausted = setup([frame([{ text: 'once' }])]);
    await (
      await exhausted.provider.inference(await exhausted.request())
    ).completed;
    await expect(
      exhausted.provider.inference(await exhausted.request()),
    ).rejects.toThrow('No more mock responses');
    const empty = setup([]);
    await expect(
      empty.provider.inference(await empty.request()),
    ).rejects.toThrow('must not be empty');
  });

  it.each(['', '-1', 'NaN', 'Infinity'])(
    'rejects invalid replay pacing %j',
    async (value) => {
      vi.stubEnv(ENV_FAKE_STREAM_DELAY_MS, value);
      const { provider, request } = setup([frame([{ text: 'text' }])]);
      await expect(provider.inference(await request())).rejects.toThrow(
        `Invalid ${ENV_FAKE_STREAM_DELAY_MS}`,
      );
    },
  );

  it('preserves refusal completion markers from existing replay fixtures', async () => {
    const refusal = frame([{ text: 'refused' }]);
    refusal.candidates![0].finishReason = 'sensitive' as FinishReason;
    const { provider, request } = setup([refusal]);
    expect(
      await (
        await provider.inference(await request())
      ).completed,
    ).toMatchObject({ stopReason: 'refusal' });
  });
});
