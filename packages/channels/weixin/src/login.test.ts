/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLogin, waitForLogin, type WeixinLoginEvent } from './login.js';

const API_BASE = 'https://ilink-bot.example.com';

/**
 * The iLink identity every Bot API request must declare; produced by
 * `buildHeaders()` in api.ts. `X-WECHAT-UIN` is random per call, so the
 * assertions below match partially rather than comparing whole header objects.
 */
const ILINK_IDENTITY = {
  'iLink-App-Id': 'bot',
  'iLink-App-ClientVersion': expect.stringMatching(/^\d+$/),
};

function response(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  };
}

function stubFetch(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(response(body));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** One body per call; the last repeats once the script is exhausted. */
function stubFetchSequence(bodies: unknown[]) {
  let call = 0;
  const fetchMock = vi.fn().mockImplementation(async () => {
    const body = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    return response(body);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('weixin login iLink request headers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('declares the iLink client version when minting the QR code', async () => {
    const fetchMock = stubFetch({
      qrcode: 'qrcode-1',
      qrcode_img_content: 'https://scan.example/qr-1',
    });

    await expect(startLogin(API_BASE)).resolves.toEqual({
      qrcodeId: 'qrcode-1',
      qrcodeUrl: 'https://scan.example/qr-1',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`,
      expect.objectContaining({
        headers: expect.objectContaining(ILINK_IDENTITY),
      }),
    );
  });

  it('returns no qrcodeUrl when the server omits the image content', async () => {
    stubFetch({ qrcode: 'qrcode-1' });

    await expect(startLogin(API_BASE)).resolves.toEqual({
      qrcodeId: 'qrcode-1',
      qrcodeUrl: undefined,
    });
  });

  it('declares the iLink client version when polling the scan status', async () => {
    const fetchMock = stubFetch({
      status: 'confirmed',
      bot_token: 'token-1',
      baseurl: API_BASE,
      ilink_user_id: 'user-1',
    });

    const result = await waitForLogin({
      qrcodeId: 'qrcode-1',
      apiBaseUrl: API_BASE,
      timeoutMs: 1000,
    });

    expect(result.connected).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/ilink/bot/get_qrcode_status?qrcode=qrcode-1`,
      expect.objectContaining({
        headers: expect.objectContaining(ILINK_IDENTITY),
      }),
    );
  });
});

describe('weixin login progress events', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reports a scan and then the confirmed credentials', async () => {
    vi.useFakeTimers();
    stubFetchSequence([
      { status: 'scaned' },
      {
        status: 'confirmed',
        bot_token: 'token-1',
        baseurl: API_BASE,
        ilink_user_id: 'user-1',
      },
    ]);
    const events: WeixinLoginEvent[] = [];

    const pending = waitForLogin({
      qrcodeId: 'qrcode-1',
      apiBaseUrl: API_BASE,
      onEvent: (event) => events.push(event),
    });
    await vi.advanceTimersByTimeAsync(1100);
    const result = await pending;

    expect(events).toEqual([{ type: 'scanned' }]);
    expect(result).toEqual({
      connected: true,
      token: 'token-1',
      baseUrl: API_BASE,
      userId: 'user-1',
      message: 'Connected to WeChat successfully!',
    });
  });

  it('reports the expiry and the replacement QR code', async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetchSequence([
      { status: 'expired' },
      { qrcode: 'qrcode-2', qrcode_img_content: 'https://scan.example/qr-2' },
      { status: 'confirmed', bot_token: 'token-2' },
    ]);
    const events: WeixinLoginEvent[] = [];

    const pending = waitForLogin({
      qrcodeId: 'qrcode-1',
      apiBaseUrl: API_BASE,
      onEvent: (event) => events.push(event),
    });
    await vi.advanceTimersByTimeAsync(1100);
    const result = await pending;

    expect(events).toEqual([
      { type: 'expired' },
      {
        type: 'qrcode',
        qrcodeId: 'qrcode-2',
        qrcodeUrl: 'https://scan.example/qr-2',
      },
    ]);
    expect(result.connected).toBe(true);
    // The poll after the refresh must carry the replacement id, not the
    // expired one — otherwise the operator scans a QR nobody is watching.
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/ilink/bot/get_qrcode_status?qrcode=qrcode-2`,
      expect.anything(),
    );
  });

  it('stops after the refresh budget instead of looping forever', async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetchSequence([
      { status: 'expired' },
      { qrcode: 'qrcode-2' },
      { status: 'expired' },
      { qrcode: 'qrcode-3' },
      { status: 'expired' },
    ]);

    const pending = waitForLogin({
      qrcodeId: 'qrcode-1',
      apiBaseUrl: API_BASE,
    });
    await vi.advanceTimersByTimeAsync(3100);
    const result = await pending;

    expect(result).toEqual({
      connected: false,
      message: 'QR code expired after maximum retries.',
      reason: 'expired',
    });
    // Two refreshes, then the third expiry terminates: the budget is checked
    // before minting, so the loop never issues a fourth QR request.
    const qrCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('get_bot_qrcode'),
    );
    expect(qrCalls).toHaveLength(2);
  });
});

describe('weixin login cancellation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('settles as cancelled when the signal aborts mid-poll', async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch({ status: 'waiting' });
    const controller = new AbortController();

    const pending = waitForLogin({
      qrcodeId: 'qrcode-1',
      apiBaseUrl: API_BASE,
      signal: controller.signal,
    });
    // Let the first poll land so the abort hits a live loop, not a cold start.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1100);

    await expect(pending).resolves.toEqual({
      connected: false,
      message: 'Login cancelled.',
      reason: 'cancelled',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns immediately when the signal is already aborted', async () => {
    const fetchMock = stubFetch({ status: 'waiting' });
    const controller = new AbortController();
    controller.abort();

    await expect(
      waitForLogin({
        qrcodeId: 'qrcode-1',
        apiBaseUrl: API_BASE,
        signal: controller.signal,
      }),
    ).resolves.toEqual({
      connected: false,
      message: 'Login cancelled.',
      reason: 'cancelled',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('detaches every abort listener it attaches across poll ticks', async () => {
    vi.useFakeTimers();
    stubFetch({ status: 'waiting' });
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const pending = waitForLogin({
      qrcodeId: 'qrcode-1',
      apiBaseUrl: API_BASE,
      signal: controller.signal,
      timeoutMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(5000);
    await pending;

    const abortAdds = addSpy.mock.calls.filter(
      ([type]) => type === 'abort',
    ).length;
    const abortRemovals = removeSpy.mock.calls.filter(
      ([type]) => type === 'abort',
    ).length;
    // The loop never aborted, so every attach must have an explicit detach.
    // A sleep that left its listener behind would make adds exceed removals
    // by one per tick.
    expect(abortAdds).toBeGreaterThan(0);
    expect(abortRemovals).toBe(abortAdds);
    expect(controller.signal.aborted).toBe(false);
  });
});
