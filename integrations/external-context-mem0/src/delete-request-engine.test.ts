/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line import/no-internal-modules -- package-owned synthetic protocol fixture
import fixture from '../test/fixtures/synthetic-delete-v1.json' with { type: 'json' };
import { parseDeleteDialect, parseDeleteInstanceConfig } from './schemas.js';
import { createDeleteRequestEngine } from './delete-request-engine.js';
import type { FetchLike } from './request-engine.js';
import type { DeleteRuntimeConfiguration } from './types.js';

function runtime(): DeleteRuntimeConfiguration {
  return {
    instance: parseDeleteInstanceConfig(structuredClone(fixture.instance)),
    dialect: parseDeleteDialect(structuredClone(fixture.dialect)),
    credential: 'synthetic-token',
  };
}
const content = '  exact\n中文 😀 "quoted"\t\u202e ';
const input = () => ({
  memoryId: 'memory:1',
  expectedContent: content,
  signal: new AbortController().signal,
});
const record = () => ({
  id: 'memory:1',
  memory: content,
  user_id: 'repository-memory',
});
const ack = () => Response.json({ message: 'Memory deleted successfully!' });
const absent = () => new Response(null, { status: 404 });
const calls = (fetcher: ReturnType<typeof vi.fn<FetchLike>>) =>
  fetcher.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: init?.method,
  }));

describe('Mem0 single-record deletion HTTP engine', () => {
  it.each([
    ['authorization-token', 'authorization', 'Token synthetic-token'],
    ['authorization-bearer', 'authorization', 'Bearer synthetic-token'],
    ['x-api-key', 'x-api-key', 'synthetic-token'],
  ] as const)(
    'sends exactly GET DELETE GET using %s',
    async (auth, header, value) => {
      const config = runtime();
      config.dialect.auth = auth;
      config.instance.scope.agentId = 'agent';
      config.instance.scope.appId = 'app';
      const fetcher = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(
          Response.json({ ...record(), agent_id: 'agent', app_id: 'app' }),
        )
        .mockResolvedValueOnce(ack())
        .mockResolvedValueOnce(absent());
      expect(
        await createDeleteRequestEngine(config, fetcher).forget(input()),
      ).toEqual({ status: 'deleted', memoryId: input().memoryId });
      expect(calls(fetcher)).toEqual(
        ['GET', 'DELETE', 'GET'].map((method) => ({
          method,
          url: 'https://memory.example.com/api/memories/memory%3A1',
        })),
      );
      const signal = fetcher.mock.calls[0]?.[1]?.signal;
      for (const [, init] of fetcher.mock.calls) {
        expect(init?.body).toBeUndefined();
        expect(init?.redirect).toBe('manual');
        expect(init?.signal).toBe(signal);
        expect(new Headers(init?.headers).get(header)).toBe(value);
      }
    },
  );

  it.each(['', '\n\t', '\u0000\u202e', '😀'.repeat(4000)])(
    'preserves an entire valid target, including blank records',
    async (memory) => {
      const fetcher = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(Response.json({ ...record(), memory }))
        .mockResolvedValueOnce(Response.json({ ...record(), memory }))
        .mockResolvedValueOnce(ack())
        .mockResolvedValueOnce(absent());
      const engine = createDeleteRequestEngine(runtime(), fetcher);
      expect(await engine.get(input())).toEqual({
        status: 'found',
        memoryId: input().memoryId,
        content: memory,
      });
      expect(
        await engine.forget({ ...input(), expectedContent: memory }),
      ).toMatchObject({ status: 'deleted' });
    },
  );

  it.each([
    '',
    '.',
    '..',
    'x'.repeat(257),
    'é',
    '%2e',
    'a/b',
    'a\\b',
    'a?',
    'a#',
    'a\n',
    'a\r',
    'a\u0000',
  ])('rejects unsafe ID %j before any request', async (memoryId) => {
    const fetcher = vi.fn<FetchLike>();
    const engine = createDeleteRequestEngine(runtime(), fetcher);
    expect(await engine.get({ ...input(), memoryId })).toEqual({
      status: 'failed',
    });
    expect(await engine.forget({ ...input(), memoryId })).toEqual({
      status: 'not_deleted',
      reason: 'invalid_input',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['a', 'x'.repeat(256), '...'])(
    'preserves safe ID %s in one segment',
    async (memoryId) => {
      const config = runtime();
      config.dialect.record.pathSuffix = '/';
      config.instance.endpoint.basePath = '/api/';
      const fetcher = vi
        .fn<FetchLike>()
        .mockResolvedValue(Response.json({ ...record(), id: memoryId }));
      expect(
        await createDeleteRequestEngine(config, fetcher).get({
          ...input(),
          memoryId,
        }),
      ).toMatchObject({ status: 'found', memoryId });
      expect(String(fetcher.mock.calls[0]?.[0])).toBe(
        `https://memory.example.com/api/memories/${memoryId}/`,
      );
    },
  );

  it.each(['\ud800', 'x\udc00', '😀'.repeat(4001)])(
    'rejects oversized or invalid text without deletion',
    async (memory) => {
      const fetcher = vi
        .fn<FetchLike>()
        .mockResolvedValue(Response.json({ ...record(), memory }));
      const engine = createDeleteRequestEngine(runtime(), fetcher);
      expect(
        await engine.forget({ ...input(), expectedContent: memory }),
      ).toMatchObject({ status: 'not_deleted', reason: 'invalid_input' });
      expect(fetcher).not.toHaveBeenCalled();
      expect(await engine.get(input())).toMatchObject({ status: 'failed' });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { user_id: 'other' },
    { user_id: null },
    { user_id: undefined },
    { user_id: 5 },
    { user_id: 'other', metadata: { user_id: 'repository-memory' } },
  ])('does not disclose or delete foreign/missing scope %j', async (patch) => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockImplementation(async () => Response.json({ ...record(), ...patch }));
    const engine = createDeleteRequestEngine(runtime(), fetcher);
    expect(await engine.get(input())).toEqual({
      status: 'unavailable',
      memoryId: input().memoryId,
    });
    expect(await engine.forget(input())).toMatchObject({
      status: 'not_deleted',
      reason: 'target_unavailable',
    });
    expect(calls(fetcher).map((call) => call.method)).toEqual(['GET', 'GET']);
  });

  it.each(['agentId', 'appId'] as const)(
    'checks every configured %s, not just user scope',
    async (key) => {
      const config = runtime();
      config.instance.scope[key] = 'required';
      const fetcher = vi
        .fn<FetchLike>()
        .mockResolvedValue(Response.json(record()));
      expect(
        await createDeleteRequestEngine(config, fetcher).forget(input()),
      ).toMatchObject({ status: 'not_deleted', reason: 'target_unavailable' });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each(['summary', content.trim(), content + '\n'])(
    'requires literal whole-text equality',
    async (expectedContent) => {
      const fetcher = vi
        .fn<FetchLike>()
        .mockResolvedValue(Response.json(record()));
      expect(
        await createDeleteRequestEngine(runtime(), fetcher).forget({
          ...input(),
          expectedContent,
        }),
      ).toMatchObject({ status: 'not_deleted', reason: 'target_changed' });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it('does not equate canonically equivalent but different Unicode text', async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ ...record(), memory: 'é' }));
    expect(
      await createDeleteRequestEngine(runtime(), fetcher).forget({
        ...input(),
        expectedContent: 'e\u0301',
      }),
    ).toMatchObject({ status: 'not_deleted', reason: 'target_changed' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rechecks after a previous get and does not retain a stale snapshot', async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(Response.json(record()))
      .mockResolvedValueOnce(
        Response.json({ ...record(), memory: 'changed while approving' }),
      );
    const engine = createDeleteRequestEngine(runtime(), fetcher);
    expect(await engine.get(input())).toMatchObject({ status: 'found' });
    expect(await engine.forget(input())).toMatchObject({
      status: 'not_deleted',
      reason: 'target_changed',
    });
    expect(calls(fetcher).map((call) => call.method)).toEqual(['GET', 'GET']);
  });

  it.each(['http-404', 'null-200'] as const)(
    'uses only selected not-found contract %s',
    async (notFound) => {
      const config = runtime();
      config.dialect.record.notFound = notFound;
      const missing = () =>
        notFound === 'http-404' ? absent() : Response.json(null);
      const fetcher = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(Response.json(record()))
        .mockResolvedValueOnce(ack())
        .mockResolvedValueOnce(missing())
        .mockResolvedValueOnce(missing())
        .mockResolvedValueOnce(
          notFound === 'http-404' ? Response.json(null) : absent(),
        );
      const engine = createDeleteRequestEngine(config, fetcher);
      expect(await engine.forget(input())).toMatchObject({ status: 'deleted' });
      expect(await engine.forget(input())).toMatchObject({
        status: 'not_deleted',
        reason: 'target_unavailable',
      });
      expect(await engine.get(input())).toMatchObject({ status: 'failed' });
      expect(
        calls(fetcher).filter((call) => call.method === 'DELETE'),
      ).toHaveLength(1);
    },
  );

  it.each(['memory', 'content', 'text'] as const)(
    'uses the configured root fields: %s',
    async (contentField) => {
      const config = runtime();
      config.dialect.record.contentField = contentField;
      config.dialect.record.idField = 'memory_id';
      const fetcher = vi.fn<FetchLike>().mockResolvedValue(
        Response.json({
          memory_id: input().memoryId,
          [contentField]: content,
          user_id: 'repository-memory',
        }),
      );
      expect(
        await createDeleteRequestEngine(config, fetcher).get(input()),
      ).toMatchObject({ status: 'found', content });
    },
  );

  it.each([
    null,
    [],
    {},
    { ...record(), id: 'other-id' },
    { ...record(), memory: null },
    { ...record(), error: 'private' },
    { results: [record()] },
  ])('rejects malformed preflight %j', async (payload) => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json(payload));
    expect(
      await createDeleteRequestEngine(runtime(), fetcher).forget(input()),
    ).toMatchObject({ status: 'not_deleted', reason: 'verification_failed' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    { message: 'Memory deleted successfully!' },
    { message: 'Memory memory:1 deleted successfully.' },
    { message: 'ok' },
    {},
    null,
    [],
    { status: 'PENDING', event: 'DELETE', cascade_count: 0 },
    { error: 'provider-specific response', status: 'FAILED', cascade_count: 1 },
  ])(
    'confirms absence independently of DELETE JSON contents %j',
    async (payload) => {
      const fetcher = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(Response.json(record()))
        .mockResolvedValueOnce(Response.json(payload))
        .mockResolvedValueOnce(absent());
      expect(
        await createDeleteRequestEngine(runtime(), fetcher).forget(input()),
      ).toMatchObject({ status: 'deleted' });
      expect(calls(fetcher).map((call) => call.method)).toEqual([
        'GET',
        'DELETE',
        'GET',
      ]);
    },
  );

  it.each([201, 202])(
    'verifies absence after HTTP %s with JSON',
    async (status) => {
      const fetcher = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(Response.json(record()))
        .mockResolvedValueOnce(
          Response.json({ message: 'accepted' }, { status }),
        )
        .mockResolvedValueOnce(Response.json(record()));
      expect(
        await createDeleteRequestEngine(runtime(), fetcher).forget(input()),
      ).toMatchObject({ status: 'unknown' });
      expect(calls(fetcher).map((call) => call.method)).toEqual([
        'GET',
        'DELETE',
        'GET',
      ]);
    },
  );

  it.each([201, 202])(
    'reports deleted after HTTP %s when the follow-up GET confirms absence',
    async (status) => {
      const fetcher = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(Response.json(record()))
        .mockResolvedValueOnce(
          Response.json({ message: 'accepted' }, { status }),
        )
        .mockResolvedValueOnce(absent());
      expect(
        await createDeleteRequestEngine(runtime(), fetcher).forget(input()),
      ).toMatchObject({ status: 'deleted' });
      expect(calls(fetcher).map((call) => call.method)).toEqual([
        'GET',
        'DELETE',
        'GET',
      ]);
    },
  );

  it.each([301, 400, 401, 403, 404, 429, 500])(
    'rejects non-success DELETE HTTP %s even with valid JSON',
    async (status) => {
      const fetcher = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(Response.json(record()))
        .mockResolvedValueOnce(Response.json({ message: 'ok' }, { status }));
      expect(
        await createDeleteRequestEngine(runtime(), fetcher).forget(input()),
      ).toMatchObject({ status: 'unknown' });
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    () => Response.json(record()),
    () => Response.json({ ...record(), user_id: 'other' }),
    () => new Response(null, { status: 403 }),
    () => Response.json(null),
    () => new Response('{invalid'),
  ])('cannot claim deletion without confirming absence', async (response) => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(Response.json(record()))
      .mockResolvedValueOnce(ack())
      .mockResolvedValueOnce(response());
    expect(
      await createDeleteRequestEngine(runtime(), fetcher).forget(input()),
    ).toMatchObject({ status: 'unknown' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([
    () => new Response(null, { status: 200 }),
    () => new Response(null, { status: 202 }),
    () => new Response(null, { status: 204 }),
    () => new Response('{bad'),
    () => new Response(new Uint8Array([0x22, 0xff, 0x22])),
    () => new Response('x'.repeat(1024 * 1024 + 1)),
    () =>
      new Response('{}', {
        headers: { 'content-length': String(1024 * 1024 + 1) },
      }),
  ])('bounds responses before and after DELETE', async (response) => {
    for (const submitted of [false, true]) {
      const fetcher = vi.fn<FetchLike>();
      if (submitted) fetcher.mockResolvedValueOnce(Response.json(record()));
      fetcher.mockResolvedValueOnce(response());
      expect(
        await createDeleteRequestEngine(runtime(), fetcher).forget(input()),
      ).toMatchObject({ status: submitted ? 'unknown' : 'not_deleted' });
      expect(fetcher).toHaveBeenCalledTimes(submitted ? 2 : 1);
    }
  });

  it('distinguishes pre-submission cancellation, failed construction and post-submission loss', async () => {
    const fetcher = vi.fn<FetchLike>();
    const config = runtime();
    expect(
      await createDeleteRequestEngine(config, fetcher).forget({
        ...input(),
        signal: AbortSignal.abort(),
      }),
    ).toMatchObject({ status: 'not_deleted', reason: 'cancelled' });
    config.credential = 'bad\nheader';
    expect(
      await createDeleteRequestEngine(config, fetcher).forget(input()),
    ).toMatchObject({ status: 'not_deleted', reason: 'verification_failed' });
    expect(fetcher).not.toHaveBeenCalled();
    fetcher
      .mockResolvedValueOnce(Response.json(record()))
      .mockRejectedValueOnce(new Error('private failure'));
    expect(
      await createDeleteRequestEngine(runtime(), fetcher).forget(input()),
    ).toMatchObject({ status: 'unknown' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
