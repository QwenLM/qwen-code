/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedDingtalkDeps } from './managed-dingtalk-deps.js';
import { DINGTALK_MAX_CHUNK_LENGTH, splitChunks } from './markdown.js';

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

  it('a definitive refusal after a delivered chunk is unknown, not rejected (R10-2)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ errcode: 0 }))
      .mockResolvedValueOnce(jsonResponse({ errcode: 310000 }));
    vi.stubGlobal('fetch', fetchMock);
    const { sendWebhook } = createManagedDingtalkDeps();
    const text = 'x'.repeat(4_000); // two provider chunks
    // The first chunk reached the user, so the segment is partially delivered:
    // it must settle unknown (re-drivable), never rejected (recorded as never
    // sent, then re-sent in full by the resend path).
    await expect(sendWebhook(WEBHOOK, text)).rejects.toMatchObject({
      definitive: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it('destroys the proxy dispatcher on a failed send too (R12)', async () => {
    const { EnvHttpProxyAgent } = await import('undici');
    const destroySpy = vi
      .spyOn(EnvHttpProxyAgent.prototype, 'destroy')
      .mockResolvedValue(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection dropped');
      }),
    );
    const { sendWebhook } = createManagedDingtalkDeps(
      'http://proxy.internal:8080',
    );
    // The leaking path is the failure path: the finally must run even when
    // the send throws, or every failed send strands a dispatcher.
    await expect(sendWebhook(WEBHOOK, 'hello')).rejects.toMatchObject({
      definitive: false,
    });
    expect(destroySpy).toHaveBeenCalledTimes(1);
    destroySpy.mockRestore();
  });

  it('constructs the dispatcher from the default namespace, as the bundled CJS interop exposes it (R6-1)', async () => {
    // In the bundled CLI a dynamic import of the CJS undici package is
    // default-only; a named destructure binds undefined and throws before the
    // POST. Simulate that shape so reverting to the named destructure reds.
    vi.resetModules();
    vi.doMock('undici', () => ({
      default: {
        EnvHttpProxyAgent: class {
          async destroy() {}
        },
      },
    }));
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ errcode: 0 }));
      vi.stubGlobal('fetch', fetchMock);
      const fresh = await import('./managed-dingtalk-deps.js');
      const { sendWebhook } = fresh.createManagedDingtalkDeps(
        'http://proxy.internal:8080',
      );
      await expect(sendWebhook(WEBHOOK, 'hello')).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const init = fetchMock.mock.calls[0]![1] as { dispatcher?: unknown };
      expect(init.dispatcher).toBeDefined();
    } finally {
      vi.doUnmock('undici');
      vi.resetModules();
    }
  });
});

describe('managed DingTalk webhook send budget (#17173 R12)', () => {
  it('a stalled body is aborted at the 30s budget, not wedged forever', async () => {
    vi.useFakeTimers();
    try {
      // Headers arrive, the body never does: the read must be torn down by
      // the send budget, and the outcome is unknown (the provider may have
      // received the message), never a hang.
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async (_url: string, init: { signal: AbortSignal }) =>
            new Response(
              new ReadableStream({
                start(controller) {
                  init.signal.addEventListener('abort', () =>
                    controller.error(new Error('aborted')),
                  );
                },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        ),
      );
      const { sendWebhook } = createManagedDingtalkDeps();
      let settled = false;
      const sending = sendWebhook(WEBHOOK, 'hello').then(
        () => {
          settled = true;
        },
        (error) => {
          settled = true;
          throw error;
        },
      );
      const assertion = expect(sending).rejects.toMatchObject({
        definitive: false,
      });
      await vi.advanceTimersByTimeAsync(29_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the budget is armed before the fetch, so a stalled header wait aborts too', async () => {
    vi.useFakeTimers();
    try {
      // No response at all: the budget must already be armed when fetch is
      // called. Arming it only around the body read would hang here.
      const fetchMock = vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const { sendWebhook } = createManagedDingtalkDeps();
      let settled = false;
      const sending = sendWebhook(WEBHOOK, 'hello').then(
        () => {
          settled = true;
        },
        (error) => {
          settled = true;
          throw error;
        },
      );
      const assertion = expect(sending).rejects.toMatchObject({
        definitive: false,
      });
      await vi.advanceTimersByTimeAsync(29_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('managed DingTalk webhook per-chunk send budget (#17173 R10)', () => {
  // Headers arrive, the body never does: only the chunk's own budget can tear
  // this read down.
  const stalledBody = (signal: AbortSignal): Response =>
    new Response(
      new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () =>
            controller.error(new Error('aborted')),
          );
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  it("a slow first chunk does not spend the second chunk's budget", async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const fetchMock = vi.fn(
        async (_url: string, init: { signal: AbortSignal }) => {
          call += 1;
          if (call > 1) return stalledBody(init.signal);
          // Slow but progressing: the first chunk's body lands at 25s.
          return new Response(
            new ReadableStream({
              start(controller) {
                setTimeout(() => {
                  controller.enqueue(
                    new TextEncoder().encode(JSON.stringify({ errcode: 0 })),
                  );
                  controller.close();
                }, 25_000);
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        },
      );
      vi.stubGlobal('fetch', fetchMock);
      const { sendWebhook } = createManagedDingtalkDeps();
      let settled = false;
      const sending = sendWebhook(WEBHOOK, 'x'.repeat(4_000)).then(
        () => {
          settled = true;
        },
        (error) => {
          settled = true;
          throw error;
        },
      );
      const assertion = expect(sending).rejects.toMatchObject({
        definitive: false,
        message: expect.stringContaining('body read timed out'),
      });
      await vi.advanceTimersByTimeAsync(25_000);
      expect(fetchMock).toHaveBeenCalledTimes(2); // chunk 1 delivered, chunk 2 sent
      expect(settled).toBe(false);
      // One shared budget would abort here, 5s into the second chunk, and
      // settle the tail unknown while the provider was still answering.
      await vi.advanceTimersByTimeAsync(29_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000); // 55s: chunk 2's own 30s budget
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a slow-but-progressing multi-chunk send completes past the shared 30s wall', async () => {
    vi.useFakeTimers();
    try {
      const text = 'x'.repeat(8_000);
      const chunks = splitChunks(text);
      expect(chunks.length).toBeGreaterThanOrEqual(3);
      // A real fetch rejects on abort; a mock that ignored the signal would
      // let a shared budget pass this witness unnoticed.
      const fetchMock = vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(
              () => resolve(jsonResponse({ errcode: 0 })),
              20_000,
            );
            init.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            });
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const { sendWebhook } = createManagedDingtalkDeps();
      let settled = false;
      let failure: unknown;
      const sending = sendWebhook(WEBHOOK, text).then(
        () => {
          settled = true;
        },
        (error) => {
          settled = true;
          failure = error;
        },
      );
      await vi.advanceTimersByTimeAsync(30_000);
      // The old shared wall: a batch that is still progressing must not be
      // aborted here, and the tail chunks must still be sent.
      expect(settled).toBe(false);
      expect(fetchMock.mock.calls.length).toBeLessThan(chunks.length);
      await vi.advanceTimersByTimeAsync(chunks.length * 20_000 - 30_000);
      await sending;
      expect(failure).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(chunks.length);
      // Every chunk's budget timer is cleared when that chunk settles; the
      // last one would still be pending here if the clear were dropped.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('managed DingTalk webhook segment ceiling (#17504 R1-1)', () => {
  it('a heading-dense segment progressing just under each chunk budget ends at the ceiling, not at chunk count × 30s', async () => {
    vi.useFakeTimers();
    try {
      // Heading-dense markdown packs ~2000 units per chunk, so a 48 KiB
      // segment becomes 24 chunks — 12 minutes at one 30s budget each, past
      // the control plane's 10-minute claim lease.
      let text = '';
      while (text.length < 48 * 1024 - 200) {
        text += `#### h${text.length}\n`;
      }
      const chunks = splitChunks(text);
      expect(chunks.length).toBe(24);
      // Each chunk answers at 29s: no per-chunk timer ever fires, so only an
      // aggregate ceiling can end this batch. 24 × 29s = 696s, past the 600s
      // lease the ceiling is derived from.
      const fetchMock = vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(
              () => resolve(jsonResponse({ errcode: 0 })),
              29_000,
            );
            init.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            });
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const { sendWebhook } = createManagedDingtalkDeps();
      let settled = false;
      const sending = sendWebhook(WEBHOOK, text).then(
        () => {
          settled = true;
        },
        (error) => {
          settled = true;
          throw error;
        },
      );
      const assertion = expect(sending).rejects.toMatchObject({
        definitive: false,
        message: expect.stringContaining('segment budget'),
      });
      await vi.advanceTimersByTimeAsync(570_000);
      // The ceiling is spent, but chunk 20 is still in flight and keeps its
      // own budget: the ceiling ends the batch between chunks, not mid-request.
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000); // 580s: chunk 20 lands, chunk 21 refused
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(20);
      expect(fetchMock.mock.calls.length).toBeLessThan(chunks.length);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the ceiling is a time bound, not a chunk count: a fast heading-dense segment delivers every chunk', async () => {
    vi.useFakeTimers();
    try {
      let text = '';
      while (text.length < 48 * 1024 - 200) {
        text += `#### h${text.length}\n`;
      }
      const chunks = splitChunks(text);
      expect(chunks.length).toBeGreaterThan(11);
      const fetchMock = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return jsonResponse({ errcode: 0 });
      });
      vi.stubGlobal('fetch', fetchMock);
      const { sendWebhook } = createManagedDingtalkDeps();
      let failure: unknown;
      const sending = sendWebhook(WEBHOOK, text).then(
        () => undefined,
        (error) => {
          failure = error;
        },
      );
      // 24 chunks at 1s each is 24s — far inside the ceiling. A chunk-count
      // cap masquerading as a time bound would truncate this healthy reply.
      await vi.advanceTimersByTimeAsync(chunks.length * 1_000);
      await sending;
      expect(failure).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(chunks.length);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([15_000, 20_000])(
    'a 24-chunk segment at %i ms per chunk finishes inside the lease and delivers every chunk',
    async (latency) => {
      vi.useFakeTimers();
      try {
        let text = '';
        while (text.length < 48 * 1024 - 200) {
          text += `#### h${text.length}\n`;
        }
        const chunks = splitChunks(text);
        expect(chunks.length).toBe(24);
        const fetchMock = vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, latency));
          return jsonResponse({ errcode: 0 });
        });
        vi.stubGlobal('fetch', fetchMock);
        const { sendWebhook } = createManagedDingtalkDeps();
        let failure: unknown;
        const sending = sendWebhook(WEBHOOK, text).then(
          () => undefined,
          (error) => {
            failure = error;
          },
        );
        // 360s and 480s: both inside the 600s lease, so the whole segment
        // would have been delivered and accepted without any ceiling. An
        // unknown segment is never resent, so a ceiling that cuts here loses
        // the tail for good — the bound must sit at the lease, not below it.
        expect(chunks.length * latency).toBeLessThan(600_000);
        await vi.advanceTimersByTimeAsync(chunks.length * latency);
        await sending;
        expect(failure).toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(chunks.length);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
