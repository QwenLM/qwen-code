/**
 * QQ Bot QR-code login flow.
 *
 * Delegates to @tencent-connect/qqbot-connector for the actual QR-code
 * handshake, then returns the obtained credentials.
 */

import { qrConnect } from '@tencent-connect/qqbot-connector';

export interface QQCredentials {
  appId: string;
  appSecret: string;
}

/**
 * Launch QR-code login and wait for the user to scan with QQ.
 * Returns the obtained appId and appSecret.
 */
export async function qrCodeLogin(): Promise<QQCredentials> {
  const results = await qrConnect();
  const creds = results[0];
  if (!creds?.appId || !creds?.appSecret) {
    throw new Error('QR login failed: no credentials returned');
  }
  return { appId: creds.appId, appSecret: creds.appSecret };
}
