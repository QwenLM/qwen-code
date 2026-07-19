import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAuthContext } from '@qwen-code/channel-base';
import { loadAccount } from './accounts.js';
import { plugin } from './index.js';
import { authDriver } from './login.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function context(signal = new AbortController().signal): ChannelAuthContext {
  return {
    channelName: 'work-bot',
    stateDir: mkdtempSync(join(tmpdir(), 'weixin-auth-')),
    signal,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Weixin QR auth driver', () => {
  it('is advertised as the runtime driver behind serializable QR metadata', () => {
    expect(plugin.management?.auth).toEqual(['qr']);
    expect(plugin.authDriver).toBe(authDriver);
  });

  it('keeps confirmed credentials in memory until commit', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            qrcode: 'qr-1',
            qrcode_img_content: 'https://qr.example/1',
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            status: 'confirmed',
            bot_token: 'token-1',
            baseurl: 'https://bot.example',
            ilink_user_id: 'user-1',
          }),
        ),
    );
    const authContext = context();

    const session = await authDriver.begin(authContext);
    expect(session.snapshot()).toEqual({
      state: 'pending',
      qrPayload: 'https://qr.example/1',
      qrRevision: 1,
    });
    expect(JSON.parse(JSON.stringify(session.snapshot()))).toEqual(
      session.snapshot(),
    );

    const credentials = await session.ready;
    expect(loadAccount(authContext.stateDir)).toBeNull();

    await session.commit(credentials);
    expect(loadAccount(authContext.stateDir)).toMatchObject({
      token: 'token-1',
      baseUrl: 'https://bot.example',
      userId: 'user-1',
    });
  });

  it('aborts in-flight polling on cancel', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            qrcode: 'qr-1',
            qrcode_img_content: 'https://qr.example/1',
          }),
        )
        .mockImplementationOnce(
          (_url: string, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
              });
            }),
        ),
    );
    const session = await authDriver.begin(context());

    session.cancel();

    await expect(session.ready).rejects.toMatchObject({ name: 'AbortError' });
    expect(session.snapshot().state).toBe('cancelled');
  });

  it('stops polling when the caller context is aborted', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            qrcode: 'qr-1',
            qrcode_img_content: 'https://qr.example/1',
          }),
        )
        .mockImplementationOnce(
          (_url: string, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
              });
            }),
        ),
    );
    const session = await authDriver.begin(context(controller.signal));

    controller.abort();

    await expect(session.ready).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('revisions the serializable QR snapshot when an expired code refreshes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            qrcode: 'qr-1',
            qrcode_img_content: 'https://qr.example/1',
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ status: 'expired' }))
        .mockResolvedValueOnce(
          jsonResponse({
            qrcode: 'qr-2',
            qrcode_img_content: 'https://qr.example/2',
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            status: 'confirmed',
            bot_token: 'token-2',
            baseurl: 'https://bot.example',
          }),
        ),
    );
    const session = await authDriver.begin(context());

    await vi.waitFor(() => {
      expect(session.snapshot()).toMatchObject({
        qrPayload: 'https://qr.example/2',
        qrRevision: 2,
      });
    });
    await vi.advanceTimersByTimeAsync(1000);

    await expect(session.ready).resolves.toMatchObject({ token: 'token-2' });
  });
});
