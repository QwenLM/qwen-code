import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAuthContext } from '@qwen-code/channel-base';
import { loadAccount } from './accounts.js';
import { plugin } from './index.js';
import { authDriver, startLogin, WeixinAuthError } from './login.js';

afterEach(() => {
  vi.restoreAllMocks();
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
  it('keeps standalone QR rendering compatible', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          qrcode: 'qr-standalone',
          qrcode_img_content: 'https://qr.example/standalone',
        }),
      ),
    );

    await expect(startLogin('https://api.example')).resolves.toBe(
      'qr-standalone',
    );
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('https://qr.example/standalone'),
    );
  });

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

  it('switches polling to a validated redirect host', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          qrcode: 'qr-1',
          qrcode_img_content: 'https://qr.example/1',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'scaned_but_redirect',
          redirect_host: 'idc.weixin.qq.com',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'confirmed',
          bot_token: 'token-redirect',
          baseurl: 'https://bot.example',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const session = await authDriver.begin(context());

    await vi.advanceTimersByTimeAsync(1000);
    await expect(session.ready).resolves.toMatchObject({
      token: 'token-redirect',
    });
    expect(fetchMock.mock.calls[2]?.[0]).toContain(
      'https://idc.weixin.qq.com/ilink/bot/get_qrcode_status',
    );
  });

  it.each([
    ['missing', undefined, 'weixin_auth_redirect_missing'],
    ['invalid', 'https://evil.example/path', 'weixin_auth_redirect_invalid'],
    ['untrusted', 'attacker.example.com', 'weixin_auth_redirect_invalid'],
  ])(
    'fails explicitly when a redirect host is %s',
    async (_label, redirectHost, code) => {
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
              status: 'scaned_but_redirect',
              redirect_host: redirectHost,
            }),
          ),
      );
      const session = await authDriver.begin(context());

      await expect(session.ready).rejects.toMatchObject({ code });
      expect(session.snapshot().state).toBe('redirect_error');
    },
  );

  it.each([
    [
      'need_verifycode',
      'weixin_auth_verification_required',
      'verification_required',
    ],
    [
      'verify_code_blocked',
      'weixin_auth_verification_blocked',
      'verification_blocked',
    ],
    ['binded_redirect', 'weixin_auth_already_connected', 'already_connected'],
  ])(
    'fails promptly for unsupported terminal status %s',
    async (status, code, state) => {
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
          .mockResolvedValueOnce(jsonResponse({ status })),
      );
      const session = await authDriver.begin(context());

      await expect(session.ready).rejects.toMatchObject({ code });
      expect(session.snapshot().state).toBe(state);
    },
  );

  it('fails safely for an unknown status instead of polling forever', async () => {
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
        .mockResolvedValueOnce(jsonResponse({ status: 'future_status' })),
    );
    const session = await authDriver.begin(context());

    await expect(session.ready).rejects.toMatchObject({
      code: 'weixin_auth_unexpected_status',
    });
    expect(session.snapshot().state).toBe('unexpected_status');
  });

  it('does not render or log browser QR payloads on initial fetch or refresh', async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            qrcode: 'secret-polling-token-1',
            qrcode_img_content: 'https://qr.example/secret-1',
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ status: 'expired' }))
        .mockResolvedValueOnce(
          jsonResponse({
            qrcode: 'secret-polling-token-2',
            qrcode_img_content: 'https://qr.example/secret-2',
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

    await vi.advanceTimersByTimeAsync(1000);
    await session.ready;

    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined, 'weixin_auth_qr_payload_missing'],
    ['invalid', 'not a URL', 'weixin_auth_qr_payload_invalid'],
  ])(
    'rejects a browser QR response with a %s image payload',
    async (_label, payload, code) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce(
          jsonResponse({
            qrcode: 'secret-token',
            qrcode_img_content: payload,
          }),
        ),
      );

      await expect(authDriver.begin(context())).rejects.toMatchObject({ code });
    },
  );

  it('rejects a refreshed browser QR without an image payload', async () => {
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
        .mockResolvedValueOnce(jsonResponse({ qrcode: 'qr-2' })),
    );
    const session = await authDriver.begin(context());

    await expect(session.ready).rejects.toMatchObject({
      code: 'weixin_auth_qr_payload_missing',
    });
    expect(session.snapshot().state).toBe('qr_payload_missing');
  });

  it('aborts the initial QR request from the caller context', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
      ),
    );
    const beginning = authDriver.begin(context(controller.signal));

    controller.abort();

    await expect(beginning).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborts polling while waiting between status requests', async () => {
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
        .mockResolvedValueOnce(jsonResponse({ status: 'wait' })),
    );
    const session = await authDriver.begin(context(controller.signal));
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    controller.abort();

    await expect(session.ready).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('exports stable sanitized authentication errors', () => {
    const error = new WeixinAuthError(
      'weixin_auth_verification_required',
      'verification_required',
      'Verification is required.',
    );

    expect(error).toMatchObject({
      name: 'WeixinAuthError',
      code: 'weixin_auth_verification_required',
      authState: 'verification_required',
      message: 'Verification is required.',
    });
  });
});
