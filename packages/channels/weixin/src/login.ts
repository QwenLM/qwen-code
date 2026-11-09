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

/**
 * A mint that hangs must not outlive the caller's interest: the daemon holds a
 * flow slot and an open request for its whole duration, so an unanswered mint
 * would wedge the cap. The poll below already bounds each request; this is the
 * same bound for the mint.
 */
const QR_MINT_TIMEOUT_MS = 30_000;

/** Step 1: Get QR code from server. */
export async function startLogin(
  apiBaseUrl: string,
  options: { timeoutMs?: number } = {},
): Promise<WeixinQrCode> {
  const resp = await fetch(
    `${apiBaseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`,
    {
      headers: buildHeaders(),
      // Symmetric with `waitForLogin`'s timeoutMs: the caller that owns the
      // deadline decides, and the default bounds the daemon's slot holding.
      signal: AbortSignal.timeout(options.timeoutMs ?? QR_MINT_TIMEOUT_MS),
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

      // `fetch` resolves when the headers arrive, so the listener and the
      // timeout must stay armed through the body read too. Detaching them
      // here would leave an upstream that sends headers and then stalls both
      // uncancellable and unbounded — cancel, revoke and shutdown would all
      // return while the request stayed open.
      let data: {
        status?: string;
        bot_token?: string;
        ilink_bot_id?: string;
        baseurl?: string;
        ilink_user_id?: string;
      };
      try {
        const resp = await fetch(
          `${apiBaseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(currentQrcodeId)}`,
          {
            headers: buildHeaders(),
            signal: controller.signal,
          },
        );
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        data = (await resp.json()) as typeof data;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      }

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
            // A refresh that yields no scannable URL is not a replacement:
            // publishing it would overwrite a view with one that has nothing
            // to scan and no link to open. Keep the expired id instead, so the
            // next poll spends another retry and the budget — not a dead view —
            // decides when to stop.
            if (refreshed.qrcodeUrl) {
              currentQrcodeId = refreshed.qrcodeId;
              onEvent?.({ type: 'qrcode', ...refreshed });
            }
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
