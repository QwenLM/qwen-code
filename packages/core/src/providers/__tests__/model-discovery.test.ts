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

  it('merges standard model ids with known specs in stable order', async () => {
    fetchWithPolicyMock.mockResolvedValue(
      response({
        data: [
          { id: 'known-b' },
          { id: 'new-model' },
          { id: 'known-a' },
          { id: 'new-model' },
          { id: 'qwen-audio-3.0' },
          { id: 'wan2.7-image' },
          { id: 'wan2.7-t2v-plus' },
          { id: 'paraformer-v2' },
          { id: 'stable-diffusion-xl' },
        ],
      }),
    );

    await expect(discoverProviderModels(options)).resolves.toEqual([
      { id: 'known-a', contextWindowSize: 1000 },
      { id: 'known-b', enableThinking: true },
      { id: 'new-model' },
    ]);
    expect(fetchWithPolicyMock).toHaveBeenCalledWith(
      'https://example.com/v1/models',
      expect.objectContaining({
        timeoutMs: 5000,
        maxBytes: 1024 * 1024,
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
    { models: [{ id: 'model-a' }] },
  ])('rejects a non-standard or empty listing: %j', async (body) => {
    fetchWithPolicyMock.mockResolvedValue(response(body));

    await expect(discoverProviderModels(options)).resolves.toBeNull();
  });

  it('falls back when all returned ids are non-chat models', async () => {
    fetchWithPolicyMock.mockResolvedValue(
      response({
        data: [
          { id: 'text-embedding-v3' },
          { id: 'qwen-tts-1' },
          { id: 'video-generation' },
          { id: 'wanx-v1' },
          { id: 'whisper-v3' },
          { id: 'flux-schnell' },
        ],
      }),
    );

    await expect(discoverProviderModels(options)).resolves.toBeNull();
  });

  it.each([
    response({}, 401),
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
