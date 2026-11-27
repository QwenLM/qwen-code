/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import { discoverProviderModels } from './modelDiscovery.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('discoverProviderModels', () => {
  it('returns model ids from the provider catalog', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        data: [
          { id: 'qwen3.8-max' },
          { id: ' qwen3.8-max ' },
          { id: 'deepseek-v4.1-flash' },
        ],
      }),
    );

    await expect(
      discoverProviderModels({
        baseUrl: 'https://example.test/v1/',
        apiKey: 'sk-test',
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual(['qwen3.8-max', 'deepseek-v4.1-flash']);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test',
        }),
      }),
    );
  });

  it('orders by created when every entry carries one', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        data: [
          { id: 'old', created: 100 },
          { id: 'new', created: 300 },
          { id: 'mid', created: 200 },
        ],
      }),
    );

    await expect(
      discoverProviderModels({
        baseUrl: 'https://example.test/v1',
        apiKey: 'sk-test',
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual(['new', 'mid', 'old']);
  });

  it('keeps server order when created is missing', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        data: [
          { id: 'first', created: 100 },
          { id: 'second' },
          { id: 'third', created: 300 },
        ],
      }),
    );

    await expect(
      discoverProviderModels({
        baseUrl: 'https://example.test/v1',
        apiKey: 'sk-test',
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual(['first', 'second', 'third']);
  });

  it('drops ids the wizard cannot round-trip', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        data: [{ id: 'ok' }, { id: 'bad,id' }, { id: '' }],
      }),
    );

    await expect(
      discoverProviderModels({
        baseUrl: 'https://example.test/v1',
        apiKey: 'sk-test',
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual(['ok']);
  });

  it('returns null when discovery is unavailable', async () => {
    const failing = vi.fn(async () => response({}, 500));
    await expect(
      discoverProviderModels({
        baseUrl: 'https://example.test/v1',
        apiKey: 'sk-test',
        fetchImpl: failing as typeof fetch,
      }),
    ).resolves.toBeNull();
    await expect(
      discoverProviderModels({
        baseUrl: '',
        apiKey: 'sk-test',
        fetchImpl: failing as typeof fetch,
      }),
    ).resolves.toBeNull();
  });
});
