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
  payload: string;
}

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

async function requestLoginQr(
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

  if (data.qrcode_img_content) {
    process.stderr.write(
      `QR code URL: ${data.qrcode_img_content}\nScan this URL with WeChat.\n`,
    );
  }

  process.stderr.write('Scan the QR code with WeChat to connect.\n');
  return {
    id: data.qrcode,
    payload: data.qrcode_img_content ?? data.qrcode,
  };
}

/** Step 1: Get QR code from server and display in terminal */
export async function startLogin(
  apiBaseUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  return (await requestLoginQr(apiBaseUrl, signal)).id;
}

/** Step 2: Poll for scan result */
export async function waitForLogin(params: {
  qrcodeId: string;
  apiBaseUrl: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onQrCode?: (qrCode: LoginQrCode) => void;
}): Promise<LoginResult> {
  const { apiBaseUrl, timeoutMs = 480000, signal, onQrCode } = params;
  let currentQrcodeId = params.qrcodeId;
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
          `${apiBaseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(currentQrcodeId)}`,
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
          process.stderr.write(
            'QR code scanned, waiting for confirmation...\n',
          );
          break;
        case 'expired': {
          retryCount++;
          if (retryCount >= 3) {
            return {
              connected: false,
              message: 'QR code expired after maximum retries.',
            };
          }
          process.stderr.write('QR code expired, refreshing...\n');
          const qrCode = await requestLoginQr(apiBaseUrl, signal);
          currentQrcodeId = qrCode.id;
          onQrCode?.(qrCode);
          break;
        }
        default:
          break;
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
    const initialQrCode = await requestLoginQr(DEFAULT_BASE_URL, signal);
    let state = 'pending';
    let qrPayload = initialQrCode.payload;
    let qrRevision = 1;

    const ready = waitForLogin({
      qrcodeId: initialQrCode.id,
      apiBaseUrl: DEFAULT_BASE_URL,
      signal,
      onQrCode(qrCode) {
        qrPayload = qrCode.payload;
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
        state = signal.aborted ? 'cancelled' : 'failed';
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
