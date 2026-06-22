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
  QwenOAuthPollError,
  type DeviceTokenPendingData,
  type IQwenOAuth2Client,
  type QwenCredentials,
} from '@qwen-code/qwen-code-core';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  brandSecret,
  sanitizeForStderr,
  unsafeRevealSecret,
  UpstreamDeviceFlowError,
  type BrandedSecret,
  type DeviceFlowErrorKind,
  type DeviceFlowPollResult,
  type DeviceFlowProvider,
  type DeviceFlowProviderId,
  type DeviceFlowStartResult,
} from './device-flow.js';

const QWEN_OAUTH_SCOPE = 'openid profile email model.completion';

/**
 * Maximum length of raw IdP detail written to stderr for operator
 * audit. The raw `err.message` from `QwenOAuth2Client` can embed the
 * full upstream response body, which on a misbehaving reverse proxy /
 * WAF can be megabytes of HTML. Truncate so container log-aggregation
 * pipelines don't lose the useful prefix.
 */
const STDERR_DETAIL_MAX = 2_048;

function truncateForStderr(detail: string): string {
  if (detail.length <= STDERR_DETAIL_MAX) return detail;
  const dropped = detail.length - STDERR_DETAIL_MAX;
  return `${detail.slice(0, STDERR_DETAIL_MAX)}…[+${dropped} bytes truncated]`;
}

/**
 * Qwen-OAuth implementation of `DeviceFlowProvider` for `qwen serve`.
 *
 * Uses the lower-level `QwenOAuth2Client` primitives (`requestDeviceAuthorization`
 * / `pollDeviceToken`) directly rather than the high-level
 * `authWithQwenDeviceFlow` because that helper invokes `open(url)` to launch
 * a browser on the daemon host — only the SDK/user side may decide to open
 * a URL.
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
      // Thread `signal` into the IdP fetch so a dispose / cancel
      // during the device-authorization request aborts the in-flight
      // socket immediately.
      auth = await this.client.requestDeviceAuthorization(
        {
          scope: QWEN_OAUTH_SCOPE,
          code_challenge,
          code_challenge_method: 'S256',
        },
        { signal: opts.signal },
      );
    } catch (err: unknown) {
      // Network / parse / non-2xx errors from the Qwen IdP. Wrap so the
      // route layer maps to `502 upstream_error` rather than the generic
      // `500` fall-through in `sendBridgeError`.
      //
      // Use a stable bounded message for the route response; the
      // original err detail goes through stderr audit only.
      const detail = err instanceof Error ? err.message : String(err);
      writeStderrLine(
        `[serve] qwen device-flow start failed (raw): ${truncateForStderr(detail)}`,
      );
      throw new UpstreamDeviceFlowError(
        'Qwen IdP device authorization request failed',
      );
    }
    if (opts.signal.aborted) {
      throw new UpstreamDeviceFlowError('device-flow start aborted');
    }
    if (!isDeviceAuthorizationSuccess(auth)) {
      // Same sanitization as the catch above — well-formed but
      // unsuccessful IdP responses can carry arbitrary
      // `error_description` text. Static message; raw envelope to
      // stderr.
      const errorData = auth as { error?: string; error_description?: string };
      writeStderrLine(
        truncateForStderr(
          `[serve] qwen device-flow start error envelope (raw): error=${
            errorData?.error ?? 'unknown'
          } description=${errorData?.error_description ?? '(none)'}`,
        ),
      );
      throw new UpstreamDeviceFlowError(
        'Qwen IdP rejected the device authorization request',
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
      // Pass `signal` through to the IdP fetch so cancel / dispose
      // during a slow upstream response aborts the in-flight socket
      // immediately instead of waiting for the IdP's own timeout.
      // The post-await abort check is still useful: an early cancel
      // can land before fetch even starts, in which case the abort
      // throws synchronously into our catch block below.
      response = await this.client.pollDeviceToken(
        {
          device_code: unsafeRevealSecret(state.deviceCode),
          code_verifier: unsafeRevealSecret(state.pkceVerifier),
        },
        { signal: opts.signal },
      );
    } catch (err: unknown) {
      // The class throws on non-OAuth error responses (network, malformed
      // upstream payloads) and on RFC 8628 terminal errors that aren't
      // `authorization_pending` or `slow_down`. Map RFC 8628 errors to
      // structured terminal results; everything else is `upstream_error`.
      // Do NOT echo the raw thrown message into `hint` — it can embed
      // the entire IdP responseText which would flow to every SSE
      // subscriber. Use a stable bounded summary; full detail goes
      // through stderr audit only. Branch on `instanceof
      // QwenOAuthPollError` and read the structured `oauthError`
      // field instead of substring-matching the message text.
      const errorKind: DeviceFlowErrorKind =
        err instanceof QwenOAuthPollError
          ? mapRfc8628OAuthCode(err.oauthError)
          : 'upstream_error';
      // Mirror the `start()` path's stderr audit so on-call can
      // distinguish WAF block from network reset from malformed JSON.
      //
      // Skip ONLY when the registry-owned signal was aborted by
      // `cancel()` / `dispose()` — unexpected `AbortError` from the
      // transport still gets logged. Don't echo raw `err.message`
      // since it may contain WAF-reflected secrets (device_code /
      // PKCE verifier). Sanitize `oauthError` before interpolation
      // to prevent log injection via C0/C1 control sequences.
      const aborted = opts.signal.aborted;
      if (!aborted) {
        let safeDetail: string;
        if (err instanceof QwenOAuthPollError) {
          // Structured upstream OAuth error envelope — no raw body,
          // but the `oauthError` field IS attacker-controlled, so
          // sanitize C0/C1 controls before interpolating.
          const rawOauthError = err.oauthError ?? '(missing)';
          safeDetail = `oauthError=${sanitizeForStderr(rawOauthError)}`;
        } else if (err instanceof Error) {
          // Non-OAuth (network / parse / unexpected upstream shape /
          // unexpected AbortError). The constructor name + length is
          // enough for triage; the raw message MAY contain WAF-echoed
          // request body fields.
          // `Error.name` is freely assignable — sanitize it the
          // same way we sanitize `oauthError` to prevent log
          // injection.
          safeDetail = `${sanitizeForStderr(err.name)} (message ${err.message.length} bytes; raw suppressed to avoid echoing device_code/PKCE)`;
        } else {
          safeDetail = `<non-Error throw: ${typeof err}>`;
        }
        writeStderrLine(
          `[serve] qwen device-flow poll failed (errorKind=${errorKind}): ${truncateForStderr(safeDetail)}`,
        );
      }
      return {
        kind: 'error',
        errorKind,
        hint:
          errorKind === 'upstream_error'
            ? 'unexpected response from identity provider'
            : `Qwen IdP returned ${errorKind}`,
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
        // `persist({signal})`
        // is now threaded end-to-end. The registry passes its
        // per-entry `cancelController.signal`; we forward it to
        // `cacheQwenCredentials({signal})` which forwards to
        // `fs.writeFile(..., {signal})`. A wedged disk write aborts
        // immediately when `cancel()` / `dispose()` / the
        // 30s `DEVICE_FLOW_PERSIST_TIMEOUT_MS` fires, instead of
        // hanging until the OS-level timeout.
        async persist(persistOpts: { signal: AbortSignal }) {
          // Order matters: write to disk FIRST. If `cacheQwenCredentials`
          // throws (EACCES, EROFS, ENOSPC) we MUST NOT update the
          // in-process client — otherwise the daemon enters a zombie
          // state where this session "remembers" the token but a
          // restart loses it.
          await cacheQwenCredentials(credentials, {
            signal: persistOpts.signal,
          });
          try {
            client.setCredentials(credentials);
          } catch {
            // ignore — disk file is the durable record; in-process
            // refresh happens on next SharedTokenManager mtime poll
          }
          // The Qwen IdP token response doesn't carry an
          // `accountAlias`, so return only `{expiresAt}`. A future
          // provider whose token response carries an alias can
          // populate it; the type stays optional.
          return { expiresAt };
        },
        // `unpersist` was removed in favor of honoring the IdP's
        // already-completed approval over a microsecond cancel/dispose
        // race.
      };
    }
    if (isDeviceTokenPending(response)) {
      const pending = response as DeviceTokenPendingData;
      return pending.slowDown ? { kind: 'slow_down' } : { kind: 'pending' };
    }
    // This fall-through is reached only if a future refactor changes
    // the `pollDeviceToken` contract. Map defensively to
    // `upstream_error` with a bounded hint (never forward the raw IdP
    // response body to SDK clients).
    return {
      kind: 'error',
      errorKind: 'upstream_error',
      hint: 'unexpected response from identity provider',
    };
  }
}

/**
 * Map a structured RFC 8628 OAuth error code (from
 * `QwenOAuthPollError.oauthError`) to the registry's
 * `DeviceFlowErrorKind` taxonomy. Unknown / missing codes fall
 * through to `upstream_error`.
 */
function mapRfc8628OAuthCode(code: string | undefined): DeviceFlowErrorKind {
  switch (code) {
    case 'expired_token':
      return 'expired_token';
    case 'access_denied':
      return 'access_denied';
    case 'invalid_grant':
      return 'invalid_grant';
    default:
      return 'upstream_error';
  }
}
