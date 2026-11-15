/**
 * QQ Bot QR-code login flow.
 *
 * Delegates to @tencent-connect/qqbot-connector for the actual QR-code
 * handshake, then returns the obtained credentials.
 */

import { qrConnect, startQrConnect } from '@tencent-connect/qqbot-connector';
import type { ChannelQrLoginHandlers } from '@qwen-code/channel-base';

export interface QQCredentials {
  appId: string;
  appSecret: string;
}

/**
 * Drive the same handshake without touching the console, so a browser can
 * render the QR payload. The connector keeps the bind key in its own closure
 * and decrypts the secret here, so `appSecret` never reaches the client.
 */
export function startQrLogin(
  handlers: ChannelQrLoginHandlers,
  signal: AbortSignal,
): () => void {
  return startQrConnect(
    {
      onSuccess: (credentials) => {
        const creds = credentials[0];
        if (!creds?.appId || !creds?.appSecret) {
          handlers.onFailure(
            new Error('QR login failed: no credentials returned'),
          );
          return;
        }
        handlers.onSuccess({ appID: creds.appId, appSecret: creds.appSecret });
      },
      onFailure: (error) => handlers.onFailure(error),
      onQrDisplayed: (url) => handlers.onQrCode(url),
      onQrExpired: () => handlers.onExpired(),
    },
    { displayQrCodeToConsole: false, signal, source: 'qwen-code' },
  );
}

/**
 * Launch QR-code login and wait for the user to scan with QQ.
 * Returns the obtained appId and appSecret.
 */
export async function qrCodeLogin(): Promise<QQCredentials> {
  // In practice qrConnect() always returns a non-empty array — verified by
  // removing appID from config and running `qwen channel start`, which
  // correctly triggers QR login and returns valid credentials. The defensive
  // destructuring + null-guard below is a robustness patch against unexpected
  // external-library behaviour, not a response to an observed failure.
  const results = await qrConnect();
  const creds = results[0];
  if (!creds?.appId || !creds?.appSecret) {
    throw new Error('QR login failed: no credentials returned');
  }
  return { appId: creds.appId, appSecret: creds.appSecret };
}
