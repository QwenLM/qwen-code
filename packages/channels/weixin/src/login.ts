/**
 * QR code login flow for WeChat iLink Bot.
 */

import { buildHeaders } from './api.js';
import type { ChannelAuthDriver } from '@qwen-code/channel-base';
import { DEFAULT_BASE_URL, saveAccount, type AccountData } from './accounts.js';

export interface LoginResult {
  connected: boolean;
  token?: string;
  baseUrl?: string;
  userId?: string;
  message: string;
}

interface LoginQrCode {
  id: string;
  payload?: string;
}

export type WeixinAuthErrorCode =
  | 'weixin_auth_qr_payload_missing'
  | 'weixin_auth_qr_payload_invalid'
  | 'weixin_auth_redirect_missing'
  | 'weixin_auth_redirect_invalid'
  | 'weixin_auth_verification_required'
  | 'weixin_auth_verification_blocked'
  | 'weixin_auth_already_connected'
  | 'weixin_auth_unexpected_status';

export class WeixinAuthError extends Error {
  override readonly name = 'WeixinAuthError';

  constructor(
    readonly code: WeixinAuthErrorCode,
    readonly authState: string,
    message: string,
  ) {
    super(message);
  }
}

const REDIRECT_HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchLoginQr(
  apiBaseUrl: string,
  signal?: AbortSignal,
): Promise<LoginQrCode> {
  const resp = await fetch(
    `${apiBaseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`,
    { signal },
  );
  if (!resp.ok) {
    throw new Error(`Failed to get QR code: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as {
    qrcode?: string;
    qrcode_img_content?: string;
  };

  if (!data.qrcode) {
    throw new Error('No qrcode in response');
  }

  return {
    id: data.qrcode,
    payload: data.qrcode_img_content,
  };
}

function renderLoginQr(qrCode: LoginQrCode): void {
  if (qrCode.payload) {
    process.stderr.write(
      `QR code URL: ${qrCode.payload}\nScan this URL with WeChat.\n`,
    );
  }

  process.stderr.write('Scan the QR code with WeChat to connect.\n');
}

function requireRenderableQrPayload(qrCode: LoginQrCode): string {
  const payload = qrCode.payload?.trim();
  if (!payload) {
    throw new WeixinAuthError(
      'weixin_auth_qr_payload_missing',
      'qr_payload_missing',
      'WeChat did not provide a QR image URL.',
    );
  }
  try {
    const url = new URL(payload);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      throw new Error('invalid QR URL');
    }
  } catch {
    throw new WeixinAuthError(
      'weixin_auth_qr_payload_invalid',
      'qr_payload_invalid',
      'WeChat provided an invalid QR image URL.',
    );
  }
  return payload;
}

function redirectBaseUrl(redirectHost: unknown): string {
  if (typeof redirectHost !== 'string' || redirectHost.trim().length === 0) {
    throw new WeixinAuthError(
      'weixin_auth_redirect_missing',
      'redirect_error',
      'WeChat login redirect host is missing.',
    );
  }
  if (
    redirectHost !== redirectHost.trim() ||
    !REDIRECT_HOST_PATTERN.test(redirectHost) ||
    !redirectHost.toLowerCase().endsWith('.weixin.qq.com')
  ) {
    throw new WeixinAuthError(
      'weixin_auth_redirect_invalid',
      'redirect_error',
      'WeChat login redirect host is invalid.',
    );
  }
  return `https://${redirectHost}`;
}

/** Step 1: Get QR code from server and display in terminal */
export async function startLogin(
  apiBaseUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  const qrCode = await fetchLoginQr(apiBaseUrl, signal);
  renderLoginQr(qrCode);
  return qrCode.id;
}

/** Step 2: Poll for scan result */
export async function waitForLogin(params: {
  qrcodeId: string;
  apiBaseUrl: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onQrCode?: (qrCode: LoginQrCode) => void;
  silent?: boolean;
}): Promise<LoginResult> {
  const {
    apiBaseUrl,
    timeoutMs = 480000,
    signal,
    onQrCode,
    silent = false,
  } = params;
  let currentQrcodeId = params.qrcodeId;
  let currentApiBaseUrl = apiBaseUrl;
  const deadline = Date.now() + timeoutMs;
  let retryCount = 0;

  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const requestSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      let resp: Response;
      try {
        resp = await fetch(
          `${currentApiBaseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(currentQrcodeId)}`,
          {
            headers: buildHeaders(),
            signal: requestSignal,
          },
        );
      } finally {
        clearTimeout(timeout);
      }

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = (await resp.json()) as {
        status?: string;
        bot_token?: string;
        ilink_bot_id?: string;
        baseurl?: string;
        ilink_user_id?: string;
        redirect_host?: unknown;
      };

      switch (data.status) {
        case 'wait':
          break;
        case 'confirmed':
          return {
            connected: true,
            token: data.bot_token,
            baseUrl: data.baseurl,
            userId: data.ilink_user_id,
            message: 'Connected to WeChat successfully!',
          };
        case 'scaned':
          if (!silent) {
            process.stderr.write(
              'QR code scanned, waiting for confirmation...\n',
            );
          }
          break;
        case 'need_verifycode':
          throw new WeixinAuthError(
            'weixin_auth_verification_required',
            'verification_required',
            'WeChat requires pair-code verification, which is not supported by this login flow.',
          );
        case 'verify_code_blocked':
          throw new WeixinAuthError(
            'weixin_auth_verification_blocked',
            'verification_blocked',
            'WeChat pair-code verification is temporarily blocked.',
          );
        case 'binded_redirect':
          throw new WeixinAuthError(
            'weixin_auth_already_connected',
            'already_connected',
            'This WeChat bot is already connected and no new credentials were issued.',
          );
        case 'scaned_but_redirect':
          currentApiBaseUrl = redirectBaseUrl(data.redirect_host);
          break;
        case 'expired': {
          retryCount++;
          if (retryCount >= 3) {
            return {
              connected: false,
              message: 'QR code expired after maximum retries.',
            };
          }
          if (!silent) {
            process.stderr.write('QR code expired, refreshing...\n');
          }
          const qrCode = await fetchLoginQr(apiBaseUrl, signal);
          currentQrcodeId = qrCode.id;
          onQrCode?.(qrCode);
          if (!silent) {
            renderLoginQr(qrCode);
          }
          break;
        }
        default:
          throw new WeixinAuthError(
            'weixin_auth_unexpected_status',
            'unexpected_status',
            'WeChat returned an unsupported login status.',
          );
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (signal?.aborted) {
          throw err;
        }
        continue;
      }
      throw err;
    }

    await abortableDelay(1000, signal);
  }

  return { connected: false, message: 'Login timed out.' };
}

export const authDriver: ChannelAuthDriver<AccountData> = {
  kind: 'qr',
  async begin(context) {
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const initialQrCode = await fetchLoginQr(DEFAULT_BASE_URL, signal);
    let state = 'pending';
    let qrPayload = requireRenderableQrPayload(initialQrCode);
    let qrRevision = 1;

    const ready = waitForLogin({
      qrcodeId: initialQrCode.id,
      apiBaseUrl: DEFAULT_BASE_URL,
      signal,
      silent: true,
      onQrCode(qrCode) {
        qrPayload = requireRenderableQrPayload(qrCode);
        qrRevision++;
      },
    })
      .then((result): AccountData => {
        if (!result.connected || !result.token) {
          throw new Error(result.message);
        }
        state = 'confirmed';
        return {
          token: result.token,
          baseUrl: result.baseUrl ?? DEFAULT_BASE_URL,
          userId: result.userId,
          savedAt: new Date().toISOString(),
        };
      })
      .catch((error: unknown) => {
        state = signal.aborted
          ? 'cancelled'
          : error instanceof WeixinAuthError
            ? error.authState
            : 'failed';
        throw error;
      });

    return {
      snapshot: () => ({ state, qrPayload, qrRevision }),
      ready,
      cancel() {
        state = 'cancelled';
        controller.abort();
      },
      async commit() {
        saveAccount(await ready, context.stateDir);
      },
    };
  },
};
