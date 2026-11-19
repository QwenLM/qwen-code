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

// A fetch double that answers after a fixed delay and rejects on abort, like a
// real fetch. The abort listener is load-bearing: a double that resolved on
// abort would let a shared budget truncate the tail on the wire while every
// assertion here still passed. Shared so the two witnesses that depend on it
// cannot drift apart.
const latencyFetch = (latencyMs: number) =>
  vi.fn(
    (_url: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(jsonResponse({ errcode: 0 })),
          latencyMs,
        );
        init.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      }),
  );

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
      const fetchMock = latencyFetch(20_000);
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

describe('managed DingTalk webhook sends are never truncated (#17529 R2-1)', () => {
  // Two real fixtures at the 48 KiB segment bound: heading-dense text packs
  // ~2000 units per chunk (24), paragraphs sized just over half the 3800-unit
  // target fit one per chunk (25, 47548 bytes). The counts are lower bounds,
  // not equalities — the reachable count keeps moving with the packing (a
  // heading-band sweep reaches 42, and the admission predicate allows 52), so
  // pinning an exact split would red these rows for a splitter change rather
  // than for truncation. Coverage of the whole band does not rest on them: the
  // splitter-independent witness below drives more chunks than the splitter
  // can admit, so any ceiling that could fire on a real segment reds it.
  //
  // Every row must deliver all of its chunks: a send that outlives the claim
  // lease is reconciled to unknown, but a late receipt moves unknown → partial
  // → delivered, so the ledger converges while the tail keeps arriving;
  // refusing the tail strands it instead (#17529 has the trace).
  it.each([
    { shape: 'heading', want: 24, latency: 1_000 },
    { shape: 'heading', want: 24, latency: 15_000 },
    { shape: 'heading', want: 24, latency: 20_000 },
    { shape: 'heading', want: 24, latency: 24_500 },
    { shape: 'heading', want: 24, latency: 25_000 },
    { shape: 'heading', want: 24, latency: 29_000 },
    { shape: 'heading', want: 24, latency: 29_999 },
    { shape: 'paragraph', want: 25, latency: 29_999 },
  ])(
    'a $shape segment of at least $want chunks at $latency ms per chunk delivers every chunk',
    async ({ shape, want, latency }) => {
      vi.useFakeTimers();
      try {
        let text: string;
        if (shape === 'paragraph') {
          // 25 paragraphs of 1900 units: two would exceed the 3800-unit target,
          // so each chunk carries exactly one. 47548 bytes, inside the bound.
          text = Array.from({ length: 25 }, () => 'x'.repeat(1_900)).join(
            '\n\n',
          );
        } else {
          text = '';
          while (text.length < 48 * 1024 - 200) {
            text += `#### h${text.length}\n`;
          }
        }
        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(48 * 1024);
        const chunks = splitChunks(text);
        // A lower bound, not an equality: the row must sit in its band, but a
        // legitimate packing change that yields more chunks must not red a
        // witness about truncation with a message about the splitter.
        expect(chunks.length).toBeGreaterThanOrEqual(want);
        const fetchMock = latencyFetch(latency);
        vi.stubGlobal('fetch', fetchMock);
        const { sendWebhook } = createManagedDingtalkDeps();
        let failure: unknown;
        const sending = sendWebhook(WEBHOOK, text).then(
          () => undefined,
          (error) => {
            failure = error;
          },
        );
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

  it('delivers every chunk for any chunk count, past the splitter admission bound', async () => {
    // The rows above are real fixtures, so they can only certify the band those
    // fixtures reach — and the reachable count keeps moving with the packing
    // (24 heading, 25 paragraph, 42 by a heading-band sweep; the admission
    // predicate allows 52). This witness removes the fixture from the loop:
    // drive the send with more chunks than the splitter can admit at the
    // segment bound, so no aggregate ceiling that could ever fire on a real
    // segment can survive it, and a packing change cannot red it either.
    const count = 60; // > 4 * ceil(49152 / 3800) = 52
    const latency = 29_999; // inside the per-chunk budget, so only a ceiling cuts
    vi.useFakeTimers();
    vi.resetModules();
    vi.doMock('./markdown.js', async () => {
      const actual =
        await vi.importActual<typeof import('./markdown.js')>('./markdown.js');
      return {
        ...actual,
        splitChunks: () =>
          Array.from({ length: count }, (_, i) => `chunk-${i}`),
      };
    });
    try {
      const fresh = await import('./managed-dingtalk-deps.js');
      const fetchMock = latencyFetch(latency);
      vi.stubGlobal('fetch', fetchMock);
      const { sendWebhook } = fresh.createManagedDingtalkDeps();
      let failure: unknown;
      const sending = sendWebhook(WEBHOOK, 'segment').then(
        () => undefined,
        (error) => {
          failure = error;
        },
      );
      // 60 × 29999ms = 1799940ms, past 52 × 30s = 1560s — the longest a real
      // segment could ever take.
      await vi.advanceTimersByTimeAsync(count * latency);
      await sending;
      expect(failure).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(count);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.doUnmock('./markdown.js');
      vi.resetModules();
      vi.useRealTimers();
    }
  });
});

describe('managed DingTalk card transport (H5e, #17716)', () => {
  const CREDS = { clientId: 'robot-app', clientSecret: 'secret' };
  const CARD_INPUT = {
    outTrackId: 'ot-1',
    templateId: 'tpl.schema',
    target: { chatId: 'user-1', isGroup: false },
    body: 'hello',
    create: true,
  };
  const TOKEN_PREFIX = 'https://oapi.dingtalk.com/gettoken';

  function cardRoutes(
    overrides: {
      token?: () => Response;
      card?: (url: string, init?: RequestInit) => Response;
    } = {},
  ) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      if (url.startsWith(TOKEN_PREFIX)) {
        return (
          overrides.token?.() ??
          jsonResponse({ access_token: 'tok-1', expires_in: 7200 })
        );
      }
      return (
        overrides.card?.(url, init) ??
        jsonResponse({ result: { deliverResults: [{ success: true }] } })
      );
    });
    return { fetchMock, calls };
  }

  const cardCallOf = (
    calls: Array<{ url: string; init: RequestInit }>,
    suffix: string,
  ) => calls.find((call) => call.url.endsWith(suffix))!;
  const tokenCallsOf = (calls: Array<{ url: string }>) =>
    calls.filter((call) => call.url.startsWith(TOKEN_PREFIX));

  it('B1 creates and delivers a card to the sender IM_ROBOT space with a token', async () => {
    const { fetchMock, calls } = cardRoutes();
    vi.stubGlobal('fetch', fetchMock);
    const deps = createManagedDingtalkDeps(undefined, CREDS);
    await deps.sendCardSegment!(CARD_INPUT);
    const card = cardCallOf(calls, '/v1.0/card/instances/createAndDeliver');
    expect(card.init.method).toBe('POST');
    expect(JSON.parse(String(card.init.body))).toMatchObject({
      cardTemplateId: 'tpl.schema',
      outTrackId: 'ot-1',
      openSpaceId: 'dtv1.card//IM_ROBOT.user-1',
      cardData: { cardParamMap: { content: 'hello' } },
      imRobotOpenDeliverModel: {
        spaceType: 'IM_ROBOT',
        robotCode: 'robot-app',
      },
    });
    expect(
      (card.init.headers as Record<string, string>)[
        'x-acs-dingtalk-access-token'
      ],
    ).toBe('tok-1');
    const token = tokenCallsOf(calls)[0]!;
    expect(token.url).toContain('appkey=robot-app');
    expect(token.url).toContain('appsecret=secret');
  });

  it('B2 edits the card with a full-snapshot updateInstance', async () => {
    const { fetchMock, calls } = cardRoutes();
    vi.stubGlobal('fetch', fetchMock);
    const deps = createManagedDingtalkDeps(undefined, CREDS);
    await deps.sendCardSegment!({ ...CARD_INPUT, create: false });
    const card = cardCallOf(calls, '/v1.0/card/instances');
    expect(card.init.method).toBe('PUT');
    expect(JSON.parse(String(card.init.body))).toMatchObject({
      outTrackId: 'ot-1',
      cardData: { cardParamMap: { content: 'hello' } },
      cardUpdateOptions: { updateCardDataByKey: true },
    });
  });

  it('B3 caches the access token across card calls', async () => {
    const { fetchMock, calls } = cardRoutes();
    vi.stubGlobal('fetch', fetchMock);
    const deps = createManagedDingtalkDeps(undefined, CREDS);
    await deps.sendCardSegment!(CARD_INPUT);
    await deps.sendCardSegment!({ ...CARD_INPUT, create: false });
    expect(tokenCallsOf(calls)).toHaveLength(1);
  });

  it('B4 invalidates the token and retries once on a 401', async () => {
    let cardHits = 0;
    const { fetchMock, calls } = cardRoutes({
      card: () => {
        cardHits += 1;
        return cardHits === 1
          ? jsonResponse({}, 401)
          : jsonResponse({ result: { deliverResults: [{ success: true }] } });
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const deps = createManagedDingtalkDeps(undefined, CREDS);
    await deps.sendCardSegment!(CARD_INPUT);
    expect(cardHits).toBe(2);
    expect(tokenCallsOf(calls)).toHaveLength(2);
  });

  it('B5 classifies a permanent token errcode as definitive', async () => {
    const { fetchMock } = cardRoutes({
      token: () => jsonResponse({ errcode: 40001, errmsg: 'invalid appkey' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const deps = createManagedDingtalkDeps(undefined, CREDS);
    await expect(deps.sendCardSegment!(CARD_INPUT)).rejects.toMatchObject({
      definitive: true,
    });
  });

  it('B6 classifies a transient token errcode as ambiguous', async () => {
    const { fetchMock } = cardRoutes({
      token: () => jsonResponse({ errcode: -1, errmsg: 'system busy' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const deps = createManagedDingtalkDeps(undefined, CREDS);
    await expect(deps.sendCardSegment!(CARD_INPUT)).rejects.toMatchObject({
      definitive: false,
    });
  });

  it('B7 classifies card HTTP statuses by retryability', async () => {
    for (const [status, definitive] of [
      [429, false],
      [500, false],
      [400, true],
      [403, true],
    ] as const) {
      const { fetchMock } = cardRoutes({
        card: () => jsonResponse({}, status),
      });
      vi.stubGlobal('fetch', fetchMock);
      const deps = createManagedDingtalkDeps(undefined, CREDS);
      await expect(deps.sendCardSegment!(CARD_INPUT)).rejects.toMatchObject({
        definitive,
      });
      vi.unstubAllGlobals();
    }
  });

  it('B8 classifies a network failure as ambiguous', async () => {
    const { fetchMock } = cardRoutes({
      card: () => {
        throw new Error('connection reset');
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const deps = createManagedDingtalkDeps(undefined, CREDS);
    await expect(deps.sendCardSegment!(CARD_INPUT)).rejects.toMatchObject({
      definitive: false,
    });
  });

  it('B9 routes token and card calls through the proxy dispatcher and destroys it', async () => {
    const { EnvHttpProxyAgent } = await import('undici');
    const destroySpy = vi
      .spyOn(EnvHttpProxyAgent.prototype, 'destroy')
      .mockResolvedValue(undefined);
    const { fetchMock } = cardRoutes();
    vi.stubGlobal('fetch', fetchMock);
    const deps = createManagedDingtalkDeps('http://proxy.internal:8080', CREDS);
    await deps.sendCardSegment!(CARD_INPUT);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as { dispatcher?: unknown }).dispatcher).toBeDefined();
    }
    expect(destroySpy).toHaveBeenCalledTimes(fetchMock.mock.calls.length);
    destroySpy.mockRestore();
  });

  it('B10 classifies a failed deliverResult as definitive', async () => {
    const { fetchMock } = cardRoutes({
      card: () =>
        jsonResponse({
          result: {
            deliverResults: [{ success: false, errorMsg: 'no permission' }],
          },
        }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const deps = createManagedDingtalkDeps(undefined, CREDS);
    await expect(deps.sendCardSegment!(CARD_INPUT)).rejects.toMatchObject({
      definitive: true,
    });
  });

  it('provides no card send when no credential is given', () => {
    vi.stubGlobal('fetch', vi.fn());
    const deps = createManagedDingtalkDeps();
    expect(deps.sendCardSegment).toBeUndefined();
  });

  it('B11 strict: a 200 with an unreadable body is ambiguous, not accepted (R1-2)', async () => {
    const { fetchMock } = cardRoutes({
      card: () => new Response('not json', { status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const deps = createManagedDingtalkDeps(undefined, CREDS);
    await expect(deps.sendCardSegment!(CARD_INPUT)).rejects.toMatchObject({
      definitive: false,
    });
  });

  it('B12 strict: a create answer with no deliverResults is ambiguous (R1-2)', async () => {
    const { fetchMock } = cardRoutes({
      card: () => jsonResponse({ result: {} }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const deps = createManagedDingtalkDeps(undefined, CREDS);
    await expect(deps.sendCardSegment!(CARD_INPUT)).rejects.toMatchObject({
      definitive: false,
    });
  });

  it('B13 strict: a create answer with empty deliverResults is ambiguous (R1-2)', async () => {
    const { fetchMock } = cardRoutes({
      card: () => jsonResponse({ result: { deliverResults: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const deps = createManagedDingtalkDeps(undefined, CREDS);
    await expect(deps.sendCardSegment!(CARD_INPUT)).rejects.toMatchObject({
      definitive: false,
    });
  });

  it('B14 strict: an edit with an unreadable body is ambiguous (R1-2)', async () => {
    const { fetchMock } = cardRoutes({
      card: () => new Response('', { status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const deps = createManagedDingtalkDeps(undefined, CREDS);
    await expect(
      deps.sendCardSegment!({ ...CARD_INPUT, create: false }),
    ).rejects.toMatchObject({ definitive: false });
  });

  it('B15 proxy: the body is consumed before the dispatcher is destroyed (R1-1)', async () => {
    // A streaming body that errors once the dispatcher is destroyed pins the
    // ordering: fetch resolves on headers, so destroying in the finally before
    // the caller reads the body aborts every proxied read (UND_ERR_DESTROYED).
    vi.resetModules();
    vi.doMock('undici', () => ({
      default: {
        EnvHttpProxyAgent: class {
          destroyed = false;
          async destroy() {
            this.destroyed = true;
          }
        },
      },
    }));
    try {
      const fetchDouble = vi.fn(async (url: string, init?: RequestInit) => {
        const dispatcher = (
          init as { dispatcher?: { destroyed?: boolean } } | undefined
        )?.dispatcher;
        const payload = url.startsWith(TOKEN_PREFIX)
          ? JSON.stringify({ access_token: 'tok-1', expires_in: 7200 })
          : JSON.stringify({ result: { deliverResults: [{ success: true }] } });
        // highWaterMark 0: pull only when the body is actually read, not
        // eagerly at construction — otherwise the chunk buffers before the
        // destroy and the ordering regression would not be observable.
        const stream = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (dispatcher?.destroyed) {
                controller.error(new TypeError('terminated'));
                return;
              }
              controller.enqueue(new TextEncoder().encode(payload));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        );
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      vi.stubGlobal('fetch', fetchDouble);
      const fresh = await import('./managed-dingtalk-deps.js');
      const deps = fresh.createManagedDingtalkDeps(
        'http://proxy.internal:8080',
        CREDS,
      );
      await expect(deps.sendCardSegment!(CARD_INPUT)).resolves.toBeUndefined();
      expect(fetchDouble.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.doUnmock('undici');
      vi.resetModules();
    }
  });

  it('B16 token refreshes a minute early, not at expiry (R1-5)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const { fetchMock, calls } = cardRoutes();
      vi.stubGlobal('fetch', fetchMock);
      const deps = createManagedDingtalkDeps(undefined, CREDS);
      await deps.sendCardSegment!(CARD_INPUT);
      expect(tokenCallsOf(calls)).toHaveLength(1);
      // expires_in 7200 → cached until t+7140s; at t+7139s still cached.
      vi.setSystemTime(new Date('2026-01-01T01:58:59Z'));
      await deps.sendCardSegment!({ ...CARD_INPUT, create: false });
      expect(tokenCallsOf(calls)).toHaveLength(1);
      // At t+7141s the early refresh has fired: a second gettoken.
      vi.setSystemTime(new Date('2026-01-01T01:59:01Z'));
      await deps.sendCardSegment!({ ...CARD_INPUT, create: false });
      expect(tokenCallsOf(calls)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('B17 token floor: a short expires_in is not cached already-expired (R1-5)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const { fetchMock, calls } = cardRoutes({
        token: () => jsonResponse({ access_token: 'tok-1', expires_in: 30 }),
      });
      vi.stubGlobal('fetch', fetchMock);
      const deps = createManagedDingtalkDeps(undefined, CREDS);
      await deps.sendCardSegment!(CARD_INPUT);
      // The 60s floor keeps the token cached for an immediate second send;
      // without it, expires_in 30 - 60 caches an already-expired token.
      await deps.sendCardSegment!({ ...CARD_INPUT, create: false });
      expect(tokenCallsOf(calls)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
