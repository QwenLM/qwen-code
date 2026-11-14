/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedDingtalkDeps } from './managed-dingtalk-deps.js';
import { DINGTALK_MAX_CHUNK_LENGTH } from './markdown.js';

const WEBHOOK = 'https://oapi.dingtalk.com/robot/sendBySession?session=abc';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('managed DingTalk webhook classifier', () => {
  it('resolves on a zero errcode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ errcode: 0 })),
    );
    const { sendWebhook } = createManagedDingtalkDeps();
    await expect(sendWebhook(WEBHOOK, 'hello')).resolves.toBeUndefined();
  });

  it('classifies a non-zero errcode as definitive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ errcode: 310000, errmsg: 'expired' })),
    );
    const { sendWebhook } = createManagedDingtalkDeps();
    await expect(sendWebhook(WEBHOOK, 'hello')).rejects.toMatchObject({
      definitive: true,
    });
  });

  it('classifies a 4xx refusal as definitive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 403)),
    );
    const { sendWebhook } = createManagedDingtalkDeps();
    await expect(sendWebhook(WEBHOOK, 'hello')).rejects.toMatchObject({
      definitive: true,
    });
  });

  it('classifies a 5xx failure as non-definitive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 500)),
    );
    const { sendWebhook } = createManagedDingtalkDeps();
    await expect(sendWebhook(WEBHOOK, 'hello')).rejects.toMatchObject({
      definitive: false,
    });
  });

  it('classifies a network failure as non-definitive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection dropped');
      }),
    );
    const { sendWebhook } = createManagedDingtalkDeps();
    await expect(sendWebhook(WEBHOOK, 'hello')).rejects.toMatchObject({
      definitive: false,
    });
  });
});

describe('managed DingTalk webhook chunking', () => {
  it('splits an over-long segment into provider-sized chunks in order', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ errcode: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    const { sendWebhook } = createManagedDingtalkDeps();
    const text = 'x'.repeat(DINGTALK_MAX_CHUNK_LENGTH + 5_000);
    await sendWebhook(WEBHOOK, text);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    const contents = fetchMock.mock.calls.map((call) => {
      const init = call[1] as { body: string };
      return (JSON.parse(init.body) as { text: { content: string } }).text
        .content;
    });
    for (const content of contents) {
      expect(content.length).toBeLessThanOrEqual(DINGTALK_MAX_CHUNK_LENGTH);
    }
    expect(contents.join('')).toBe(text);
  });

  it('a definitive chunk refusal stops the remaining chunks', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ errcode: 310000 }))
      .mockResolvedValue(jsonResponse({ errcode: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    const { sendWebhook } = createManagedDingtalkDeps();
    const text = 'x'.repeat(DINGTALK_MAX_CHUNK_LENGTH + 5_000);
    await expect(sendWebhook(WEBHOOK, text)).rejects.toMatchObject({
      definitive: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('managed DingTalk webhook verdict honesty (R2-2)', () => {
  it('a 200 with an unreadable body is unknown, not accepted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('<html>proxy blocked</html>', { status: 200 }),
      ),
    );
    const { sendWebhook } = createManagedDingtalkDeps();
    await expect(sendWebhook(WEBHOOK, 'hello')).rejects.toMatchObject({
      definitive: false,
    });
  });

  it('a 200 with an empty body is unknown, not accepted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 200 })),
    );
    const { sendWebhook } = createManagedDingtalkDeps();
    await expect(sendWebhook(WEBHOOK, 'hello')).rejects.toMatchObject({
      definitive: false,
    });
  });

  it('a 200 with a string errcode is unknown, not accepted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ errcode: '310000' })),
    );
    const { sendWebhook } = createManagedDingtalkDeps();
    await expect(sendWebhook(WEBHOOK, 'hello')).rejects.toMatchObject({
      definitive: false,
    });
  });
});

describe('managed DingTalk webhook transient verdicts (R2-3)', () => {
  it.each([
    { errcode: 410100 },
    { errcode: -1 },
    { errcode: 130101 },
    { errcode: 88 },
  ])('errcode $errcode is transient (non-definitive)', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(body)),
    );
    const { sendWebhook } = createManagedDingtalkDeps();
    await expect(sendWebhook(WEBHOOK, 'hello')).rejects.toMatchObject({
      definitive: false,
    });
  });

  it.each([429, 408, 425])(
    'HTTP %i is retryable (non-definitive)',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({}, status)),
      );
      const { sendWebhook } = createManagedDingtalkDeps();
      await expect(sendWebhook(WEBHOOK, 'hello')).rejects.toMatchObject({
        definitive: false,
      });
    },
  );

  it('HTTP 403 stays definitive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 403)),
    );
    const { sendWebhook } = createManagedDingtalkDeps();
    await expect(sendWebhook(WEBHOOK, 'hello')).rejects.toMatchObject({
      definitive: true,
    });
  });

  it('a permanent errcode stays definitive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ errcode: 310000 })),
    );
    const { sendWebhook } = createManagedDingtalkDeps();
    await expect(sendWebhook(WEBHOOK, 'hello')).rejects.toMatchObject({
      definitive: true,
    });
  });
});

describe('managed DingTalk webhook URL validation (R4-7)', () => {
  it.each([
    'http://evil.example/hook',
    'https://evil.example/hook',
    'https://oapi.dingtalk.com:8443/robot/sendBySession',
    'not-a-url',
  ])('rejects %s without fetching', async (url) => {
    const fetchMock = vi.fn(async () => jsonResponse({ errcode: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    const { sendWebhook } = createManagedDingtalkDeps();
    await expect(sendWebhook(url, 'hello')).rejects.toMatchObject({
      definitive: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('admits the provider sessionWebhook host', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ errcode: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    const { sendWebhook } = createManagedDingtalkDeps();
    await expect(sendWebhook(WEBHOOK, 'hello')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('managed DingTalk webhook proxy (R6-1)', () => {
  it('carries a proxy dispatcher on the request when a proxy is configured', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ errcode: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    const { sendWebhook } = createManagedDingtalkDeps(
      'http://proxy.internal:8080',
    );
    await sendWebhook(WEBHOOK, 'hello');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBeDefined();
  });

  it('sends without a dispatcher when no proxy is configured', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ errcode: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    const { sendWebhook } = createManagedDingtalkDeps();
    await sendWebhook(WEBHOOK, 'hello');
    const init = fetchMock.mock.calls[0]![1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBeUndefined();
  });

  it('destroys the proxy dispatcher after the send so it never leaks', async () => {
    const { EnvHttpProxyAgent } = await import('undici');
    const destroySpy = vi
      .spyOn(EnvHttpProxyAgent.prototype, 'destroy')
      .mockResolvedValue(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ errcode: 0 })),
    );
    const { sendWebhook } = createManagedDingtalkDeps(
      'http://proxy.internal:8080',
    );
    await sendWebhook(WEBHOOK, 'hello');
    expect(destroySpy).toHaveBeenCalledTimes(1);
    destroySpy.mockRestore();
  });
});
