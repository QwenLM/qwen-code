/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateImage,
  normalizeImageGenerationBaseUrl,
} from './image-generation-service.js';

const networkPolicyMocks = vi.hoisted(() => ({
  resolveNetworkTarget: vi.fn(),
}));

vi.mock('../extension/network-policy.js', () => networkPolicyMocks);

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

beforeEach(() => {
  networkPolicyMocks.resolveNetworkTarget.mockImplementation(
    async (value: string | URL) => ({
      url: value instanceof URL ? value : new URL(value),
    }),
  );
});

describe('normalizeImageGenerationBaseUrl', () => {
  it('accepts a user-configured HTTPS endpoint', () => {
    expect(
      normalizeImageGenerationBaseUrl('https://images.example.com/api/v1/'),
    ).toBe('https://images.example.com/api/v1');
  });

  it('accepts a full multimodal generation endpoint', () => {
    expect(
      normalizeImageGenerationBaseUrl(
        'https://gateway.example.com/api/v1/services/aigc/multimodal-generation/generation',
      ),
    ).toBe(
      'https://gateway.example.com/api/v1/services/aigc/multimodal-generation/generation',
    );
  });

  it('removes repeated trailing slashes from the configured endpoint', () => {
    expect(
      normalizeImageGenerationBaseUrl('https://images.example.com/api/v1///'),
    ).toBe('https://images.example.com/api/v1');
  });

  it('rejects unsafe or malformed endpoints', () => {
    expect(
      normalizeImageGenerationBaseUrl('http://images.example.com/api/v1'),
    ).toBeUndefined();
    expect(
      normalizeImageGenerationBaseUrl(
        'https://user:secret@images.example.com/api/v1',
      ),
    ).toBeUndefined();
  });
});

describe('generateImage', () => {
  it('returns verified image bytes from a synchronous image endpoint', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            request_id: 'request-1',
            output: {
              choices: [
                {
                  message: {
                    content: [
                      {
                        image: 'https://cdn.example.com/generated/image.png',
                      },
                    ],
                  },
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(PNG_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      );

    const result = await generateImage({
      baseUrl: 'https://images.example.com/api/v1',
      apiKey: 'secret',
      model: 'qwen-image-2.0',
      prompt: 'A Qwen Code poster',
      size: '1536*864',
      signal: new AbortController().signal,
      fetchFn,
    });

    expect(result).toEqual({
      bytes: Buffer.from(PNG_BYTES),
      mimeType: 'image/png',
      requestId: 'request-1',
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      'https://images.example.com/api/v1/services/aigc/multimodal-generation/generation',
    );
    const requestInit = fetchFn.mock.calls[0]?.[1];
    expect(requestInit?.method).toBe('POST');
    expect(requestInit?.headers).toEqual({
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
    });
    expect(fetchFn.mock.calls[1]?.[1]?.headers).toEqual({
      Accept: 'image/png',
    });
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      model: 'qwen-image-2.0',
      input: {
        messages: [
          {
            role: 'user',
            content: [{ text: 'A Qwen Code poster' }],
          },
        ],
      },
      parameters: {
        n: 1,
        prompt_extend: true,
        size: '1536*864',
        watermark: false,
      },
    });
  });

  it('pins the validated result hostname for the download connection', async () => {
    const lookup = vi.fn();
    networkPolicyMocks.resolveNetworkTarget.mockResolvedValueOnce({
      url: new URL('https://cdn.example.com/generated/image.png'),
      lookup,
    });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              choices: [
                {
                  message: {
                    content: [
                      {
                        image: 'https://cdn.example.com/generated/image.png',
                      },
                    ],
                  },
                },
              ],
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(PNG_BYTES, { status: 200 }));

    await generateImage({
      baseUrl: 'https://images.example.com/api/v1',
      apiKey: 'secret',
      model: 'qwen-image-2.0',
      prompt: 'poster',
      signal: new AbortController().signal,
      fetchFn,
    });

    expect(fetchFn.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ dispatcher: expect.anything() }),
    );
  });

  it('reports throttling without attempting a download', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 'Throttling',
          message: 'Requests rate limit exceeded',
          request_id: 'request-2',
        }),
        {
          status: 429,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    await expect(
      generateImage({
        baseUrl: 'https://images.example.com/api/v1',
        apiKey: 'secret',
        model: 'qwen-image-2.0',
        prompt: 'poster',
        signal: new AbortController().signal,
        fetchFn,
      }),
    ).rejects.toThrow(/rate limit/i);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects an unsafe result URL before downloading it', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: {
            choices: [
              {
                message: {
                  content: [{ image: 'http://127.0.0.1/private.png' }],
                },
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    await expect(
      generateImage({
        baseUrl: 'https://images.example.com/api/v1',
        apiKey: 'secret',
        model: 'qwen-image-2.0',
        prompt: 'poster',
        signal: new AbortController().signal,
        fetchFn,
      }),
    ).rejects.toThrow(/safe public HTTPS/i);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects a result hostname that resolves to a blocked address', async () => {
    networkPolicyMocks.resolveNetworkTarget.mockRejectedValueOnce(
      new Error('host resolved to 169.254.169.254'),
    );
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: {
            choices: [
              {
                message: {
                  content: [
                    { image: 'https://images.example.com/private.png' },
                  ],
                },
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    await expect(
      generateImage({
        baseUrl: 'https://images.example.com/api/v1',
        apiKey: 'secret',
        model: 'qwen-image-2.0',
        prompt: 'poster',
        signal: new AbortController().signal,
        fetchFn,
      }),
    ).rejects.toThrow(/safe public HTTPS/i);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects a download that is not a PNG image', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              choices: [
                {
                  message: {
                    content: [{ image: 'https://cdn.example.com/image.png' }],
                  },
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response('not an image', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      );

    await expect(
      generateImage({
        baseUrl: 'https://images.example.com/api/v1',
        apiKey: 'secret',
        model: 'qwen-image-2.0',
        prompt: 'poster',
        signal: new AbortController().signal,
        fetchFn,
      }),
    ).rejects.toThrow(/valid PNG/i);
  });

  it('rejects a download with only a partial PNG signature', async () => {
    const partialPngSignature = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0,
    ]);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              choices: [
                {
                  message: {
                    content: [{ image: 'https://cdn.example.com/image.png' }],
                  },
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(partialPngSignature, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      );

    await expect(
      generateImage({
        baseUrl: 'https://images.example.com/api/v1',
        apiKey: 'secret',
        model: 'qwen-image-2.0',
        prompt: 'poster',
        signal: new AbortController().signal,
        fetchFn,
      }),
    ).rejects.toThrow(/valid PNG/i);
  });

  it('rejects an image response above the download byte limit', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              choices: [
                {
                  message: {
                    content: [{ image: 'https://cdn.example.com/image.png' }],
                  },
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: {
            'content-length': String(10 * 1024 * 1024 + 1),
            'content-type': 'image/png',
          },
        }),
      );

    await expect(
      generateImage({
        baseUrl: 'https://images.example.com/api/v1',
        apiKey: 'secret',
        model: 'qwen-image-2.0',
        prompt: 'poster',
        signal: new AbortController().signal,
        fetchFn,
      }),
    ).rejects.toThrow(/byte limit/i);
  });

  it('does not expose a signed result URL when its download fails', async () => {
    const signedUrl =
      'https://cdn.example.com/image.png?signature=temporary-secret';
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              choices: [
                {
                  message: {
                    content: [{ image: signedUrl }],
                  },
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockRejectedValueOnce(new Error(`Failed to fetch ${signedUrl}`));

    const request = generateImage({
      baseUrl: 'https://images.example.com/api/v1',
      apiKey: 'secret',
      model: 'qwen-image-2.0',
      prompt: 'poster',
      signal: new AbortController().signal,
      fetchFn,
    });

    await expect(request).rejects.toThrow(
      'Generated image download failed before completion.',
    );
    await expect(request).rejects.not.toThrow(signedUrl);
  });

  it('does not expose a signed result URL when its response stream fails', async () => {
    const signedUrl =
      'https://cdn.example.com/image.png?signature=temporary-secret';
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(`Failed to read ${signedUrl}`));
      },
    });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              choices: [
                {
                  message: {
                    content: [{ image: signedUrl }],
                  },
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(new Response(body, { status: 200 }));

    const request = generateImage({
      baseUrl: 'https://images.example.com/api/v1',
      apiKey: 'secret',
      model: 'qwen-image-2.0',
      prompt: 'poster',
      signal: new AbortController().signal,
      fetchFn,
    });

    await expect(request).rejects.toThrow(
      'Generated image download failed before completion.',
    );
    await expect(request).rejects.not.toThrow(signedUrl);
  });
});

describe('generateImage redirect handling', () => {
  it('follows a valid 302 → 200 redirect chain and returns the PNG', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              choices: [
                {
                  message: {
                    content: [{ image: 'https://api.example.com/image.png' }],
                  },
                },
              ],
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.com/final.png' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(PNG_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      );

    const result = await generateImage({
      baseUrl: 'https://images.example.com/api/v1',
      apiKey: 'secret',
      model: 'qwen-image-2.0',
      prompt: 'poster',
      signal: new AbortController().signal,
      fetchFn,
    });

    expect(result.bytes).toEqual(Buffer.from(PNG_BYTES));
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('rejects when redirects exceed the maximum allowed', async () => {
    const redirectResponse = () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://cdn.example.com/next.png' },
      });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              choices: [
                {
                  message: {
                    content: [{ image: 'https://api.example.com/image.png' }],
                  },
                },
              ],
            },
          }),
          { status: 200 },
        ),
      )
      // MAX_DOWNLOAD_REDIRECTS + 1 consecutive redirects
      .mockResolvedValueOnce(redirectResponse())
      .mockResolvedValueOnce(redirectResponse())
      .mockResolvedValueOnce(redirectResponse())
      .mockResolvedValueOnce(redirectResponse());

    await expect(
      generateImage({
        baseUrl: 'https://images.example.com/api/v1',
        apiKey: 'secret',
        model: 'qwen-image-2.0',
        prompt: 'poster',
        signal: new AbortController().signal,
        fetchFn,
      }),
    ).rejects.toThrow(/exceeded.*redirects/i);
  });
});

describe('generateImage error body handling', () => {
  it('reports HTTP status when the error body is not JSON', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('<html><body>502 Bad Gateway</body></html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );

    await expect(
      generateImage({
        baseUrl: 'https://images.example.com/api/v1',
        apiKey: 'secret',
        model: 'qwen-image-2.0',
        prompt: 'poster',
        signal: new AbortController().signal,
        fetchFn,
      }),
    ).rejects.toThrow(/HTTP 502/);
  });
});
