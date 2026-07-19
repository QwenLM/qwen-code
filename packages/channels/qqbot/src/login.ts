/**
 * QQ Bot QR-code login flow.
 *
 * Delegates to @tencent-connect/qqbot-connector for the actual QR-code
 * handshake, then returns the obtained credentials.
 */

import {
  qrConnect,
  startQrConnect,
  type QrConnectCredentials,
} from '@tencent-connect/qqbot-connector';
import type { ChannelAuthDriver } from '@qwen-code/channel-base';
import {
  getCredsFilePath,
  saveCredentials,
  type QQCredentials,
} from './accounts.js';

export type { QQCredentials } from './accounts.js';

function requireCredentials(
  credentials: QrConnectCredentials | undefined,
): QQCredentials {
  if (
    typeof credentials?.appId !== 'string' ||
    credentials.appId.length === 0 ||
    typeof credentials.appSecret !== 'string' ||
    credentials.appSecret.length === 0
  ) {
    throw new Error('QR login failed: no credentials returned');
  }
  return { appId: credentials.appId, appSecret: credentials.appSecret };
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

export const authDriver: ChannelAuthDriver<QQCredentials> = {
  kind: 'qr',
  async begin(context) {
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    let state = 'pending';
    let qrPayload: string | undefined;
    let qrRevision = 0;
    let settled = false;
    let resolveReady!: (credentials: QQCredentials) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<QQCredentials>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const succeed = (credentials: QrConnectCredentials | undefined) => {
      if (settled) return;
      try {
        const required = requireCredentials(credentials);
        settled = true;
        state = 'confirmed';
        resolveReady(required);
      } catch (error) {
        settled = true;
        state = 'failed';
        rejectReady(error);
      }
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      const cancelled = signal.aborted;
      state = cancelled ? 'cancelled' : 'failed';
      rejectReady(
        cancelled ? new DOMException('Aborted', 'AbortError') : error,
      );
    };

    const stop = startQrConnect(
      {
        onQrDisplayed(url) {
          if (settled) return;
          qrPayload = url;
          qrRevision++;
          state = 'pending';
        },
        onQrExpired() {
          if (!settled) state = 'refreshing';
        },
        onSuccess(credentials) {
          succeed(credentials[0]);
        },
        onFailure(error) {
          fail(error);
        },
      },
      { displayQrCodeToConsole: false, signal },
    );

    return {
      snapshot: () => ({ state, qrPayload, qrRevision }),
      ready,
      cancel() {
        if (settled) return;
        state = 'cancelled';
        controller.abort();
        stop();
        fail(new DOMException('Aborted', 'AbortError'));
      },
      async commit(credentials?: QQCredentials) {
        const resolved = requireCredentials(credentials ?? (await ready));
        saveCredentials(
          getCredsFilePath(context.channelName, context.stateDir),
          resolved.appId,
          resolved.appSecret,
        );
      },
    };
  },
};
