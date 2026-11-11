/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  collectErrorCodes,
  collectErrorMessages,
  collectErrorObjects,
  isAbortErrorDeep,
} from '../../utils/errors.js';
import { isProtocolLimitError } from '../../utils/protocol-limits.js';

export type NetworkFailurePhase =
  // Local failure while assembling the request: nothing was sent, the runtime
  // rejected the request the client tried to build (e.g. a header value that is
  // not a valid ByteString). Deterministic, so no route or retry can fix it.
  | 'request_build'
  | 'dns'
  | 'proxy_connect'
  | 'connect'
  | 'tls'
  | 'request_write'
  | 'response_headers'
  | 'http_status'
  | 'first_byte'
  | 'first_event'
  | 'first_payload'
  | 'stream_idle'
  | 'body'
  | 'protocol'
  | 'timeout'
  | 'abort'
  | 'unknown';

export interface NetworkFailurePhaseOptions {
  callerSignal?: AbortSignal;
  deadlineSignal?: AbortSignal;
}

const DNS_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'EAI_FAIL',
  'ENODATA',
  'ENOTFOUND',
  'ESERVFAIL',
]);

const CONNECT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'CONNECTIONREFUSED', // Bun's ConnectionRefused, normalized to uppercase.
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

// These codes are ambiguous: they commonly arrive after request bytes were
// committed while waiting for response headers. Classifying them as connect
// failures would allow non-idempotent requests to be replayed on another IP.
const AMBIGUOUS_POST_COMMIT_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'UND_ERR_SOCKET',
]);

const REQUEST_WRITE_ERROR_CODES = new Set(['EPIPE']);
const RESPONSE_HEADERS_TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT']);
const BODY_TIMEOUT_CODES = new Set(['UND_ERR_BODY_TIMEOUT']);

const TLS_CERTIFICATE_ERROR_CODES = new Set([
  'CERT_UNTRUSTED',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

const TLS_ERROR_CODES = new Set([
  ...TLS_CERTIFICATE_ERROR_CODES,
  'EPROTO',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_TLS_RENEGOTIATION_DISABLED',
  'ERR_SSL_BAD_RECORD_MAC',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
  'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

const PROXY_ERROR_CODES = new Set(['UND_ERR_PROXY']);
const ABORT_ERROR_CODES = new Set(['ABORT_ERR', 'UND_ERR_ABORTED']);

// Runtimes reject a request the client assembled incorrectly before opening a
// socket: Node's http layer uses these codes for illegal header content.
const REQUEST_BUILD_ERROR_CODES = new Set([
  'ERR_INVALID_CHAR',
  'ERR_INVALID_HTTP_TOKEN',
  'ERR_HTTP_INVALID_HEADER_VALUE',
]);

// undici's fetch has no error code for this: it throws a bare TypeError from the
// WebIDL ByteString conversion when a header value carries a code point above
// 255 (a non-ASCII machine hostname, a localized custom header, ...). Bun uses
// `Header '<name>' has invalid value: '<value>'`, also without a code. grpc-js
// reports its metadata validation failure as "illegal characters".
const REQUEST_BUILD_MESSAGE_FRAGMENTS = [
  'convert argument to a bytestring',
  'invalid header value',
  'has invalid value',
  'invalid header name',
  'invalid character in header',
  'contains illegal characters',
] as const;

const FAILURE_PHASES: Set<string> = new Set<NetworkFailurePhase>([
  'request_build',
  'dns',
  'proxy_connect',
  'connect',
  'tls',
  'request_write',
  'response_headers',
  'http_status',
  'first_byte',
  'first_event',
  'first_payload',
  'stream_idle',
  'body',
  'protocol',
  'timeout',
  'abort',
  'unknown',
]);

const PRE_REQUEST_FAILURE_PHASES: ReadonlySet<NetworkFailurePhase> = new Set([
  'dns',
  'proxy_connect',
  'connect',
  'tls',
]);

/** Whether the failure proves the request was never committed to the peer. */
export function isPreRequestFailurePhase(phase: NetworkFailurePhase): boolean {
  return PRE_REQUEST_FAILURE_PHASES.has(phase);
}

/**
 * Whether the phase describes a local client failure instead of a network one.
 *
 * Such failures are deterministic — every route and every retry reproduces them
 * — so they must neither trigger address failover nor be surfaced as network
 * problems. Reporting them as "unable to reach the service" sends users after
 * proxies and DNS while the real cause sits in the request the client built.
 *
 * They are deliberately not part of `PRE_REQUEST_FAILURE_PHASES`: even though no
 * bytes were sent, that set grants pre-request address failover, which would
 * only replay the same local failure against every candidate route.
 */
export function isClientRequestFailurePhase(
  phase: NetworkFailurePhase,
): boolean {
  return phase === 'request_build';
}

export function readNetworkFailurePhase(
  err: unknown,
  options: NetworkFailurePhaseOptions = {},
): NetworkFailurePhase {
  if (isProtocolLimitError(err)) return 'protocol';

  // The caller signal is authoritative. AbortController.abort(reason) accepts
  // any value, so a plain Error reason must not be reclassified as an unknown
  // network failure and wrapped by the retry stack.
  if (options.callerSignal?.aborted) {
    const reasonPhase = readExplicitNetworkFailurePhase(
      options.callerSignal.reason,
    );
    if (reasonPhase && reasonPhase !== 'unknown') return reasonPhase;
    if (isTimeoutReason(options.callerSignal.reason)) return 'timeout';
    return 'abort';
  }

  const explicitPhase = readExplicitNetworkFailurePhase(err);
  if (explicitPhase && explicitPhase !== 'unknown') {
    return explicitPhase;
  }

  const codes = collectErrorCodes(err).map((code) => code.toUpperCase());
  const messages = collectErrorMessages(err).map((message) =>
    message.toLowerCase(),
  );

  const networkPhase = readNetworkFailurePhaseFromCodesAndMessages(
    codes,
    messages,
  );
  if (networkPhase) {
    return networkPhase;
  }

  // A runtime TimeoutError without a more specific phase is a transport
  // timeout; it does not prove that no request bytes reached the peer.
  if (
    collectErrorObjects(err).some(
      (error) => (error as { name?: unknown }).name === 'TimeoutError',
    )
  ) {
    return 'timeout';
  }

  if (options.deadlineSignal?.aborted) {
    return 'timeout';
  }
  if (explicitPhase === 'unknown') {
    return 'unknown';
  }
  if (
    isAbortErrorDeep(err) ||
    codes.some((code) => ABORT_ERROR_CODES.has(code))
  ) {
    return 'abort';
  }
  return 'unknown';
}

/**
 * A TLS certificate-validation failure on a route already classified as
 * `tls`. Callers use this predicate to keep certificate errors out of
 * persistent route-health penalties and conservative cross-host fallback.
 * Same-host address failover remains safe when the request contract permits it:
 * edge routes can present different chains and no HTTP request was committed.
 */
export function isTlsCertRouteFailure(
  phase: NetworkFailurePhase,
  error: unknown,
): boolean {
  return phase === 'tls' && isTlsCertificateValidationFailure(error);
}

export function readExplicitNetworkFailurePhase(
  err: unknown,
): NetworkFailurePhase | undefined {
  for (const obj of collectErrorObjects(err)) {
    const phase = (obj as Record<string, unknown>)['phase'];
    if (isNetworkFailurePhase(phase)) return phase;
  }
  return undefined;
}

/**
 * Classifies a failure using only machine-readable error codes, ignoring the
 * message fallbacks used for diagnostics. Retry policy needs this for raw
 * runtime errors that reach it without a transport-provided phase — an SSE body
 * read rethrows the runtime error as-is — while free-form provider text must
 * still never turn an arbitrary error into a retry.
 */
export function readNetworkFailurePhaseFromErrorCodes(
  err: unknown,
): NetworkFailurePhase | undefined {
  return readNetworkFailurePhaseFromCodesAndMessages(
    collectErrorCodes(err).map((code) => code.toUpperCase()),
    [],
  );
}

function readNetworkFailurePhaseFromCodesAndMessages(
  codes: string[],
  messages: string[],
): NetworkFailurePhase | undefined {
  // Checked first: the runtime refused to build the request, so no network phase
  // applies and the failure must not fall through to `unknown`.
  if (
    codes.some((code) => REQUEST_BUILD_ERROR_CODES.has(code)) ||
    messages.some((message) => isRequestBuildFailureMessage(message))
  ) {
    return 'request_build';
  }
  if (
    codes.some((code) => DNS_ERROR_CODES.has(code)) ||
    messages.some((message) => isDnsFailureMessage(message))
  ) {
    return 'dns';
  }
  if (codes.some((code) => TLS_ERROR_CODES.has(code))) {
    return 'tls';
  }
  if (
    codes.some((code) => PROXY_ERROR_CODES.has(code)) ||
    messages.some((message) => isProxyFailureMessage(message))
  ) {
    return 'proxy_connect';
  }
  if (
    codes.some((code) => REQUEST_WRITE_ERROR_CODES.has(code)) ||
    messages.some((message) => isRequestWriteFailureMessage(message))
  ) {
    return 'request_write';
  }
  if (
    codes.some((code) => AMBIGUOUS_POST_COMMIT_ERROR_CODES.has(code)) ||
    messages.some((message) => isPeerSocketClosedMessage(message))
  ) {
    return 'response_headers';
  }
  if (
    codes.some((code) => CONNECT_ERROR_CODES.has(code)) ||
    messages.some((message) => isConnectFailureMessage(message))
  ) {
    return 'connect';
  }
  if (
    codes.some((code) => RESPONSE_HEADERS_TIMEOUT_CODES.has(code)) ||
    messages.some((message) => isResponseHeadersTimeoutMessage(message))
  ) {
    return 'response_headers';
  }
  if (
    codes.some((code) => BODY_TIMEOUT_CODES.has(code)) ||
    messages.some((message) => isBodyTimeoutMessage(message))
  ) {
    return 'body';
  }
  if (messages.some((message) => isTlsFailureMessage(message))) {
    return 'tls';
  }
  // Node can surface a bare ETIMEDOUT for TCP connection establishment. More
  // specific timeout codes/messages above retain their concrete phases.
  if (codes.includes('ETIMEDOUT')) {
    return 'connect';
  }
  return undefined;
}

function isTlsFailureMessage(message: string): boolean {
  return (
    message.includes('tls handshake') ||
    message.includes('ssl routines') ||
    message.includes('sslv3 alert') ||
    message.includes('wrong version number') ||
    isTlsCertificateValidationMessage(message)
  );
}

export function isTlsCertificateValidationFailure(error: unknown): boolean {
  const codes = collectErrorCodes(error).map((code) => code.toUpperCase());
  if (codes.some((code) => TLS_CERTIFICATE_ERROR_CODES.has(code))) {
    return true;
  }
  return collectErrorMessages(error).some((message) =>
    isTlsCertificateValidationMessage(message.toLowerCase()),
  );
}

const TLS_CERTIFICATE_MESSAGE_FRAGMENTS = [
  'cert_altname',
  'unable to verify the first certificate',
  'unable to get issuer certificate',
  'unable to get local issuer certificate',
  'self signed certificate',
  'self-signed certificate',
  'certificate has expired',
  'certificate is not yet valid',
  'certificate verify failed',
  'certificate verification failed',
  'certificate is not trusted',
  'certificate is untrusted',
  'certificate revoked',
  'certificate signature failure',
  "does not match certificate's altnames",
] as const;

function isTlsCertificateValidationMessage(message: string): boolean {
  return TLS_CERTIFICATE_MESSAGE_FRAGMENTS.some((fragment) =>
    message.includes(fragment),
  );
}

function isProxyFailureMessage(message: string): boolean {
  return (
    message.includes('proxy connect') ||
    message.includes('proxy tunnel') ||
    message.includes('socks5 proxy') ||
    message.includes('proxy authentication')
  );
}

function isResponseHeadersTimeoutMessage(message: string): boolean {
  return (
    message.includes('request timed out') ||
    message.includes('request timeout') ||
    message.includes('headers timeout') ||
    message.includes('headers timed out') ||
    message.includes('response headers')
  );
}

function isBodyTimeoutMessage(message: string): boolean {
  return message.includes('body timeout') || message.includes('body idle');
}

function isConnectFailureMessage(message: string): boolean {
  return (
    message.includes('connect etimedout') ||
    message.includes('connect econnrefused') ||
    message.includes('connect ehostunreach') ||
    message.includes('connect enetunreach') ||
    message.includes('connect timed out') ||
    message.includes('target connect timed out') ||
    message.includes('connection refused') ||
    message.includes('network unreachable') ||
    message.includes('host unreachable')
  );
}

function isDnsFailureMessage(message: string): boolean {
  return (
    message.includes('getaddrinfo enotfound') ||
    message.includes('getaddrinfo eai_again') ||
    message.includes('dns resolution failed')
  );
}

/**
 * Runtime-specific wordings for "the peer closed this socket". undici reports
 * `other side closed`, Bun historically reported `socket connection was closed
 * unexpectedly`, and Node reports `socket hang up`.
 */
const PEER_SOCKET_CLOSED_MESSAGE_FRAGMENTS = [
  'socket closed',
  'socket hang up',
  'other side closed',
  'socket connection was closed unexpectedly',
] as const;

/** Whether the message reports the peer dropping the socket, in any runtime. */
export function isPeerSocketClosedMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return PEER_SOCKET_CLOSED_MESSAGE_FRAGMENTS.some((fragment) =>
    lower.includes(fragment),
  );
}

function isRequestBuildFailureMessage(message: string): boolean {
  return REQUEST_BUILD_MESSAGE_FRAGMENTS.some((fragment) =>
    message.includes(fragment),
  );
}

function isRequestWriteFailureMessage(message: string): boolean {
  return message.includes('write epipe') || message.includes('broken pipe');
}

function isNetworkFailurePhase(value: unknown): value is NetworkFailurePhase {
  return typeof value === 'string' && FAILURE_PHASES.has(value);
}

function isTimeoutReason(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const reason = value as { name?: unknown; code?: unknown };
  return reason.name === 'TimeoutError' || reason.code === 'ETIMEDOUT';
}

/** 显式网络阶段优先，其次判断深层取消错误。 */
export function isApiRequestAbort(error: unknown): boolean {
  const phase = readExplicitNetworkFailurePhase(error);
  return phase !== undefined ? phase === 'abort' : isAbortErrorDeep(error);
}
