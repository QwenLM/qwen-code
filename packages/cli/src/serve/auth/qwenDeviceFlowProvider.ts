/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  cacheQwenCredentials,
  generatePKCEPair,
  isDeviceAuthorizationSuccess,
  isDeviceTokenPending,
  isDeviceTokenSuccess,
  QwenOAuth2Client,
  type DeviceTokenPendingData,
  type IQwenOAuth2Client,
  type QwenCredentials,
} from '@qwen-code/qwen-code-core';
import {
  brandSecret,
  revealSecret,
  UpstreamDeviceFlowError,
  type BrandedSecret,
  type DeviceFlowErrorKind,
  type DeviceFlowPollResult,
  type DeviceFlowProvider,
  type DeviceFlowProviderId,
  type DeviceFlowStartResult,
} from './deviceFlow.js';

const QWEN_OAUTH_SCOPE = 'openid profile email model.completion';

/**
 * Qwen-OAuth implementation of `DeviceFlowProvider` for `qwen serve`.
 *
 * Uses the lower-level `QwenOAuth2Client` primitives (`requestDeviceAuthorization`
 * / `pollDeviceToken`) directly rather than the high-level
 * `authWithQwenDeviceFlow` because that helper invokes `open(url)` to launch
 * a browser on the daemon host. PR 21 design §8 #1 forbids browser-spawning
 * from the daemon — only the SDK/user side may decide to open a URL.
 */
export class QwenOAuthDeviceFlowProvider implements DeviceFlowProvider {
  readonly providerId: DeviceFlowProviderId = 'qwen-oauth';
  private readonly client: IQwenOAuth2Client;

  constructor(client?: IQwenOAuth2Client) {
    this.client = client ?? new QwenOAuth2Client();
  }

  async start(opts: { signal: AbortSignal }): Promise<DeviceFlowStartResult> {
    const { code_verifier, code_challenge } = generatePKCEPair();
    let auth;
    try {
      auth = await this.client.requestDeviceAuthorization({
        scope: QWEN_OAUTH_SCOPE,
        code_challenge,
        code_challenge_method: 'S256',
      });
    } catch (err: unknown) {
      // Network / parse / non-2xx errors from the Qwen IdP. Wrap so the
      // route layer maps to `502 upstream_error` rather than the generic
      // `500` fall-through in `sendBridgeError`.
      throw new UpstreamDeviceFlowError(
        `Qwen device authorization request failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (opts.signal.aborted) {
      throw new UpstreamDeviceFlowError('device-flow start aborted');
    }
    if (!isDeviceAuthorizationSuccess(auth)) {
      const errorData = auth as { error?: string; error_description?: string };
      throw new UpstreamDeviceFlowError(
        `Qwen device authorization failed: ${errorData?.error ?? 'unknown'} - ${
          errorData?.error_description ?? 'no details provided'
        }`,
      );
    }
    return {
      deviceCode: brandSecret(auth.device_code),
      pkceVerifier: brandSecret(code_verifier),
      userCode: auth.user_code,
      verificationUri: auth.verification_uri,
      verificationUriComplete: auth.verification_uri_complete,
      expiresIn: auth.expires_in,
      // Qwen IdP doesn't return `interval`; registry falls back to the
      // RFC 8628 default (5s) when this is undefined.
    };
  }

  async poll(
    state: {
      deviceCode: BrandedSecret<string>;
      pkceVerifier?: BrandedSecret<string>;
    },
    opts: { signal: AbortSignal },
  ): Promise<DeviceFlowPollResult> {
    if (!state.pkceVerifier) {
      // Qwen *requires* PKCE; missing verifier is a programmer error.
      return {
        kind: 'error',
        errorKind: 'invalid_grant',
        hint: 'Qwen device-flow requires a PKCE verifier',
      };
    }
    if (opts.signal.aborted) {
      // Caller already gave up. Returning `pending` is the correct
      // semantic — the registry's post-await guard will see entry.status
      // !== 'pending' and skip emit/audit.
      return { kind: 'pending' };
    }
    let response: Awaited<ReturnType<IQwenOAuth2Client['pollDeviceToken']>>;
    try {
      // The class's `pollDeviceToken` doesn't accept a signal yet — see
      // `qwenOAuth2.ts:333`. We honor the signal at the boundary
      // (abort check before the call, abort check after) so that
      // dispose / cancel during a slow IdP request still results in
      // the registry suppressing the resolved frame. Threading signal
      // INTO `pollDeviceToken`'s `fetch` is a Wave 5 follow-up.
      response = await this.client.pollDeviceToken({
        device_code: revealSecret(state.deviceCode),
        code_verifier: revealSecret(state.pkceVerifier),
      });
    } catch (err: unknown) {
      // The class throws on non-OAuth error responses (network, malformed
      // upstream payloads) and on RFC 8628 terminal errors that aren't
      // `authorization_pending` or `slow_down`. Map RFC 8628 errors to
      // structured terminal results; everything else is `upstream_error`.
      const message = err instanceof Error ? err.message : String(err);
      const errorKind = mapRfc8628ErrorMessage(message);
      return {
        kind: 'error',
        errorKind,
        hint: message,
      };
    }
    if (isDeviceTokenSuccess(response)) {
      const tokenData = response;
      const credentials: QwenCredentials = {
        access_token: tokenData.access_token!,
        refresh_token: tokenData.refresh_token ?? undefined,
        token_type: tokenData.token_type,
        resource_url: tokenData.resource_url,
        expiry_date: tokenData.expires_in
          ? Date.now() + tokenData.expires_in * 1000
          : undefined,
      };
      const expiresAt = credentials.expiry_date;
      const client = this.client;
      return {
        kind: 'success',
        async persist() {
          // Order matters: write to disk FIRST. If `cacheQwenCredentials`
          // throws (EACCES, EROFS, ENOSPC) we MUST NOT update the
          // in-process client — otherwise the daemon enters a zombie
          // state where this session "remembers" the token but a
          // restart loses it (silent-failure-hunter S4). The post-await
          // `setCredentials` is best-effort; failure here is benign
          // because the disk file is the source of truth and any
          // SharedTokenManager consumer reads it via mtime check.
          await cacheQwenCredentials(credentials);
          try {
            client.setCredentials(credentials);
          } catch {
            // ignore — disk file is the durable record; in-process
            // refresh happens on next SharedTokenManager mtime poll
          }
          return { expiresAt };
        },
      };
    }
    if (isDeviceTokenPending(response)) {
      const pending = response as DeviceTokenPendingData;
      return pending.slowDown ? { kind: 'slow_down' } : { kind: 'pending' };
    }
    // The `QwenOAuth2Client.pollDeviceToken` implementation in
    // `qwenOAuth2.ts:386-393` THROWS on every non-pending non-success
    // response (it never returns a structured error envelope from the
    // success path). So this fall-through is reached only if a future
    // refactor changes that contract. Map defensively to
    // `upstream_error` and surface the response shape via `hint`.
    const errorData = response as {
      error?: string;
      error_description?: string;
    };
    return {
      kind: 'error',
      errorKind: 'upstream_error',
      hint:
        errorData?.error_description ??
        errorData?.error ??
        'unknown error envelope',
    };
  }
}

/**
 * Anchored regex matcher for the thrown-error path of `pollDeviceToken`.
 * Format (`qwenOAuth2.ts:391`): `"Device token poll failed: ${error} - ${description}"`.
 * The earlier `message.includes(code)` shape was substring-matching the
 * description too, so an `error_description` containing the literal
 * `"expired_token"` (e.g. "your expired_token has been replaced")
 * mis-classified an unrelated upstream error. The anchored regex
 * captures group 1 = the OAuth error code, never the description.
 */
const RFC_8628_ERROR_RE =
  /^Device token poll failed: (expired_token|access_denied|invalid_grant)(?: |$)/;

function mapRfc8628ErrorMessage(message: string): DeviceFlowErrorKind {
  const match = RFC_8628_ERROR_RE.exec(message);
  if (!match) return 'upstream_error';
  return match[1] as DeviceFlowErrorKind;
}
