/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getErrorMessage } from './errors.js';
import { delay } from './retry.js';
import { isTlsVerificationDisabled } from './runtimeFetchOptions.js';
import { URL } from 'node:url';

const PRIVATE_IP_RANGES = [
  /^10\./,
  /^127\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  // IPv4 link-local (incl. cloud metadata endpoints) and CGNAT 100.64.0.0/10.
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^::$/,
  // ULA fc00::/7 covers fc00: through fdff: (fd00: is the common prefix in
  // practice); link-local fe80::/10 covers fe80: through febf:.
  /^f[cd][0-9a-f]{2}:/i,
  /^fe[89ab][0-9a-f]:/i,
];

const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const FETCH_TROUBLESHOOTING_ERROR_CODES = new Set([
  ...TLS_ERROR_CODES,
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

export class FetchError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

// Errors indicating the connection/TLS handshake itself failed — the class
// where falling back from an opportunistic https upgrade to the originally
// requested http URL is reasonable (e.g. an intranet FQDN that resolves to
// a private address and only serves plain http).
const CONNECTION_LEVEL_ERROR_CODES = new Set([
  ...TLS_ERROR_CODES,
  'ECONNREFUSED',
  'EPROTO',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  // Servers that don't speak TLS on 443 often reset during the handshake
  // rather than refusing the connection. Safe to include: the http fallback
  // only ever fires for URLs the caller requested as http.
  'ECONNRESET',
  'UND_ERR_SOCKET',
  // Filtered port 443 (silent drop): undici's own bounded connect timeout.
  // Deliberately NOT the full-budget ETIMEDOUT — that can fire mid-body on
  // a healthy https server, and a fallback there would double a worst-case
  // 60s wait for an ambiguous gain.
  'UND_ERR_CONNECT_TIMEOUT',
]);

export function isConnectionLevelError(error: unknown): boolean {
  return (
    error instanceof FetchError &&
    error.code !== undefined &&
    CONNECTION_LEVEL_ERROR_CODES.has(error.code)
  );
}

// IPv4-mapped IPv6 (::ffff:a.b.c.d) — the URL API may normalize the tail to
// hex groups (::ffff:7f00:1), so translate back to dotted form for the IPv4
// range checks.
function mappedIpv4(hostname: string): string | undefined {
  const match = /^::ffff:(.+)$/i.exec(hostname);
  if (!match) return undefined;
  const tail = match[1]!;
  if (tail.includes('.')) return tail;
  const groups = tail.split(':');
  if (groups.length !== 2) return undefined;
  const hi = Number.parseInt(groups[0]!, 16);
  const lo = Number.parseInt(groups[1]!, 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) return undefined;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

export function isPrivateIp(url: string): boolean {
  try {
    // The URL API brackets IPv6 hostnames ([::1]); strip them so the IPv6
    // ranges above can actually match.
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
    const target = mappedIpv4(hostname) ?? hostname;
    return PRIVATE_IP_RANGES.some((range) => range.test(target));
  } catch (_e) {
    return false;
  }
}

// Suffixes conventionally used for non-public hostnames. Getting this wrong
// only affects callers' https upgrades (an internal http host wrongly
// upgraded would fail to connect), so err on the side of matching more.
const INTERNAL_HOST_SUFFIXES = ['.local', '.internal', '.lan', '.home.arpa'];

/** Generalizes isPrivateIp to hostnames that are never publicly routable. */
export function isPrivateHost(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === 'host.docker.internal' ||
      // Single-label hostnames (intranet, ci, printserver) are never public.
      // IPv6 literals are bracketed and dot-free but CAN be public — they
      // are classified by isPrivateIp below, not by this heuristic.
      (!hostname.includes('.') && !hostname.startsWith('[')) ||
      INTERNAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
      isPrivateIp(url)
    );
  } catch {
    return false;
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * A redirect is followed silently only when it stays on the same host
 * (allowing a leading "www." to be added or removed), same protocol and
 * port, and carries no credentials. Anything else is surfaced to the
 * caller: WebFetch permission rules are domain-scoped, so silently
 * following a cross-host redirect would fetch from a domain the user
 * never approved.
 */
export function isPermittedRedirect(
  originalUrl: string,
  redirectUrl: string,
): boolean {
  try {
    const original = new URL(originalUrl);
    const redirect = new URL(redirectUrl);
    if (redirect.protocol !== original.protocol) return false;
    if (redirect.port !== original.port) return false;
    if (redirect.username || redirect.password) return false;
    const stripWww = (hostname: string) => hostname.replace(/^www\./, '');
    return stripWww(original.hostname) === stripWww(redirect.hostname);
  } catch {
    return false;
  }
}

export interface FetchPolicyOptions {
  /** Budget for the entire transfer — headers AND body. */
  timeoutMs: number;
  /** Reject responses larger than this, before or during body read. */
  maxBytes: number;
  /** Same-host redirect hops to follow before erroring. */
  maxRedirects: number;
  headers?: Record<string, string>;
  /** Caller cancellation (e.g. the tool's abort signal). */
  signal?: AbortSignal;
}

export interface FetchPolicyResponse {
  kind: 'response';
  status: number;
  statusText: string;
  contentType: string;
  /** Content-Disposition header, if any — carries the server's filename. */
  contentDisposition: string;
  body: Buffer;
  /** URL after any followed same-host redirects. */
  finalUrl: string;
}

export interface FetchPolicyRedirect {
  kind: 'cross-host-redirect';
  originalUrl: string;
  redirectUrl: string;
  status: number;
}

export type FetchPolicyResult = FetchPolicyResponse | FetchPolicyRedirect;

// One retry, narrow triggers: transient blocks/rate limits and connection
// resets. Not 404s (deterministic), not timeouts (budget already spent).
const RETRYABLE_STATUSES = new Set([403, 429]);
// UND_ERR_SOCKET is undici's representation of a peer-closed/reset socket —
// the same class as ECONNRESET (see stream-transport-retry.ts).
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
]);
const RETRY_DELAY_MS = 500;

/**
 * Fetch with manual redirect handling, a full-transfer timeout, a byte cap
 * enforced while streaming, caller-abort wiring, and a single retry on
 * transient failures (403/429 statuses, connection resets). Uses the global
 * fetch so the process-wide proxy dispatcher (setGlobalDispatcher) applies.
 * The timeout budget spans both attempts.
 */
export async function fetchWithPolicy(
  url: string,
  options: FetchPolicyOptions,
): Promise<FetchPolicyResult> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  // Maps an abort observed during the retry window to the caller's
  // cancellation or the timeout error; undefined when not aborted.
  const abortError = (): Error | undefined => {
    if (options.signal?.aborted) {
      return options.signal.reason instanceof Error
        ? options.signal.reason
        : new FetchError('Request aborted', 'ABORT_ERR');
    }
    if (timeoutSignal.aborted) {
      return new FetchError(
        `Request timed out after ${options.timeoutMs}ms`,
        'ETIMEDOUT',
      );
    }
    return undefined;
  };

  let first: FetchPolicyResult;
  try {
    first = await fetchPolicyAttempt(url, options, signal, timeoutSignal);
  } catch (error) {
    if (
      error instanceof FetchError &&
      error.code !== undefined &&
      RETRYABLE_ERROR_CODES.has(error.code) &&
      !signal.aborted
    ) {
      try {
        await delay(RETRY_DELAY_MS, signal);
      } catch {
        throw abortError() ?? error;
      }
      return fetchPolicyAttempt(url, options, signal, timeoutSignal);
    }
    throw error;
  }

  if (
    first.kind === 'response' &&
    RETRYABLE_STATUSES.has(first.status) &&
    !signal.aborted
  ) {
    try {
      await delay(RETRY_DELAY_MS, signal);
      return await fetchPolicyAttempt(url, options, signal, timeoutSignal);
    } catch {
      // Cancellation/timeout must win over "return the original response" —
      // the tool must report the abort, not a stale 403.
      const aborted = abortError();
      if (aborted) throw aborted;
      // The retry failed outright — the original response is still the most
      // informative outcome we have.
      return first;
    }
  }
  return first;
}

async function fetchPolicyAttempt(
  url: string,
  options: FetchPolicyOptions,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
): Promise<FetchPolicyResult> {
  const wrapAbort = (error: unknown): never => {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new FetchError('Request aborted', 'ABORT_ERR');
    }
    if (timeoutSignal.aborted) {
      throw new FetchError(
        `Request timed out after ${options.timeoutMs}ms`,
        'ETIMEDOUT',
      );
    }
    if (error instanceof FetchError) throw error;
    const code =
      getErrorCode(error) ??
      (error instanceof Error
        ? getErrorCode((error as Error & { cause?: unknown }).cause)
        : undefined);
    throw new FetchError(getErrorMessage(error), code);
  };

  let currentUrl = url;
  for (let hop = 0; hop <= options.maxRedirects; hop++) {
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        signal,
        headers: options.headers,
        redirect: 'manual',
      });
    } catch (error) {
      return wrapAbort(error);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) {
        throw new FetchError('Redirect response missing Location header');
      }
      const redirectUrl = new URL(location, currentUrl).toString();
      if (!isPermittedRedirect(currentUrl, redirectUrl)) {
        return {
          kind: 'cross-host-redirect',
          originalUrl: currentUrl,
          redirectUrl,
          status: response.status,
        };
      }
      currentUrl = redirectUrl;
      continue;
    }

    // The sole caller discards the body of every non-2xx response (only the
    // status/statusText feed its failure message, and the 403/429 retry path
    // inspects the status alone). Cancel the body without buffering it:
    // otherwise an oversized error page reports EMSGSIZE instead of its real
    // status, and a slow-trickling error body can burn the whole timeout for
    // bytes that are never read.
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => {});
      return {
        kind: 'response',
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get('content-type') ?? '',
        contentDisposition: response.headers.get('content-disposition') ?? '',
        body: Buffer.alloc(0),
        finalUrl: currentUrl,
      };
    }

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new FetchError(
        `Response too large: ${contentLength} bytes exceeds the ${options.maxBytes}-byte limit`,
        'EMSGSIZE',
      );
    }

    // Chunks are retained as-is (undici yields a fresh Uint8Array per read);
    // Buffer.concat below performs the single necessary copy.
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > options.maxBytes) {
            throw new FetchError(
              `Response too large: exceeded the ${options.maxBytes}-byte limit while streaming`,
              'EMSGSIZE',
            );
          }
          chunks.push(value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        if (error instanceof FetchError) throw error;
        return wrapAbort(error);
      } finally {
        reader.releaseLock();
      }
    }

    return {
      kind: 'response',
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type') ?? '',
      contentDisposition: response.headers.get('content-disposition') ?? '',
      body: Buffer.concat(chunks, total),
      finalUrl: currentUrl,
    };
  }
  throw new FetchError(
    `Too many redirects (exceeded ${options.maxRedirects})`,
    'EMAXREDIRECTS',
  );
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  if (
    'code' in error &&
    typeof (error as Record<string, unknown>)['code'] === 'string'
  ) {
    return (error as Record<string, string>)['code'];
  }

  return undefined;
}

function formatUnknownErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') {
    return error;
  }

  if (
    typeof error === 'number' ||
    typeof error === 'boolean' ||
    typeof error === 'bigint'
  ) {
    return String(error);
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const message = (error as Record<string, unknown>)['message'];
  if (typeof message === 'string') {
    return message;
  }

  return undefined;
}

function formatErrorCause(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const cause = (error as Error & { cause?: unknown }).cause;
  if (!cause) {
    return undefined;
  }

  const causeCode = getErrorCode(cause);
  const causeMessage = formatUnknownErrorMessage(cause);

  if (!causeCode && !causeMessage) {
    return undefined;
  }

  if (causeCode && causeMessage && !causeMessage.includes(causeCode)) {
    return `${causeCode}: ${causeMessage}`;
  }

  return causeMessage ?? causeCode;
}

export function formatFetchErrorForUser(
  error: unknown,
  options: { url?: string } = {},
): string {
  const errorMessage = getErrorMessage(error);

  const code =
    error instanceof Error
      ? (getErrorCode((error as Error & { cause?: unknown }).cause) ??
        getErrorCode(error))
      : getErrorCode(error);

  const cause = formatErrorCause(error);
  const fullErrorMessage = [
    errorMessage,
    cause ? `(cause: ${cause})` : undefined,
  ]
    .filter(Boolean)
    .join(' ');

  const shouldShowFetchHints =
    errorMessage.toLowerCase().includes('fetch failed') ||
    (code != null && FETCH_TROUBLESHOOTING_ERROR_CODES.has(code));

  const shouldShowTlsHint = code != null && TLS_ERROR_CODES.has(code);

  if (!shouldShowFetchHints) {
    return fullErrorMessage;
  }

  const hintLines = [
    '',
    'Troubleshooting:',
    ...(options.url
      ? [`- Confirm you can reach ${options.url} from this machine.`]
      : []),
    '- If you are behind a proxy, pass `--proxy <url>` (or set `proxy` in settings).',
    ...(shouldShowTlsHint
      ? isTlsVerificationDisabled()
        ? [
            '- TLS verification is already disabled (`--insecure` / `QWEN_TLS_INSECURE`), so this is likely a network or protocol issue rather than a certificate trust problem.',
          ]
        : [
            '- If your network uses a corporate TLS inspection CA, set `NODE_EXTRA_CA_CERTS` to your CA bundle.',
            '- For a trusted self-signed endpoint, pass `--insecure` (or set `QWEN_TLS_INSECURE=1`) to skip certificate verification.',
          ]
      : []),
  ];

  return `${fullErrorMessage}${hintLines.join('\n')}`;
}
