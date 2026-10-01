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
import type { ImageGenerationRequest } from './image-generation-service.js';

const networkPolicyMocks = vi.hoisted(() => ({
  resolveNetworkTarget: vi.fn(),
}));

vi.mock('../extension/network-policy.js', () => networkPolicyMocks);

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const CDN_IMAGE = 'https://cdn.example.com/image.png';

beforeEach(() => {
  networkPolicyMocks.resolveNetworkTarget.mockImplementation(
    async (value: string | URL) => ({
      url: value instanceof URL ? value : new URL(value),
    }),
  );
});

/** A 200 JSON response without a content-type header. */
const bare = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });
/** A JSON response with an `application/json` content-type. */
const typed = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
/** A 200 download response with an `image/png` content-type. */
const pngResponse = (bytes: BodyInit = PNG_BYTES) =>
  new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
const redirect = (location: string) =>
  new Response(null, { status: 302, headers: { location } });

/** A DashScope multimodal-generation result naming one image URL. */
const dashscope = (image: string, requestId?: string) => ({
  ...(requestId !== undefined ? { request_id: requestId } : {}),
  output: { choices: [{ message: { content: [{ image }] } }] },
});

/** A fetch mock answering each call in turn (an Error rejects). */
function fetchSeq(...answers: Array<Response | Error>) {
  const fetchFn = vi.fn<typeof fetch>();
  for (const answer of answers) {
    if (answer instanceof Error) fetchFn.mockRejectedValueOnce(answer);
    else fetchFn.mockResolvedValueOnce(answer);
  }
  return fetchFn;
}

/** generateImage against the DashScope defaults, with `over` applied. */
const run = (
  fetchFn: typeof fetch,
  over: Partial<ImageGenerationRequest> = {},
) =>
  generateImage({
    baseUrl: 'https://images.example.com/api/v1',
    apiKey: 'secret',
    model: 'qwen-image-2.0',
    prompt: 'poster',
    signal: new AbortController().signal,
    fetchFn,
    ...over,
  });

describe('normalizeImageGenerationBaseUrl', () => {
  it('accepts a user-configured HTTPS endpoint', () => {
    expect(
      normalizeImageGenerationBaseUrl('https://images.example.com/api/v1/'),
    ).toBe('https://images.example.com/api/v1');
  });

  it('accepts a full multimodal generation endpoint', () => {
    const endpoint =
      'https://gateway.example.com/api/v1/services/aigc/multimodal-generation/generation';
    expect(normalizeImageGenerationBaseUrl(endpoint)).toBe(endpoint);
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
    const fetchFn = fetchSeq(
      typed(
        dashscope('https://cdn.example.com/generated/image.png', 'request-1'),
      ),
      pngResponse(),
    );

    const result = await run(fetchFn, {
      prompt: 'A Qwen Code poster',
      size: '1536*864',
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
        messages: [{ role: 'user', content: [{ text: 'A Qwen Code poster' }] }],
      },
      parameters: {
        n: 1,
        prompt_extend: true,
        size: '1536*864',
        watermark: false,
      },
    });
  });

  it('uses the MiniMax image generation schema for regional base URLs', async () => {
    const fetchFn = fetchSeq(
      typed({
        base_resp: { request_id: 'request-3', status_code: 0 },
        data: { image_urls: ['https://cdn.example.com/generated/mm.png'] },
        metadata: { success_count: 1, failed_count: 0 },
      }),
      pngResponse(),
    );

    const result = await run(fetchFn, {
      baseUrl: 'https://api.minimax.io/v1',
      model: 'image-01',
      prompt: 'A product card',
      size: '1024*1024',
    });

    expect(result).toEqual({
      bytes: Buffer.from(PNG_BYTES),
      mimeType: 'image/png',
      requestId: 'request-3',
    });
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      'https://api.minimax.io/v1/image_generation',
    );
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'image-01',
      prompt: 'A product card',
      n: 1,
      prompt_optimizer: true,
      response_format: 'url',
      width: 1024,
      height: 1024,
    });
  });

  it('accepts a full MiniMax image generation endpoint', async () => {
    const fetchFn = fetchSeq(
      bare({
        data: { image_urls: ['https://cdn.example.com/generated/mm.png'] },
      }),
      new Response(PNG_BYTES, { status: 200 }),
    );

    await run(fetchFn, {
      baseUrl: 'https://api.minimaxi.com/v1/image_generation',
      model: 'image-01-live',
    });

    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      'https://api.minimaxi.com/v1/image_generation',
    );
  });

  it('decodes MiniMax base64 image responses without downloading', async () => {
    const base64Png = Buffer.from(PNG_BYTES).toString('base64');
    const fetchFn = fetchSeq(
      bare({ data: { image_urls: [`data:image/png;base64,${base64Png}`] } }),
    );

    const result = await run(fetchFn, {
      baseUrl: 'https://api.minimaxi.com/v1',
      model: 'image-01',
    });

    expect(result.bytes).toEqual(Buffer.from(PNG_BYTES));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('surfaces MiniMax application errors returned with HTTP 200', async () => {
    const fetchFn = fetchSeq(
      bare({
        base_resp: { status_code: 1008, status_msg: 'insufficient balance' },
      }),
    );

    await expect(
      run(fetchFn, { baseUrl: 'https://api.minimax.io/v1', model: 'image-01' }),
    ).rejects.toThrow('Image generation failed (1008: insufficient balance).');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('pins the validated result hostname for the download connection', async () => {
    const lookup = vi.fn();
    networkPolicyMocks.resolveNetworkTarget.mockResolvedValueOnce({
      url: new URL('https://cdn.example.com/generated/image.png'),
      lookup,
    });
    const fetchFn = fetchSeq(
      bare(dashscope('https://cdn.example.com/generated/image.png')),
      new Response(PNG_BYTES, { status: 200 }),
    );

    await run(fetchFn);

    expect(fetchFn.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ dispatcher: expect.anything() }),
    );
  });

  it('reports throttling without attempting a download', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      typed(
        {
          code: 'Throttling',
          message: 'Requests rate limit exceeded',
          request_id: 'request-2',
        },
        429,
      ),
    );

    await expect(run(fetchFn)).rejects.toThrow(/rate limit/i);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects an unsafe result URL before downloading it', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(typed(dashscope('http://127.0.0.1/private.png')));

    await expect(run(fetchFn)).rejects.toThrow(/safe public HTTPS/i);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects a result hostname that resolves to a blocked address', async () => {
    networkPolicyMocks.resolveNetworkTarget.mockRejectedValueOnce(
      new Error('host resolved to 169.254.169.254'),
    );
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        typed(dashscope('https://images.example.com/private.png')),
      );

    await expect(run(fetchFn)).rejects.toThrow(/safe public HTTPS/i);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => Response, RegExp]>([
    [
      'rejects a download that is not a PNG image',
      () =>
        new Response('not an image', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      /valid PNG/i,
    ],
    [
      'rejects a download with only a partial PNG signature',
      () => pngResponse(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])),
      /valid PNG/i,
    ],
    [
      'rejects an image response above the download byte limit',
      () =>
        new Response(null, {
          status: 200,
          headers: {
            'content-length': String(10 * 1024 * 1024 + 1),
            'content-type': 'image/png',
          },
        }),
      /byte limit/i,
    ],
  ])('%s', async (_title, download, error) => {
    const fetchFn = fetchSeq(typed(dashscope(CDN_IMAGE)), download());

    await expect(run(fetchFn)).rejects.toThrow(error);
  });

  const signedUrl = `${CDN_IMAGE}?signature=temporary-secret`;

  /** The download failure is reported without the signed URL. */
  async function expectSignedUrlHidden(download: Response | Error) {
    const request = run(fetchSeq(typed(dashscope(signedUrl)), download));

    await expect(request).rejects.toThrow(
      'Generated image download failed before completion.',
    );
    await expect(request).rejects.not.toThrow(signedUrl);
  }

  it('does not expose a signed result URL when its download fails', () =>
    expectSignedUrlHidden(new Error(`Failed to fetch ${signedUrl}`)));

  it('does not expose a signed result URL when its response stream fails', () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(`Failed to read ${signedUrl}`));
      },
    });
    return expectSignedUrlHidden(new Response(body, { status: 200 }));
  });
});

describe('generateImage redirect handling', () => {
  const dashscopeResult = () =>
    bare(dashscope('https://api.example.com/image.png'));

  it('follows a valid 302 → 200 redirect chain and returns the PNG', async () => {
    const fetchFn = fetchSeq(
      dashscopeResult(),
      redirect('https://cdn.example.com/final.png'),
      pngResponse(),
    );

    const result = await run(fetchFn);

    expect(result.bytes).toEqual(Buffer.from(PNG_BYTES));
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('rejects when redirects exceed the maximum allowed', async () => {
    const fetchFn = fetchSeq(
      dashscopeResult(),
      // MAX_DOWNLOAD_REDIRECTS + 1 consecutive redirects
      ...Array.from({ length: 4 }, () =>
        redirect('https://cdn.example.com/next.png'),
      ),
    );

    await expect(run(fetchFn)).rejects.toThrow(/exceeded.*redirects/i);
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

    await expect(run(fetchFn)).rejects.toThrow(/HTTP 502/);
  });
});
