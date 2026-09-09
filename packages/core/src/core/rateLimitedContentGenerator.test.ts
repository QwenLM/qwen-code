/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  GenerateContentResponse,
  type GenerateContentParameters,
  type CountTokensParameters,
  type CountTokensResponse,
  type EmbedContentParameters,
  type EmbedContentResponse,
} from '@google/genai';
import type { ContentGenerator } from './contentGenerator.js';
import { RateLimitedContentGenerator } from './rateLimitedContentGenerator.js';
import { ConcurrencyLimiter } from '../utils/concurrencyLimiter.js';

const fakeRequest = (id: string): GenerateContentParameters => ({
  model: 'test-model',
  contents: [{ role: 'user', parts: [{ text: id }] }],
});

const fakeResponse = (id: string): GenerateContentResponse => {
  const response = new GenerateContentResponse();
  response.responseId = id;
  return response;
};

const requestId = (request: GenerateContentParameters): string => {
  const contents = Array.isArray(request.contents)
    ? request.contents
    : [request.contents];
  const first = contents[0];
  if (typeof first === 'object' && first !== null && 'parts' in first) {
    const parts = first.parts;
    if (parts && typeof parts[0] === 'object' && 'text' in parts[0]) {
      return parts[0].text ?? '';
    }
  }
  return '';
};

class FakeGenerator implements ContentGenerator {
  inFlight = 0;
  peakInFlight = 0;
  startedIds: string[] = [];
  finishedIds: string[] = [];
  countTokensCalls = 0;
  embedCalls = 0;
  generateImpl?: (
    req: GenerateContentParameters,
  ) => Promise<GenerateContentResponse>;
  streamImpl?: (
    req: GenerateContentParameters,
  ) => AsyncGenerator<GenerateContentResponse>;

  async generateContent(
    request: GenerateContentParameters,
  ): Promise<GenerateContentResponse> {
    const id = requestId(request);
    this.startedIds.push(id);
    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    try {
      if (this.generateImpl) {
        return await this.generateImpl(request);
      }
      // Default: hold the slot until the test resolves it externally.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return fakeResponse(id);
    } finally {
      this.inFlight--;
      this.finishedIds.push(id);
    }
  }

  async generateContentStream(
    request: GenerateContentParameters,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const id = requestId(request);
    this.startedIds.push(id);
    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);

    const baseImpl = this.streamImpl ?? defaultStreamImpl;
    const inner = baseImpl(request);
    const onChunkExit = () => {
      this.inFlight--;
      this.finishedIds.push(id);
    };
    async function* outer(): AsyncGenerator<GenerateContentResponse> {
      try {
        for await (const chunk of inner) {
          yield chunk;
        }
      } finally {
        onChunkExit();
      }
    }
    return outer();
  }

  async countTokens(
    _request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    this.countTokensCalls++;
    return { totalTokens: 1 } as CountTokensResponse;
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    this.embedCalls++;
    return {} as EmbedContentResponse;
  }

  useSummarizedThinking(): boolean {
    return false;
  }
}

async function* defaultStreamImpl(
  request: GenerateContentParameters,
): AsyncGenerator<GenerateContentResponse> {
  const id = requestId(request);
  yield fakeResponse(`${id}-1`);
  yield fakeResponse(`${id}-2`);
}

describe('RateLimitedContentGenerator', () => {
  it('caps generateContent to the configured limit', async () => {
    const inner = new FakeGenerator();
    const limiter = new ConcurrencyLimiter(2);
    const gen = new RateLimitedContentGenerator(inner, limiter);

    const requests = await Promise.all([
      gen.generateContent(fakeRequest('a'), 'p'),
      gen.generateContent(fakeRequest('b'), 'p'),
      gen.generateContent(fakeRequest('c'), 'p'),
      gen.generateContent(fakeRequest('d'), 'p'),
    ]);

    expect(requests).toHaveLength(4);
    expect(inner.peakInFlight).toBeLessThanOrEqual(2);
    expect(inner.startedIds.sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('releases the slot after generateContent rejects', async () => {
    const inner = new FakeGenerator();
    inner.generateImpl = async () => {
      throw new Error('upstream 500');
    };
    const limiter = new ConcurrencyLimiter(1);
    const gen = new RateLimitedContentGenerator(inner, limiter);

    await expect(gen.generateContent(fakeRequest('a'), 'p')).rejects.toThrow(
      'upstream 500',
    );
    expect(limiter.inFlight).toBe(0);

    // The cap is still honored on the next call.
    inner.generateImpl = undefined;
    await gen.generateContent(fakeRequest('b'), 'p');
    expect(limiter.inFlight).toBe(0);
  });

  it('releases the slot only after the stream is fully drained', async () => {
    const inner = new FakeGenerator();
    const limiter = new ConcurrencyLimiter(1);
    const gen = new RateLimitedContentGenerator(inner, limiter);

    const stream1 = await gen.generateContentStream(fakeRequest('a'), 'p');
    expect(limiter.inFlight).toBe(1);

    // A second stream call is parked until the first drains.
    let stream2Resolved = false;
    const stream2Promise = gen
      .generateContentStream(fakeRequest('b'), 'p')
      .then((s) => {
        stream2Resolved = true;
        return s;
      });

    await Promise.resolve();
    expect(stream2Resolved).toBe(false);

    // Drain stream1.
    const collected1: string[] = [];
    for await (const chunk of stream1) {
      collected1.push(chunk.responseId ?? '');
    }
    expect(collected1).toEqual(['a-1', 'a-2']);

    const stream2 = await stream2Promise;
    const collected2: string[] = [];
    for await (const chunk of stream2) {
      collected2.push(chunk.responseId ?? '');
    }
    expect(collected2).toEqual(['b-1', 'b-2']);
    expect(limiter.inFlight).toBe(0);
  });

  it('releases the slot when the stream initialization throws', async () => {
    const inner = new FakeGenerator();
    // ``generateContentStream`` may throw synchronously on bad input or
    // network setup; the wrapper has to handle both that and async rejection
    // identically.
    vi.spyOn(inner, 'generateContentStream').mockImplementation(() => {
      throw new Error('boom');
    });
    const limiter = new ConcurrencyLimiter(1);
    const gen = new RateLimitedContentGenerator(inner, limiter);

    await expect(
      gen.generateContentStream(fakeRequest('a'), 'p'),
    ).rejects.toThrow('boom');
    expect(limiter.inFlight).toBe(0);
  });

  it('releases the slot when stream iteration aborts mid-flight', async () => {
    const inner = new FakeGenerator();
    inner.streamImpl =
      async function* (): AsyncGenerator<GenerateContentResponse> {
        yield fakeResponse('x-1');
        yield fakeResponse('x-2');
        yield fakeResponse('x-3');
      };
    const limiter = new ConcurrencyLimiter(1);
    const gen = new RateLimitedContentGenerator(inner, limiter);

    const stream = await gen.generateContentStream(fakeRequest('x'), 'p');
    let count = 0;
    for await (const _chunk of stream) {
      count++;
      if (count === 1) {
        break; // simulates an early consumer-side abort
      }
    }
    expect(limiter.inFlight).toBe(0);
  });

  it('does not gate countTokens / embedContent', async () => {
    const inner = new FakeGenerator();
    const limiter = new ConcurrencyLimiter(1);
    const gen = new RateLimitedContentGenerator(inner, limiter);

    // Hold the only slot with a generateContent call.
    const hold = gen.generateContent(fakeRequest('a'), 'p');

    // countTokens / embedContent should run immediately.
    const start = Date.now();
    await Promise.all([
      gen.countTokens({} as CountTokensParameters),
      gen.embedContent({} as EmbedContentParameters),
    ]);
    expect(Date.now() - start).toBeLessThan(50);
    expect(inner.countTokensCalls).toBe(1);
    expect(inner.embedCalls).toBe(1);

    await hold;
  });

  it('forwards useSummarizedThinking without blocking', () => {
    const inner = new FakeGenerator();
    const limiter = new ConcurrencyLimiter(1);
    const gen = new RateLimitedContentGenerator(inner, limiter);
    expect(gen.useSummarizedThinking()).toBe(false);

    const spy = vi.spyOn(inner, 'useSummarizedThinking').mockReturnValue(true);
    expect(gen.useSummarizedThinking()).toBe(true);
    expect(spy).toHaveBeenCalled();
  });
});
