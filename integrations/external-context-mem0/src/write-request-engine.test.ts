/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line import/no-internal-modules -- package-owned synthetic protocol fixture
import fixture from '../test/fixtures/synthetic-write-v1.json' with { type: 'json' };
import { parseWriteDialect, parseWriteInstanceConfig } from './schemas.js';
import { createWriteRequestEngine } from './write-request-engine.js';
import type { FetchLike } from './request-engine.js';
import type { WriteRuntimeConfiguration } from './types.js';

function runtime(): WriteRuntimeConfiguration {
  return {
    instance: parseWriteInstanceConfig(structuredClone(fixture.instance)),
    dialect: parseWriteDialect(structuredClone(fixture.dialect)),
    credential: 'synthetic-token',
  };
}

const input = () => ({
  content: '  exact\n中文 😀 "quoted"\t ',
  signal: new AbortController().signal,
});

describe('Mem0 explicit write HTTP engine', () => {
  it.each([
    ['authorization-token', 'authorization', 'Token synthetic-token'],
    ['authorization-bearer', 'authorization', 'Bearer synthetic-token'],
    ['x-api-key', 'x-api-key', 'synthetic-token'],
  ] as const)(
    'sends one exact scoped POST using %s',
    async (auth, header, value) => {
      const config = runtime();
      config.dialect.auth = auth;
      config.instance.scope.agentId = 'agent';
      config.instance.scope.appId = 'app';
      config.dialect.create.agentIdLocation = 'json';
      config.dialect.create.appIdLocation = 'json';
      const fetcher = vi
        .fn<FetchLike>()
        .mockResolvedValue(
          Response.json({ results: [{ id: 'memory-1', event: 'ADD' }] }),
        );
      await expect(
        createWriteRequestEngine(config, fetcher)(input()),
      ).resolves.toEqual({ status: 'stored', memoryId: 'memory-1' });
      expect(fetcher).toHaveBeenCalledOnce();
      const [url, init] = fetcher.mock.calls[0]!;
      expect(String(url)).toBe('https://memory.example.com/api/memories');
      expect(init).toMatchObject({
        method: 'POST',
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      });
      expect(new Headers(init?.headers).get(header)).toBe(value);
      expect(JSON.parse(String(init?.body))).toEqual({
        messages: [{ role: 'user', content: input().content }],
        infer: false,
        user_id: 'repository-memory',
        agent_id: 'agent',
        app_id: 'app',
      });
    },
  );

  it.each(['results', 'root-array', 'root-object'] as const)(
    'parses only the selected %s envelope',
    async (collection) => {
      const config = runtime();
      config.dialect.response = {
        completion: 'records',
        collection,
        idField: 'memory_id',
      };
      const record = { memory_id: 'memory:1' };
      const payload =
        collection === 'results'
          ? { results: [record] }
          : collection === 'root-array'
            ? [record]
            : record;
      const fetcher = vi
        .fn<FetchLike>()
        .mockResolvedValue(Response.json(payload));
      expect(await createWriteRequestEngine(config, fetcher)(input())).toEqual({
        status: 'stored',
        memoryId: 'memory:1',
      });
    },
  );

  const invalidResponses: unknown[] = [
    null,
    [],
    [{ id: 'wrong-envelope' }],
    { results: [] },
    { results: [{ id: 'one' }, { id: 'two' }] },
    { results: [{ id: 'one' }, null] },
    { results: [null] },
    { results: [{ id: '' }] },
    { results: [{ id: 'unsafe\nidentifier' }] },
    { results: [{ id: 'x'.repeat(257) }] },
    { results: [{ id: 1 }] },
    { results: [{ id: 'one', event: 'UPDATE' }] },
    { results: [{ id: 'one', event: 'DELETE' }] },
    { results: [{ id: 'one', status: 'FAILED' }] },
    { status: 'FAILED', results: [{ id: 'one' }] },
    { status: 'new-status', results: [{ id: 'one' }] },
    { error: 'sensitive error', results: [{ id: 'one' }] },
    { results: [{ id: 'one', errors: ['sensitive error'] }] },
    { event_id: 'bad/id', results: [{ id: 'one' }] },
    { status: 'PENDING', event_id: 'operation-1' },
  ];
  it.each(invalidResponses.map((payload, index) => ({ payload, index })))(
    'keeps invalid/conflicting response $index unknown without retry',
    async ({ payload }) => {
      const fetcher = vi
        .fn<FetchLike>()
        .mockResolvedValue(Response.json(payload));
      expect(
        await createWriteRequestEngine(runtime(), fetcher)(input()),
      ).toEqual({ status: 'unknown' });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      payload: {
        status: 'PENDING',
        event_id: 'operation-1',
        results: [{ id: 'not-confirmed' }],
      },
      result: { status: 'accepted', providerOperationId: 'operation-1' },
    },
    {
      payload: { status: 'SUCCEEDED', event_id: 'operation-1' },
      result: { status: 'accepted', providerOperationId: 'operation-1' },
    },
    {
      payload: {
        status: 'SUCCEEDED',
        event_id: 'operation-1',
        results: [{ id: 'record-1' }],
      },
      result: { status: 'stored', memoryId: 'record-1' },
    },
    {
      payload: { status: 'SUCCEEDED', event_id: 'operation-1', results: [] },
      result: { status: 'unknown' },
    },
    {
      payload: { status: 'SUCCEEDED', event_id: 'operation-1', results: 'bad' },
      result: { status: 'unknown' },
    },
    { payload: { status: 'PENDING' }, result: { status: 'unknown' } },
    {
      payload: { status: 'FAILED', event_id: 'operation-1' },
      result: { status: 'unknown' },
    },
  ])(
    'distinguishes record and operation acknowledgements: $payload',
    async ({ payload, result }) => {
      const config = runtime();
      config.dialect.response.completion = 'records-or-event';
      const fetcher = vi
        .fn<FetchLike>()
        .mockResolvedValue(Response.json(payload));
      expect(await createWriteRequestEngine(config, fetcher)(input())).toEqual(
        result,
      );
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each([301, 302, 400, 401, 403, 404, 429, 500])(
    'does not infer no side effect from HTTP %s',
    async (status) => {
      const fetcher = vi.fn<FetchLike>().mockResolvedValue(
        new Response('private upstream message', {
          status,
          headers: { location: 'https://other.example.com' },
        }),
      );
      expect(
        await createWriteRequestEngine(runtime(), fetcher)(input()),
      ).toEqual({ status: 'unknown' });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each(['', ' \n\t', '\u0000\u202e', '\ud800', 'x\udc00', 'x'.repeat(4001)])(
    'rejects invalid content before fetch',
    async (content) => {
      const fetcher = vi.fn<FetchLike>();
      expect(
        await createWriteRequestEngine(
          runtime(),
          fetcher,
        )({ ...input(), content }),
      ).toEqual({ status: 'failed' });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('preserves 4000 astral code points', async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ results: [{ id: 'one' }] }));
    const content = '😀'.repeat(4000);
    expect(
      await createWriteRequestEngine(
        runtime(),
        fetcher,
      )({ ...input(), content }),
    ).toMatchObject({ status: 'stored' });
    expect(
      JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).messages[0].content,
    ).toBe(content);
  });

  it('distinguishes cancellation before submission from failure after submission', async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockRejectedValue(new Error('private connection failure'));
    const remember = createWriteRequestEngine(runtime(), fetcher);
    expect(await remember({ ...input(), signal: AbortSignal.abort() })).toEqual(
      { status: 'failed' },
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(await remember(input())).toEqual({ status: 'unknown' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('keeps request construction errors local', async () => {
    const config = runtime();
    config.credential = 'invalid\nheader';
    const fetcher = vi.fn<FetchLike>();
    expect(await createWriteRequestEngine(config, fetcher)(input())).toEqual({
      status: 'failed',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    () => new Response(null, { status: 204 }),
    () => new Response('{bad-json'),
    () => new Response(new Uint8Array([0x22, 0xff, 0x22])),
    () => new Response('x'.repeat(1024 * 1024 + 1)),
    () =>
      new Response('{}', {
        headers: { 'content-length': String(1024 * 1024 + 1) },
      }),
  ])('keeps unreadable or oversized responses unknown', async (response) => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(response());
    expect(await createWriteRequestEngine(runtime(), fetcher)(input())).toEqual(
      { status: 'unknown' },
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
