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
  unsafeRevealSecret,
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
 * Maximum length of raw IdP detail written to stderr for operator
 * audit. PR #4255 fold-in 6 review thread #5: the raw `err.message`
 * from `QwenOAuth2Client` embeds the full upstream response body,
 * which on a misbehaving reverse proxy / WAF can be megabytes of
 * HTML — and container log-aggregation pipelines (Loki, Fluent Bit,
 * Stackdriver) typically truncate or reject lines past 4–32 KiB,
 * meaning the *useful* prefix is lost downstream. Truncate here so
 * the kept prefix is the part with the actual IdP error code /
 * description, with a `[+N more]` tail so the reader knows how much
 * was dropped. 2 KiB is comfortably below every aggregator's per-line
 * cap and large enough to retain a structured JSON error envelope.
 */
const STDERR_DETAIL_MAX = 2_048;

function truncateForStderr(detail: string): string {
  if (detail.length <= STDERR_DETAIL_MAX) return detail;
  const dropped = detail.length - STDERR_DETAIL_MAX;
  return `${detail.slice(0, STDERR_DETAIL_MAX)}…[+${dropped} bytes truncated]`;
}

/**
 * Strip / replace bytes that could forge log lines or inject terminal
 * control sequences when interpolated into a stderr breadcrumb. PR #4291
 * follow-up review (gpt-5.5, #2): `QwenOAuthPollError.oauthError` comes
 * directly from the upstream JSON `error` field — attacker-controlled
 * if the IdP, a reverse proxy, or a WAF is hostile / compromised. A
 * value like `slow_down\n[serve] FAKE LOG LINE 2026-...` would otherwise
 * forge an extra log line; a value containing `\x1b[…m` could inject
 * ANSI color or cursor-movement sequences into operator terminals.
 *
 * Strips C0 controls (0x00–0x1f), DEL (0x7f), and C1 controls (0x80–0x9f).
 * Replaces each with `?` so the operator can still see SOMETHING was
 * present at that index (length-preserving) instead of silently dropping.
 */
function sanitizeForStderr(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, '?');
}

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
      // PR #4255 review W1: thread `signal` into the IdP fetch so a
      // dispose / cancel during the device-authorization request
      // aborts the in-flight socket immediately. Pre-existing CLI
      // callers don't pass a signal; the optional second arg keeps
      // them compatible.
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
      // PR #4255 fold-in 3 (#9): the raw `err.message` from the
      // QwenOAuth2Client embeds the full IdP response body (which can
      // be HTML from a reverse proxy / WAF — hundreds of bytes,
      // potentially leaking infrastructure detail). Use a stable
      // bounded message for the route response; the original err
      // detail goes through stderr audit only via the registry's
      // standard error path (qwenOAuth2.ts logs via `debugLogger`
      // when needed).
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
      // PR #4255 fold-in 3 (#9): same sanitization as the catch above
      // — well-formed but unsuccessful IdP responses can carry
      // arbitrary `error_description` text that we don't want in the
      // SDK-visible 502 hint. Static message; raw envelope to stderr.
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
      // PR #4255 review S2: do NOT echo the raw thrown message into
      // `hint` — `qwenOAuth2.ts` embeds the entire IdP responseText
      // (which can be an HTML error page from a reverse proxy / WAF
      // running into hundreds of bytes) into the message, and that
      // would flow through `publishWorkspaceEvent` to every SSE
      // subscriber. Use a stable bounded summary; full detail goes
      // through the registry's stderr audit only.
      //
      // PR #4255 fold-in 5 (#4): branch on `instanceof
      // QwenOAuthPollError` and read the structured `oauthError`
      // field instead of substring-matching the message text. The
      // earlier regex was a fragile cross-file string contract that
      // would silently degrade to `upstream_error` if `qwenOAuth2.ts`
      // ever changed its message format. The typed class makes the
      // contract explicit + tsc-checkable.
      const errorKind: DeviceFlowErrorKind =
        err instanceof QwenOAuthPollError
          ? mapRfc8628OAuthCode(err.oauthError)
          : 'upstream_error';
      // PR #4255 follow-up review thread (deepseek-v4-pro): mirror the
      // `start()` path's stderr audit so on-call can distinguish WAF
      // block from network reset from malformed JSON at 3 AM.
      //
      // Three follow-up tightenings:
      //
      // 1. **Skip ONLY when the registry-owned signal aborted (#4291,
      //    follow-up gpt-5.5 review).** Earlier shape also skipped
      //    when `err.name === 'AbortError'`, but `AbortError` can
      //    come from sources WE didn't initiate — upstream IdP TCP
      //    RST, proxy timeout, undici/node-fetch wrapping unrelated
      //    transport failures as AbortError. Those are real failures
      //    that the operator needs visibility into; silently dropping
      //    them was a signal-loss bug. Now we skip iff `opts.signal`
      //    was driven aborted by `cancel()` / `dispose()` — anything
      //    else, including unexpected `AbortError`, falls through to
      //    the sanitized breadcrumb path with `signalAborted=false`.
      //
      // 2. **Don't echo raw `err.message`** (Copilot review on
      //    #4291). `pollDeviceToken` POSTs `device_code` +
      //    `code_verifier` (PKCE) per RFC 8628 §3.4. A WAF / reverse
      //    proxy that echoes the request body in its error response
      //    would put those bearer-equivalent values into daemon
      //    stderr — violating the BrandedSecret-style "secrets never
      //    appear in logs" contract the registry depends on. Log
      //    STRUCTURED diagnostics only: `QwenOAuthPollError.oauthError`
      //    (RFC 8628 §3.5 enum), or for non-OAuth errors, just the
      //    constructor name + a bounded message length so the
      //    on-call still gets a breadcrumb without the request-body
      //    echo path.
      //
      // 3. **Sanitize `oauthError` before interpolation (#4291,
      //    follow-up gpt-5.5 review).** The OAuth error code field
      //    is attacker-controlled JSON from the IdP / proxy / WAF.
      //    A value like `slow_down\n[serve] FAKE LOG ENTRY ...` would
      //    forge additional log lines; a value with `\x1b[31m` could
      //    inject ANSI control sequences into operator terminals.
      //    Strip C0/C1 controls before interpolation.
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
          safeDetail = `${err.name} (message ${err.message.length} bytes; raw suppressed to avoid echoing device_code/PKCE)`;
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
        // PR #4255 review C3 + fold-in 3 (#10): `persist({signal})`
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
          // PR #4255 review W3: `accountAlias` USED to be wired
          // through events / reducer / audit but the Qwen IdP token
          // response doesn't carry one (see DeviceTokenData shape in
          // `qwenOAuth2.ts:152-160` — no `name` / `email` / `sub`
          // field). Returning only `{expiresAt}` makes the field
          // type-honestly absent rather than always-undefined. A
          // future provider whose token response carries an alias
          // can populate it; the type stays optional.
          return { expiresAt };
        },
        // PR #4255 fold-in 3: `unpersist` was removed in favor of
        // honoring the IdP's already-completed approval over a
        // microsecond cancel/dispose race. See registry success
        // branch for the rationale + audit hint.
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
    // `upstream_error` with a bounded hint (PR #4255 review S2 — never
    // forward the raw IdP response body to SDK clients).
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
 * through to `upstream_error`. PR #4255 fold-in 5 (#4) replaced the
 * earlier substring-regex match against the message text, which was
 * an implicit string contract with `qwenOAuth2.ts` that would
 * silently degrade if the message format changed.
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
