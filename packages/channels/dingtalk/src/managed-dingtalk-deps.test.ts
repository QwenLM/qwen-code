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
