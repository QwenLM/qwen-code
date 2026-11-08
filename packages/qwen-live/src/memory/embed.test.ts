/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEMORY_CONFIG } from './config.js';
import {
  EmbeddingBackfiller,
  EmbeddingClient,
  normalizeVector,
  searchVectors,
} from './embed.js';

function response(vectors: number[][]): Response {
  return new Response(
    JSON.stringify({
      data: vectors.map((embedding, index) => ({ index, embedding })),
    }),
    { status: 200 },
  );
}

describe('EmbeddingClient', () => {
  const clients: EmbeddingClient[] = [];
  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
    vi.useRealTimers();
  });
  function create(
    fetcher: typeof fetch,
    config = DEFAULT_MEMORY_CONFIG.retrieve,
  ): EmbeddingClient {
    const client = new EmbeddingClient({
      config,
      connection: { baseUrl: 'https://example.invalid/v1', apiKey: 'test-key' },
      fetch: fetcher,
    });
    clients.push(client);
    return client;
  }

  it('normalizes vectors and caches whitespace-normalized queries with bounded LRU', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response([[3, 4]]));
    const client = create(fetcher, {
      ...DEFAULT_MEMORY_CONFIG.retrieve,
      cacheSize: 1,
    });
    expect((await client.embedQuery(' a  b '))?.[0]).toBeCloseTo(0.6);
    expect((await client.embedQuery('a b'))?.[1]).toBeCloseTo(0.8);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await client.embedQuery('other');
    await client.embedQuery('a b');
    expect(fetcher).toHaveBeenCalledTimes(3);
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(request).toEqual({ model: 'text-embedding-v4', input: ['a b'] });
  });

  it('makes no requests when disabled, blank or missing credentials', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const disabled = create(fetcher, {
      ...DEFAULT_MEMORY_CONFIG.retrieve,
      useVector: false,
    });
    expect(await disabled.embedQuery('query')).toBeNull();
    expect(await disabled.embedDocuments(['text'])).toEqual([null]);
    await disabled.warmUp();
    const missing = new EmbeddingClient({
      connection: { baseUrl: 'https://example.invalid/v1' },
      fetch: fetcher,
    });
    clients.push(missing);
    expect(missing.available).toBe(false);
    expect(await missing.embedQuery('query')).toBeNull();
    expect(await create(fetcher).embedQuery('   ')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('degrades on HTTP errors or malformed vectors instead of throwing', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('private error details', { status: 429 }),
      )
      .mockResolvedValueOnce(response([[0, 0]]))
      .mockResolvedValueOnce(new Response('{bad json'))
      .mockResolvedValueOnce(
        response([
          [1, 0],
          [0, 1],
        ]),
      );
    const client = create(fetcher);
    for (let index = 0; index < 4; index++)
      expect(await client.embedQuery(`q${index}`)).toBeNull();
    expect(normalizeVector([Number.NaN])).toBeNull();
    expect(normalizeVector([Number.POSITIVE_INFINITY])).toBeNull();
  });

  it('applies a hard query deadline even to an unresponsive transport', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise<Response>(() => {}));
    const client = create(fetcher);
    const pending = client.embedQuery('query');
    await vi.advanceTimersByTimeAsync(400);
    expect(await pending).toBeNull();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('gives document backfill the longer budget and reorders results by index', async () => {
    vi.useFakeTimers();
    let resolve: (value: Response) => void = () => {};
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const client = create(fetcher);
    const pending = client.embedDocuments(['first', '', 'second']);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    resolve(
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        }),
      ),
    );
    const vectors = await pending;
    expect(vectors.map((vector) => (vector ? [...vector] : null))).toEqual([
      [1, 0],
      null,
      [0, 1],
    ]);
  });

  it('warmup runs once and close cancels pending work without repopulating the cache', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise<Response>(() => {}));
    const client = create(fetcher);
    const first = client.warmUp();
    const second = client.warmUp();
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.close();
    await Promise.all([first, second]);
    expect(client.available).toBe(false);
    expect(await client.embedQuery('later')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('filters dimension mismatches and weak semantic matches', () => {
    expect(
      searchVectors(
        [
          { refId: 1, vector: new Float32Array([1, 0]) },
          { refId: 2, vector: new Float32Array([0, 1]) },
          { refId: 3, vector: new Float32Array([1]) },
        ],
        new Float32Array([1, 0]),
        0.4,
        50,
      ),
    ).toEqual([{ refId: 1, similarity: 1 }]);
  });

  it('backfills FIFO, deduplicates queued ids and suppresses late writes after close', async () => {
    let release: (value: Response) => void = () => {};
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(response([[1, 0]]));
    const client = create(fetcher);
    const write = vi.fn();
    const worker = new EmbeddingBackfiller(client, write);
    expect(worker.enqueue(1, 'one')).toBe(true);
    expect(worker.enqueue(1, 'duplicate')).toBe(false);
    expect(worker.enqueue(2, 'two')).toBe(true);
    release(response([[1, 0]]));
    expect(await worker.drain()).toBe(true);
    expect(write.mock.calls.map((call) => call[0])).toEqual([1, 2]);
    const delayedFetch = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const delayed = new EmbeddingBackfiller(create(delayedFetch), write);
    delayed.enqueue(3, 'three');
    delayed.close();
    release(response([[1, 0]]));
    await delayed.drain();
    expect(write.mock.calls.map((call) => call[0])).toEqual([1, 2]);
    worker.close();
  });
});
