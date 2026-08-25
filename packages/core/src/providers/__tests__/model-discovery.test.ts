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

describe('discoverProviderModels', () => {
  beforeEach(() => {
    fetchWithPolicyMock.mockReset();
  });

  it('returns every served id uncurated, merging known specs first in stable order', async () => {
    fetchWithPolicyMock.mockResolvedValue(
      response({
        data: [
          { id: 'known-b' },
          { id: 'new-model' },
          { id: 'known-a' },
          { id: 'new-model' },
          { id: ' padded-model ' },
          { id: 'qwen2-audio-instruct' },
          { id: 'qwen-vl-ocr-latest' },
          { id: 'wan2.7-t2v-plus' },
        ],
      }),
    );

    await expect(discoverProviderModels(options)).resolves.toEqual([
      { id: 'known-a', contextWindowSize: 1000 },
      { id: 'known-b', enableThinking: true },
      { id: 'new-model' },
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

  it('keeps valid ids and skips ones with structural or control bytes', async () => {
    fetchWithPolicyMock.mockResolvedValue(
      response({
        data: [
          { id: 'a, b' },
          { id: 'bad\u001b[31mid' },
          { id: 'del\u007fete' },
          { id: 'good-model' },
        ],
      }),
    );

    await expect(discoverProviderModels(options)).resolves.toEqual([
      { id: 'good-model' },
    ]);
  });

  it('skips ids with invisible or formatting characters', async () => {
    fetchWithPolicyMock.mockResolvedValue(
      response({
        data: [
          { id: 'qwen3.7-plus' },
          { id: 'qwen3.7\u200b-plus' },
          { id: '\u200bqwen-lookalike' },
          { id: 'qwen\u202e3.7' },
          { id: 'soft\u00adhyphen' },
          { id: 'a\ufeffb' },
          { id: 'qwen\u20663' },
          { id: 'line\u2028sep' },
          { id: 'para\u2029sep' },
          { id: 'arabic\u061cmark' },
          { id: 'mongolian\u180evs' },
        ],
      }),
    );

    await expect(discoverProviderModels(options)).resolves.toEqual([
      { id: 'qwen3.7-plus' },
    ]);
  });

  it('skips ids with unassigned, private-use, or surrogate code points', async () => {
    fetchWithPolicyMock.mockResolvedValue(
      response({
        data: [
          { id: 'unassigned\u2065point' },
          { id: 'private\ue000use' },
          { id: 'surrogate\ud800point' },
          { id: 'good-model' },
        ],
      }),
    );

    await expect(discoverProviderModels(options)).resolves.toEqual([
      { id: 'good-model' },
    ]);
  });

  it('skips ids with C1 control bytes', async () => {
    fetchWithPolicyMock.mockResolvedValue(
      response({
        data: [
          { id: 'csi\u009b31m' },
          { id: 'nel\u0085line' },
          { id: 'dcs\u0090string' },
          { id: 'st\u009cterm' },
          { id: 'good-model' },
        ],
      }),
    );

    await expect(discoverProviderModels(options)).resolves.toEqual([
      { id: 'good-model' },
    ]);
  });

  it('skips ids longer than a plausible model name', async () => {
    fetchWithPolicyMock.mockResolvedValue(
      response({
        data: [
          { id: 'a'.repeat(257) },
          { id: 'b'.repeat(256) },
          { id: 'good-model' },
        ],
      }),
    );

    await expect(discoverProviderModels(options)).resolves.toEqual([
      { id: 'b'.repeat(256) },
      { id: 'good-model' },
    ]);
  });

  it('falls back when every served id is unsafe', async () => {
    fetchWithPolicyMock.mockResolvedValue(
      response({ data: [{ id: 'a, b' }, { id: '\u0007bell' }] }),
    );

    await expect(discoverProviderModels(options)).resolves.toBeNull();
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
