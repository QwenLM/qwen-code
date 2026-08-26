/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createRequestEngine, type FetchLike } from './request-engine.js';
import { parseDialect, parseInstanceConfig } from './schemas.js';
import type {
  DialectV1,
  ExternalContextItem,
  InstanceConfigV1,
  RuntimeConfiguration,
} from './types.js';

describe('bounded Mem0 request engine', () => {
  it.each(['synthetic-filtered-post-v1.json', 'synthetic-query-get-v1.json'])(
    'executes the %s contract fixture',
    async (fixtureName) => {
      const fixture = await readFixture(fixtureName);
      let capturedUrl: string | undefined;
      let capturedInit: RequestInit | undefined;
      const fetcher: FetchLike = vi.fn(async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return Response.json(fixture.providerResponse);
      });
      const search = createRequestEngine(runtime(fixture), fetcher);

      const items = await search({
        query: fixture.query,
        signal: AbortSignal.timeout(5000),
      });

      expect(capturedUrl).toBe(fixture.expectedRequest.url);
      expect(capturedInit?.method).toBe(fixture.expectedRequest.method);
      expect(capturedInit?.redirect).toBe('manual');
      expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(capturedInit?.headers);
      if (fixture.expectedRequest.authorization !== undefined) {
        expect(headers.get('authorization')).toBe(
          fixture.expectedRequest.authorization,
        );
      }
      if (fixture.expectedRequest.xApiKey !== undefined) {
        expect(headers.get('x-api-key')).toBe(fixture.expectedRequest.xApiKey);
      }
      if (fixture.expectedRequest.body === undefined) {
        expect(capturedInit?.body).toBeUndefined();
        expect(headers.get('content-type')).toBeNull();
      } else {
        expect(JSON.parse(String(capturedInit?.body))).toEqual(
          fixture.expectedRequest.body,
        );
        expect(headers.get('content-type')).toBe('application/json');
      }
      expect(items).toEqual(fixture.expectedItems);
    },
  );

  it('rejects redirects without following them', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const fetcher: FetchLike = vi.fn(async (_input, init) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, {
        status: 302,
        headers: { location: 'https://credential-sink.example.com' },
      });
    });

    await expect(
      createRequestEngine(
        runtime(fixture),
        fetcher,
      )({
        query: fixture.query,
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow('Provider request failed.');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('caps the response before parsing it', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const fetcher: FetchLike = vi.fn(async () =>
      Response.json(
        { results: [] },
        { headers: { 'content-length': String(1024 * 1024 + 1) } },
      ),
    );

    await expect(
      createRequestEngine(
        runtime(fixture),
        fetcher,
      )({
        query: fixture.query,
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow('Provider response is invalid.');
  });

  it('caps a streamed response without a declared length', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const fetcher: FetchLike = vi.fn(
      async () => new Response(new Uint8Array(1024 * 1024 + 1)),
    );

    await expect(
      createRequestEngine(
        runtime(fixture),
        fetcher,
      )({
        query: fixture.query,
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow('Provider response is invalid.');
  });

  it('rejects a response whose collection does not match the dialect', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const fetcher: FetchLike = vi.fn(async () => Response.json({ items: [] }));

    await expect(
      createRequestEngine(
        runtime(fixture),
        fetcher,
      )({
        query: fixture.query,
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow('Provider response is invalid.');
  });

  it('returns at most five valid items in provider order', async () => {
    const fixture = await readFixture('synthetic-filtered-post-v1.json');
    const results = [
      { id: 'invalid' },
      ...Array.from({ length: 7 }, (_, index) => ({
        id: `memory-${index}`,
        memory: `content-${index}`,
      })),
    ];
    const fetcher: FetchLike = vi.fn(async () => Response.json({ results }));

    const items = await createRequestEngine(
      runtime(fixture),
      fetcher,
    )({
      query: fixture.query,
      signal: AbortSignal.timeout(5000),
    });

    expect(items).toEqual(
      Array.from({ length: 5 }, (_, index) => ({
        id: `memory-${index}`,
        content: `content-${index}`,
      })),
    );
  });
});

interface SyntheticFixture {
  instance: InstanceConfigV1;
  dialect: DialectV1;
  credential: string;
  query: string;
  providerResponse: unknown;
  expectedRequest: {
    url: string;
    method: 'GET' | 'POST';
    authorization?: string;
    xApiKey?: string;
    body?: unknown;
  };
  expectedItems: ExternalContextItem[];
}

function runtime(fixture: SyntheticFixture): RuntimeConfiguration {
  return {
    instance: parseInstanceConfig(fixture.instance),
    dialect: parseDialect(fixture.dialect),
    credential: fixture.credential,
  };
}

async function readFixture(name: string): Promise<SyntheticFixture> {
  return JSON.parse(
    await readFile(
      new URL(`../test/fixtures/${name}`, import.meta.url),
      'utf8',
    ),
  ) as SyntheticFixture;
}
