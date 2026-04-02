/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs so we don't need real files
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn().mockReturnValue(Buffer.from('fake-audio-data')),
    },
  };
});

const { transcribe } = await import('./sttClient.js');

describe('transcribe', () => {
  const ENDPOINT = 'http://localhost:8000/v1/audio/transcriptions';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('posts to the endpoint and returns trimmed transcript', async () => {
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: '  hello world  ' }),
    } as Response);

    const result = await transcribe('/tmp/audio.wav', ENDPOINT);

    expect(mockFetch).toHaveBeenCalledWith(
      ENDPOINT,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toBe('hello world');
  });

  it('sends FormData with model field', async () => {
    let capturedBody: FormData | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as FormData;
        return {
          ok: true,
          json: async () => ({ text: 'ok' }),
        } as Response;
      },
    );

    await transcribe('/tmp/audio.wav', ENDPOINT, 'my-model');

    expect(capturedBody).toBeInstanceOf(FormData);
    expect(capturedBody!.get('model')).toBe('my-model');
  });

  it('throws on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as unknown as Response);

    await expect(transcribe('/tmp/audio.wav', ENDPOINT)).rejects.toThrow(
      'STT endpoint returned 500',
    );
  });
});
