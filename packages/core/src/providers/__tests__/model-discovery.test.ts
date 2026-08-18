/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { FetchPolicyResult } from '../../utils/fetch.js';
import { FetchError } from '../../utils/fetch.js';
import {
  MODEL_DISCOVERY_TIMEOUT_MS,
  fetchProviderModelIds,
  isChatCapableModelId,
  mergeDiscoveredModels,
  parseModelListResponse,
} from '../model-discovery.js';
import { codingPlanProvider } from '../presets/alibaba-coding-plan.js';
import { tokenPlanProvider } from '../presets/alibaba-token-plan.js';
import type { ModelSpec } from '../types.js';

const fetchWithPolicyMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/fetch.js')>();
  return { ...actual, fetchWithPolicy: fetchWithPolicyMock };
});

function jsonResponse(body: unknown, status = 200): FetchPolicyResult {
  return {
    kind: 'response',
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    contentType: 'application/json',
    contentDisposition: '',
    body: Buffer.from(JSON.stringify(body), 'utf8'),
    finalUrl: 'https://example.test/v1/models',
  };
}

describe('parseModelListResponse', () => {
  it('reads the OpenAI listing shape', () => {
    expect(
      parseModelListResponse({
        object: 'list',
        data: [{ id: 'a' }, { id: 'b' }],
      }),
    ).toEqual(['a', 'b']);
  });

  it('reads the ModelStudio Coding Plan listing verbatim', () => {
    // Real payload shape — note `ownedBy`, not OpenAI's `owned_by`.
    expect(
      parseModelListResponse({
        object: 'list',
        data: [
          {
            id: 'qwen3-coder-plus',
            object: 'model',
            created: 1772196763,
            ownedBy: 'system',
          },
        ],
      }),
    ).toEqual(['qwen3-coder-plus']);
  });

  it('accepts bare arrays, `models` keys, and plain strings', () => {
    expect(parseModelListResponse([{ id: 'a' }])).toEqual(['a']);
    expect(parseModelListResponse({ models: [{ id: 'a' }] })).toEqual(['a']);
    expect(parseModelListResponse({ data: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('reads `model` and `name` when the entry carries no `id`', () => {
    // Gateways in the wild name the field either way; dropping these keys
    // turns a usable listing into `malformed` and a silent static fallback.
    expect(parseModelListResponse({ data: [{ model: 'a' }] })).toEqual(['a']);
    expect(parseModelListResponse({ data: [{ name: 'b' }] })).toEqual(['b']);
  });

  it('deduplicates while preserving provider order', () => {
    expect(
      parseModelListResponse({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] }),
    ).toEqual(['b', 'a']);
  });

  it('returns an empty list for an empty listing but null for a non-listing', () => {
    expect(parseModelListResponse({ data: [] })).toEqual([]);
    expect(parseModelListResponse({ error: 'nope' })).toBeNull();
    expect(parseModelListResponse('nope')).toBeNull();
    // Entries present but none carries a usable id — a shape we do not know.
    expect(parseModelListResponse({ data: [{ foo: 1 }] })).toBeNull();
  });
});

describe('isChatCapableModelId', () => {
  it('keeps chat models, including multimodal ones', () => {
    for (const id of [
      'qwen3.8-max',
      'qwen3-coder-plus',
      'kimi-k2.5',
      'glm-5',
      'MiniMax-M2.5',
      'deepseek-v3.2',
      'qwen-vl-max',
    ]) {
      expect(`${id}:${isChatCapableModelId(id)}`).toBe(`${id}:true`);
    }
  });

  it('drops endpoints that cannot serve chat completions', () => {
    for (const id of [
      'text-embedding-v4',
      'gte-rerank-v2',
      'wan2.7-image',
      'qwen-image-edit',
      'qwen-audio-3.0-turbo',
      'cosyvoice-v2',
      'paraformer-realtime-v2',
      'qwen-tts-latest',
      'text-moderation-plus',
    ]) {
      expect(`${id}:${isChatCapableModelId(id)}`).toBe(`${id}:false`);
    }
  });
});

describe('mergeDiscoveredModels', () => {
  const staticModels: ModelSpec[] = [
    { id: 'keep-me', contextWindowSize: 1000, enableThinking: true },
    { id: 'retired', contextWindowSize: 2000 },
  ];

  it('keeps built-in metadata and curated order, not the provider order', () => {
    const merged = mergeDiscoveredModels(staticModels, ['retired', 'keep-me']);
    expect(merged.map((m) => m.id)).toEqual(['keep-me', 'retired']);
    // Metadata is the built-in spec itself — /models cannot supply any of it.
    expect(merged[0]).toBe(staticModels[0]);
    expect(merged[1]).toBe(staticModels[1]);
  });

  it('drops built-in ids the provider no longer serves', () => {
    expect(mergeDiscoveredModels(staticModels, ['keep-me'])).toEqual([
      staticModels[0],
    ]);
  });

  it('appends newly served ids with no invented metadata', () => {
    const merged = mergeDiscoveredModels(staticModels, [
      'keep-me',
      'brand-new',
    ]);
    expect(merged).toEqual([staticModels[0], { id: 'brand-new' }]);
  });

  it('tolerates a provider with no built-in list', () => {
    expect(mergeDiscoveredModels(undefined, ['a'])).toEqual([{ id: 'a' }]);
  });
});

describe('fetchProviderModelIds', () => {
  beforeEach(() => {
    fetchWithPolicyMock.mockReset();
  });

  it('requests {baseUrl}/models with a bearer key', async () => {
    fetchWithPolicyMock.mockResolvedValue(
      jsonResponse({ data: [{ id: 'qwen3.8-max' }] }),
    );

    const controller = new AbortController();
    const result = await fetchProviderModelIds({
      // The shape every real preset uses: no trailing slash. A relative-URL
      // join would silently drop the `/v1` segment here and 404.
      baseUrl: 'https://token-plan.example/compatible-mode/v1',
      apiKey: 'sk-test',
      signal: controller.signal,
    });

    expect(result).toEqual({ ok: true, ids: ['qwen3.8-max'] });
    const [url, options] = fetchWithPolicyMock.mock.calls[0];
    expect(url).toBe('https://token-plan.example/compatible-mode/v1/models');
    expect(options.headers['Authorization']).toBe('Bearer sk-test');
    // The signal is the only wire for the wizard's unmount/re-key abort.
    expect(options.signal).toBe(controller.signal);
    expect(options.timeoutMs).toBe(MODEL_DISCOVERY_TIMEOUT_MS);
    // 403 is classified as deterministic here, so the transport must not
    // re-send the request behind discovery's back.
    expect(options.retryTransientStatuses).toBe(false);
  });

  it('trims a trailing slash instead of doubling it', async () => {
    fetchWithPolicyMock.mockResolvedValue(
      jsonResponse({ data: [{ id: 'a' }] }),
    );

    await fetchProviderModelIds({
      baseUrl: 'https://token-plan.example/compatible-mode/v1/',
    });

    expect(fetchWithPolicyMock.mock.calls[0][0]).toBe(
      'https://token-plan.example/compatible-mode/v1/models',
    );
  });

  it('honours an explicit timeout override', async () => {
    fetchWithPolicyMock.mockResolvedValue(
      jsonResponse({ data: [{ id: 'a' }] }),
    );

    await fetchProviderModelIds({
      baseUrl: 'https://a.example/v1',
      timeoutMs: 250,
    });

    expect(fetchWithPolicyMock.mock.calls[0][1].timeoutMs).toBe(250);
  });

  it('omits the header when no key is available', async () => {
    fetchWithPolicyMock.mockResolvedValue(
      jsonResponse({ data: [{ id: 'a' }] }),
    );

    await fetchProviderModelIds({ baseUrl: 'https://coding.example/v1' });

    const [, options] = fetchWithPolicyMock.mock.calls[0];
    expect(options.headers['Authorization']).toBeUndefined();
  });

  it('filters non-chat models out of the listing', async () => {
    fetchWithPolicyMock.mockResolvedValue(
      jsonResponse({
        data: [{ id: 'qwen3.8-max' }, { id: 'wan2.7-image' }],
      }),
    );

    await expect(
      fetchProviderModelIds({ baseUrl: 'https://a.example/v1' }),
    ).resolves.toEqual({ ok: true, ids: ['qwen3.8-max'] });
  });

  it.each([
    [404, 'unsupported'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [500, 'http'],
  ])('maps HTTP %i to reason %s', async (status, reason) => {
    fetchWithPolicyMock.mockResolvedValue(jsonResponse({}, status));

    const result = await fetchProviderModelIds({
      baseUrl: 'https://a.example/v1',
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe(reason);
  });

  it('reports network failures instead of throwing', async () => {
    fetchWithPolicyMock.mockRejectedValue(
      new FetchError('Request timed out after 5000ms', 'ETIMEDOUT'),
    );

    const result = await fetchProviderModelIds({
      baseUrl: 'https://a.example/v1',
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('network');
  });

  it('reports a cross-host redirect as a network failure', async () => {
    fetchWithPolicyMock.mockResolvedValue({
      kind: 'cross-host-redirect',
      originalUrl: 'https://a.example/v1/models',
      redirectUrl: 'https://elsewhere.example/v1/models',
      status: 302,
    });

    const result = await fetchProviderModelIds({
      baseUrl: 'https://a.example/v1',
    });

    expect(result.ok === false && result.reason).toBe('network');
  });

  it('reports unparseable and unrecognized bodies as malformed', async () => {
    fetchWithPolicyMock.mockResolvedValue({
      ...jsonResponse({}),
      body: Buffer.from('<html>login</html>', 'utf8'),
    });
    expect(
      await fetchProviderModelIds({ baseUrl: 'https://a.example/v1' }),
    ).toMatchObject({ ok: false, reason: 'malformed' });

    fetchWithPolicyMock.mockResolvedValue(jsonResponse({ error: 'nope' }));
    expect(
      await fetchProviderModelIds({ baseUrl: 'https://a.example/v1' }),
    ).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('reports a listing with nothing chat-shaped as empty', async () => {
    fetchWithPolicyMock.mockResolvedValue(
      jsonResponse({ data: [{ id: 'text-embedding-v4' }] }),
    );

    expect(
      await fetchProviderModelIds({ baseUrl: 'https://a.example/v1' }),
    ).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('rejects a non-http base URL without issuing a request', async () => {
    expect(await fetchProviderModelIds({ baseUrl: '' })).toMatchObject({
      ok: false,
      reason: 'network',
    });
    expect(fetchWithPolicyMock).not.toHaveBeenCalled();
  });
});

describe('provider opt-in', () => {
  it('is enabled for the ModelStudio presets whose endpoints serve /models', () => {
    expect(tokenPlanProvider.supportsModelDiscovery).toBe(true);
    expect(codingPlanProvider.supportsModelDiscovery).toBe(true);
  });
});
