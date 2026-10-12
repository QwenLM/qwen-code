/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLogin, waitForLogin } from './login.js';

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

function stubFetch(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('weixin login iLink request headers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('declares the iLink client version when minting the QR code', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fetchMock = stubFetch({ qrcode: 'qrcode-1' });

    await expect(startLogin(API_BASE)).resolves.toBe('qrcode-1');

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`,
      expect.objectContaining({
        headers: expect.objectContaining(ILINK_IDENTITY),
      }),
    );
  });

  it('declares the iLink client version when polling the scan status', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
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
