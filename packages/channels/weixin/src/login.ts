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
}

/** Step 1: Get QR code from server and display in terminal */
export async function startLogin(apiBaseUrl: string): Promise<string> {
  const resp = await fetch(`${apiBaseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`);
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
  return data.qrcode;
}

/** Step 2: Poll for scan result */
export async function waitForLogin(params: {
  qrcodeId: string;
  apiBaseUrl: string;
  timeoutMs?: number;
}): Promise<LoginResult> {
  const { apiBaseUrl, timeoutMs = 480000 } = params;
  let currentQrcodeId = params.qrcodeId;
  const deadline = Date.now() + timeoutMs;
  let retryCount = 0;

  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);

      const resp = await fetch(
        `${apiBaseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(currentQrcodeId)}`,
        {
          headers: buildHeaders(),
          signal: controller.signal,
        },
      );
      clearTimeout(timeout);

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
        case 'expired':
          retryCount++;
          if (retryCount >= 3) {
            return {
              connected: false,
              message: 'QR code expired after maximum retries.',
            };
          }
          process.stderr.write('QR code expired, refreshing...\n');
          currentQrcodeId = await startLogin(apiBaseUrl);
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

    await new Promise((r) => setTimeout(r, 1000));
  }

  return { connected: false, message: 'Login timed out.' };
}
