/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverProviderModels } from '../model-discovery.js';

const { fetchWithPolicyMock } = vi.hoisted(() => ({
  fetchWithPolicyMock: vi.fn(),
}));

vi.mock('../../utils/fetch.js', () => ({
  fetchWithPolicy: fetchWithPolicyMock,
}));

function response(body: unknown, status = 200) {
  return {
    kind: 'response' as const,
    status,
    statusText: '',
    contentType: 'application/json',
    contentDisposition: '',
    body: Buffer.from(JSON.stringify(body)),
    finalUrl: 'https://example.com/v1/models',
  };
}

const options = {
  baseUrl: ' https://example.com/v1/ ',
  apiKey: ' secret-key ',
  staticModels: [
    { id: 'known-a', contextWindowSize: 1000 },
    { id: 'known-b', enableThinking: true },
    { id: 'retired' },
  ],
};

/** `{ id }` entries, one per id. */
const ids = (...values: string[]) => values.map((id) => ({ id }));

/** Serves `{ data }` from the catalog endpoint and runs discovery. */
function discoverFrom(data: unknown[]) {
  fetchWithPolicyMock.mockResolvedValue(response({ data }));
  return discoverProviderModels(options);
}

describe('discoverProviderModels', () => {
  beforeEach(() => {
    fetchWithPolicyMock.mockReset();
  });

  it.each([
    ['openai', 'https://example.com/prefix/models', 'Authorization'],
    [
      'openai-responses',
      'https://example.com/prefix/v1/models',
      'Authorization',
    ],
    [
      'anthropic',
      'https://example.com/prefix/v1/models?limit=1000',
      'Authorization',
    ],
  ] as const)(
    'uses %s listing conventions and accepts gateway maps',
    async (protocol, url, authHeader) => {
      fetchWithPolicyMock.mockResolvedValue(
        response({ models: { 'gateway-model': {} } }),
      );
      await expect(
        discoverProviderModels({
          ...options,
          baseUrl: 'https://example.com/prefix',
          protocol,
        }),
      ).resolves.toEqual([{ id: 'gateway-model' }]);
      expect(fetchWithPolicyMock).toHaveBeenCalledWith(
        url,
        expect.objectContaining({
          headers: expect.objectContaining({
            [authHeader]: 'Bearer secret-key',
          }),
        }),
      );
    },
  );

  it.each([
    ['https://api.anthropic.com', true],
    ['https://sandbox.anthropic.com/prefix', true],
    ['https://API.ANTHROPIC.COM:443/v1/', true],
    ['https://proxy.example.com/prefix', false],
    ['https://api.anthropic.com.evil.example/v1', false],
    ['https://api.anthropic.com@proxy.example.com/v1', false],
  ])('matches runtime Anthropic auth for %s', async (baseUrl, native) => {
    fetchWithPolicyMock.mockResolvedValue(response({ data: ids('model') }));
    await discoverProviderModels({
      ...options,
      baseUrl,
      protocol: 'anthropic',
    });
    const headers = fetchWithPolicyMock.mock.calls[0][1].headers;
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['x-api-key']).toBe(native ? 'secret-key' : undefined);
    expect(headers.Authorization).toBe(
      native ? undefined : 'Bearer secret-key',
    );
  });

  it('ignores malformed gateway map entries instead of offering their keys', async () => {
    fetchWithPolicyMock.mockResolvedValue(
      response({
        models: { valid: {}, nil: null, list: [], scalar: 'invalid' },
      }),
    );
    await expect(discoverProviderModels(options)).resolves.toEqual([
      { id: 'valid' },
    ]);
    fetchWithPolicyMock.mockResolvedValue(
      response({ models: { nil: null, scalar: true } }),
    );
    await expect(discoverProviderModels(options)).resolves.toBeNull();
  });

  it('can disable redirects without changing the preset default', async () => {
    fetchWithPolicyMock.mockResolvedValue(response({ data: ids('model') }));
    await discoverProviderModels({ ...options, maxRedirects: 0 });
    expect(fetchWithPolicyMock).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ maxRedirects: 0 }),
    );
    await discoverProviderModels(options);
    expect(fetchWithPolicyMock).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ maxRedirects: 2 }),
    );
  });

  it('returns every served id uncurated and preserves provider order without dates', async () => {
    await expect(
      discoverFrom([
        { id: 'known-b' },
        { id: 'new-model' },
        { id: 'known-a' },
        { id: 'new-model' },
        { id: ' padded-model ' },
        { id: 'qwen2-audio-instruct' },
        { id: 'qwen-vl-ocr-latest' },
        { id: 'wan2.7-t2v-plus' },
      ]),
    ).resolves.toEqual([
      { id: 'known-b', enableThinking: true },
      { id: 'new-model' },
      { id: 'known-a', contextWindowSize: 1000 },
      { id: 'padded-model' },
      { id: 'qwen2-audio-instruct' },
      { id: 'qwen-vl-ocr-latest' },
      { id: 'wan2.7-t2v-plus' },
    ]);
    expect(fetchWithPolicyMock).toHaveBeenCalledWith(
      'https://example.com/v1/models',
      expect.objectContaining({
        timeoutMs: 5000,
        maxBytes: 1024 * 1024,
        maxRedirects: 2,
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer secret-key',
        },
      }),
    );
  });

  it('sorts served models by creation time with newest first', async () => {
    await expect(
      discoverFrom([
        { id: 'older-model', created: 100 },
        { id: 'newest-model', created: 300 },
        { id: 'same-age-model', created: 200 },
        { id: 'known-a', created: 200 },
      ]),
    ).resolves.toEqual([
      { id: 'newest-model' },
      { id: 'same-age-model' },
      { id: 'known-a', contextWindowSize: 1000 },
      { id: 'older-model' },
    ]);
  });

  it('preserves provider order when creation dates are incomplete', async () => {
    await expect(
      discoverFrom([
        { id: 'older-model', created: 100 },
        { id: 'undated-model' },
        { id: 'newer-model', created: 200 },
      ]),
    ).resolves.toEqual(ids('older-model', 'undated-model', 'newer-model'));
  });

  it('preserves provider order when creation dates are invalid', async () => {
    await expect(
      discoverFrom([
        { id: 'string-dated', created: '100' },
        { id: 'newest-model', created: 300 },
        { id: 'null-dated', created: null },
        { id: 'negative-dated', created: -1 },
      ]),
    ).resolves.toEqual([
      { id: 'string-dated' },
      { id: 'newest-model' },
      { id: 'null-dated' },
      { id: 'negative-dated' },
    ]);
  });

  it.each([
    [{ id: 'model-a' }],
    { data: ['model-a'] },
    { data: [{ id: '' }] },
    { data: [] },
    { data: [{ id: 'model-a' }, null] },
    { models: [{ id: 'model-a' }] },
  ])('rejects a non-standard or empty listing: %j', async (body) => {
    fetchWithPolicyMock.mockResolvedValue(response(body));

    await expect(discoverProviderModels(options)).resolves.toBeNull();
  });

  it.each([
    [
      'keeps valid ids and skips ones with structural or control bytes',
      ids('a, b', 'bad\u001b[31mid', 'del\u007fete', 'good-model'),
      ids('good-model'),
    ],
    [
      'skips ids with invisible or formatting characters',
      ids(
        'qwen3.7-plus',
        'qwen3.7\u200b-plus',
        '\u200bqwen-lookalike',
        'qwen\u202e3.7',
        'soft\u00adhyphen',
        'a\ufeffb',
        'qwen\u20663',
        'line\u2028sep',
        'para\u2029sep',
        'arabic\u061cmark',
        'mongolian\u180evs',
      ),
      ids('qwen3.7-plus'),
    ],
    [
      'skips ids with unassigned, private-use, or surrogate code points',
      ids(
        'unassigned\u2065point',
        'private\ue000use',
        'surrogate\ud800point',
        'good-model',
      ),
      ids('good-model'),
    ],
    [
      'skips ids with C1 control bytes',
      ids(
        'csi\u009b31m',
        'nel\u0085line',
        'dcs\u0090string',
        'st\u009cterm',
        'good-model',
      ),
      ids('good-model'),
    ],
    [
      'skips ids longer than a plausible model name',
      ids('a'.repeat(257), 'b'.repeat(256), 'good-model'),
      ids('b'.repeat(256), 'good-model'),
    ],
  ])('%s', async (_title, data, expected) => {
    await expect(discoverFrom(data)).resolves.toEqual(expected);
  });

  it('falls back when every served id is unsafe', async () => {
    await expect(discoverFrom(ids('a, b', '\u0007bell'))).resolves.toBeNull();
  });

  it.each([
    response({ data: [{ id: 'model-a' }] }, 401),
    {
      kind: 'cross-host-redirect' as const,
      originalUrl: 'https://example.com/v1/models',
      redirectUrl: 'https://other.example/models',
      status: 302,
    },
  ])('falls back for an unsuccessful response', async (result) => {
    fetchWithPolicyMock.mockResolvedValue(result);

    await expect(discoverProviderModels(options)).resolves.toBeNull();
  });

  it('falls back when the request or JSON parsing fails', async () => {
    fetchWithPolicyMock.mockRejectedValueOnce(new Error('offline'));
    await expect(discoverProviderModels(options)).resolves.toBeNull();

    fetchWithPolicyMock.mockResolvedValueOnce({
      ...response({}),
      body: Buffer.from('{'),
    });
    await expect(discoverProviderModels(options)).resolves.toBeNull();
  });

  it('does not request a catalog without both endpoint and key', async () => {
    await expect(
      discoverProviderModels({ ...options, apiKey: '' }),
    ).resolves.toBeNull();
    await expect(
      discoverProviderModels({ ...options, baseUrl: '' }),
    ).resolves.toBeNull();

    expect(fetchWithPolicyMock).not.toHaveBeenCalled();
  });

  it('passes caller cancellation to the bounded request', async () => {
    fetchWithPolicyMock.mockResolvedValue(response({ data: [{ id: 'new' }] }));
    const controller = new AbortController();

    await discoverProviderModels({ ...options, signal: controller.signal });

    expect(fetchWithPolicyMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
