/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyProbeResponse,
  probeImageSupport,
  RED_PNG_DATA_URL,
} from './probe.js';

describe('classifyProbeResponse', () => {
  it('accepts an image-bearing 200 as image', () => {
    expect(classifyProbeResponse(200, '')).toEqual('image');
  });

  it('classifies modality-semantic errors as text_only', () => {
    expect(
      classifyProbeResponse(
        400,
        JSON.stringify({
          error: { message: 'This model does not support image' },
        }),
      ),
    ).toEqual('text_only');
    expect(
      classifyProbeResponse(
        400,
        JSON.stringify({
          error: {
            code: '1210',
            message: "messages.content.type 参数非法，取值范围 ['text']",
          },
        }),
      ),
    ).toEqual('text_only');
    expect(
      classifyProbeResponse(
        404,
        JSON.stringify({
          error: { message: 'No endpoints found that support image input' },
        }),
      ),
    ).toEqual('text_only');
    expect(
      classifyProbeResponse(
        400,
        JSON.stringify({
          error: 'this model does not support image input (ref: 9eb0a003)',
        }),
      ),
    ).toEqual('text_only');
    expect(
      classifyProbeResponse(
        400,
        JSON.stringify({ error: { message: '当前模型不支持图片输入' } }),
      ),
    ).toEqual('text_only');
    expect(
      classifyProbeResponse(
        400,
        JSON.stringify({ error: { message: '该模型不支持图像理解' } }),
      ),
    ).toEqual('text_only');
  });

  it('abstains on region-unsupported errors despite "not supported" phrasing', () => {
    // Objectless "not supported" is entitlement/region vocabulary, not a
    // modality rejection — a wrong text_only here would be persisted with no
    // re-probe escape hatch in phase 1.
    expect(
      classifyProbeResponse(
        403,
        JSON.stringify({
          error: { message: 'Model o1 is not supported in your region' },
        }),
      ),
    ).toEqual('unknown');
  });

  it('abstains on Chinese region-unsupported errors despite "不支持" phrasing', () => {
    expect(
      classifyProbeResponse(
        400,
        JSON.stringify({ error: { message: '此模型在您的区域不受支持' } }),
      ),
    ).toEqual('unknown');
  });

  it('abstains on non-modality errors', () => {
    expect(
      classifyProbeResponse(401, JSON.stringify({ error: 'Unauthorized' })),
    ).toEqual('unknown');
    expect(
      classifyProbeResponse(
        429,
        JSON.stringify({ error: { message: 'Provider returned error' } }),
      ),
    ).toEqual('unknown');
    expect(classifyProbeResponse(-1, 'TimeoutError: timeout')).toEqual(
      'unknown',
    );
    expect(
      classifyProbeResponse(
        400,
        JSON.stringify({ error: { message: 'invalid model id' } }),
      ),
    ).toEqual('unknown');
  });

  it('abstains on 5xx bodies that merely mention multimodal in tracebacks', () => {
    expect(
      classifyProbeResponse(
        500,
        JSON.stringify({
          error: {
            message: 'Traceback ... File "/vllm/multimodal/utils.py", line 42',
          },
        }),
      ),
    ).toEqual('unknown');
  });
});

describe('probeImageSupport', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends image_url to the chat completions endpoint and returns the verdict', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await probeImageSupport({
      model: 'm1',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
    });
    expect(result.verdict).toEqual('image');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toEqual('https://api.example.com/v1/chat/completions');
    expect(init.method).toEqual('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toEqual(
      'application/json',
    );
    expect((init.headers as Record<string, string>)['Authorization']).toEqual(
      'Bearer sk-test',
    );
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{
        content: Array<{ type: string; image_url?: { url: string } }>;
      }>;
      max_tokens: number;
    };
    expect(
      body.messages[0]!.content.some(
        (p) => p.type === 'image_url' && p.image_url!.url === RED_PNG_DATA_URL,
      ),
    ).toBe(true);
    expect(body.max_tokens).toBeLessThanOrEqual(32);
  });

  it('normalizes a trailing slash in baseUrl', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await probeImageSupport({
      model: 'm1',
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'k',
    });
    expect(result.verdict).toEqual('image');
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toEqual('https://api.example.com/v1/chat/completions');
  });

  it('maps endpoint errors to the three-state verdict without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { message: 'This model does not support image' },
          }),
          { status: 400 },
        ),
      ),
    );
    const result = await probeImageSupport({
      model: 'm1',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'k',
    });
    expect(result.verdict).toEqual('text_only');
    expect(result.httpStatus).toEqual(400);
  });

  it('returns unknown on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    const result = await probeImageSupport({
      model: 'm1',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'k',
    });
    expect(result.verdict).toEqual('unknown');
  });
});
