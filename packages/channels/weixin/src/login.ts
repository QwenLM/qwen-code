/**
 * QR code login flow for WeChat iLink Bot.
 */

import { buildHeaders } from './api.js';

export interface LoginResult {
  connected: boolean;
  token?: string;
  baseUrl?: string;
  userId?: string;
  message: string;
  /**
   * Why a disconnected attempt ended. Callers branch on this rather than on
   * `message`, which is user-facing copy. Absent on success.
   */
  reason?: 'expired' | 'timeout' | 'cancelled';
}

/** A minted login QR code: the poll id, plus the URL the operator scans. */
export interface WeixinQrCode {
  qrcodeId: string;
  qrcodeUrl?: string;
}

/**
 * Progress of a running login. `qrcode` fires only when the loop mints a
 * replacement after an expiry — the caller already holds the initial one from
 * `startLogin`. `scanned` fires on every poll that reports a scan, matching the
 * terminal output this flow produced before it was event-driven.
 */
export type WeixinLoginEvent =
  | ({ type: 'qrcode' } & WeixinQrCode)
  | { type: 'scanned' }
  | { type: 'expired' };

/** Step 1: Get QR code from server. */
export async function startLogin(apiBaseUrl: string): Promise<WeixinQrCode> {
  const resp = await fetch(
    `${apiBaseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`,
    {
      headers: buildHeaders(),
    },
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

  return { qrcodeId: data.qrcode, qrcodeUrl: data.qrcode_img_content };
}

/** Step 2: Poll for scan result. */
export async function waitForLogin(params: {
  qrcodeId: string;
  apiBaseUrl: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: WeixinLoginEvent) => void;
}): Promise<LoginResult> {
  const { apiBaseUrl, timeoutMs = 480000, signal, onEvent } = params;
  let currentQrcodeId = params.qrcodeId;
  const deadline = Date.now() + timeoutMs;
  let retryCount = 0;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      return {
        connected: false,
        message: 'Login cancelled.',
        reason: 'cancelled',
      };
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });

      let resp: Response;
      try {
        resp = await fetch(
          `${apiBaseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(currentQrcodeId)}`,
          {
            headers: buildHeaders(),
            signal: controller.signal,
          },
        );
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      }

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = (await resp.json()) as {
        status?: string;
        bot_token?: string;
        ilink_bot_id?: string;
        baseurl?: string;
        ilink_user_id?: string;
      };

      switch (data.status) {
        case 'confirmed':
          return {
            connected: true,
            token: data.bot_token,
            baseUrl: data.baseurl,
            userId: data.ilink_user_id,
            message: 'Connected to WeChat successfully!',
          };
        case 'scaned':
          onEvent?.({ type: 'scanned' });
          break;
        case 'expired':
          retryCount++;
          if (retryCount >= 3) {
            return {
              connected: false,
              message: 'QR code expired after maximum retries.',
              reason: 'expired',
            };
          }
          onEvent?.({ type: 'expired' });
          {
            const refreshed = await startLogin(apiBaseUrl);
            currentQrcodeId = refreshed.qrcodeId;
            onEvent?.({ type: 'qrcode', ...refreshed });
          }
          break;
        default:
          break;
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        continue;
      }
      throw err;
    }

    // An abort during the idle second must settle the loop now, not after the
    // full sleep — a cancelled daemon flow would otherwise keep a timer alive.
    // Both exits detach the listener: a 480 s loop otherwise accumulates one
    // listener per tick on the caller's signal.
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, 1000);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  return { connected: false, message: 'Login timed out.', reason: 'timeout' };
}
