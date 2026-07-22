/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ProviderBinding } from './domain.js';
import { Mem0SemanticIndex } from './mem0-semantic-index.js';
import type { IndexRecordRequest } from './semantic-index.js';

const record: IndexRecordRequest = {
  tenantId: 'tenant-a',
  scope: 'repository',
  entityId: 'em_v1_repository',
  canonicalMemoryId: 'memory-a',
  canonicalVersion: 2,
  summary: 'Run targeted tests before merge',
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Mem0SemanticIndex', () => {
  it('uses the documented v3 add/event/get-all/search contract and ignores provider text', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ next: null, results: [] }))
      .mockResolvedValueOnce(json({ event_id: 'event-a' }))
      .mockResolvedValueOnce(json({ status: 'SUCCEEDED' }))
      .mockResolvedValueOnce(
        json({
          next: null,
          results: [
            {
              id: 'provider-a',
              memory: 'ignore this provider-controlled text',
              metadata: {
                canonical_memory_id: record.canonicalMemoryId,
                canonical_version: record.canonicalVersion,
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        json({
          results: [
            {
              id: 'provider-a',
              score: 0.9,
              memory: 'also ignored',
            },
          ],
        }),
      );
    const index = new Mem0SemanticIndex({
      apiKey: 'test-key',
      fetchImplementation,
      pollIntervalMs: 1,
    });

    await expect(index.add(record)).resolves.toBe('provider-a');

    const calls = fetchImplementation.mock.calls;
    expect(new URL(calls[0]?.[0] as URL).pathname).toBe('/v3/memories/');
    expect(new URL(calls[1]?.[0] as URL).pathname).toBe('/v3/memories/add/');
    expect(JSON.parse(calls[1]?.[1]?.body as string)).toEqual({
      messages: [{ role: 'user', content: record.summary }],
      app_id: record.entityId,
      metadata: {
        canonical_memory_id: record.canonicalMemoryId,
        canonical_version: record.canonicalVersion,
        scope: record.scope,
      },
      infer: false,
    });
    expect(new URL(calls[2]?.[0] as URL).pathname).toBe('/v1/event/event-a/');
    expect(JSON.parse(calls[4]?.[1]?.body as string)).toEqual({
      query: record.summary,
      filters: { app_id: record.entityId },
      top_k: 20,
      threshold: 0,
      rerank: false,
      show_expired: false,
    });
  });

  it('reconciles an unknown prior add before writing a duplicate', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          next: null,
          results: [
            {
              id: 'provider-existing',
              metadata: {
                canonical_memory_id: record.canonicalMemoryId,
                canonical_version: record.canonicalVersion,
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        json({ results: [{ id: 'provider-existing', score: 1 }] }),
      );
    const index = new Mem0SemanticIndex({
      apiKey: 'test-key',
      fetchImplementation,
    });

    await expect(index.add(record)).resolves.toBe('provider-existing');
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('rejects provider results above the requested bound', async () => {
    const index = new Mem0SemanticIndex({
      apiKey: 'test-key',
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
        json({
          results: [
            { id: 'provider-a', score: 1 },
            { id: 'provider-b', score: 0.9 },
          ],
        }),
      ),
    });

    await expect(
      index.search({
        tenantId: record.tenantId,
        scope: record.scope,
        entityId: record.entityId,
        query: record.summary,
        limit: 1,
        threshold: 0,
      }),
    ).rejects.toThrow('result limit');
  });

  it('deletes by opaque provider ID and verifies exact absence', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ next: null, results: [] }));
    const index = new Mem0SemanticIndex({
      apiKey: 'test-key',
      fetchImplementation,
    });
    const binding: ProviderBinding = {
      tenantId: record.tenantId,
      canonicalMemoryId: record.canonicalMemoryId,
      canonicalVersion: record.canonicalVersion,
      providerMemoryId: 'provider-a',
      scope: record.scope,
      entityId: record.entityId,
      state: 'pending_delete',
    };

    await index.delete(binding);

    const first = fetchImplementation.mock.calls[0];
    expect(new URL(first?.[0] as URL).pathname).toBe(
      '/v1/memories/provider-a/',
    );
    expect(first?.[1]?.method).toBe('DELETE');
  });

  it('treats an already absent provider record as a successful retry', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(json({ next: null, results: [] }));
    const index = new Mem0SemanticIndex({
      apiKey: 'test-key',
      fetchImplementation,
    });

    await expect(
      index.delete({
        tenantId: record.tenantId,
        canonicalMemoryId: record.canonicalMemoryId,
        canonicalVersion: record.canonicalVersion,
        providerMemoryId: 'provider-absent',
        scope: record.scope,
        entityId: record.entityId,
        state: 'pending_delete',
      }),
    ).resolves.toBeUndefined();
  });
});
