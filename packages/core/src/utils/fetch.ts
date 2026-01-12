/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getErrorMessage, isNodeError } from './errors.js';
import { URL } from 'node:url';

const PRIVATE_IP_RANGES = [
  /^10\./,
  /^127\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^::1$/,
  /^fc00:/,
  /^fe80:/,
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

export function isPrivateIp(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return PRIVATE_IP_RANGES.some((range) => range.test(hostname));
  } catch (_e) {
    return false;
  }
}

export async function fetchWithTimeout(
  url: string,
  timeout: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ABORT_ERR') {
      throw new FetchError(`Request timed out after ${timeout}ms`, 'ETIMEDOUT');
    }
    throw new FetchError(getErrorMessage(error));
  } finally {
    clearTimeout(timeoutId);
  }
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
      ? [
          '- If your network uses a corporate TLS inspection CA, set `NODE_EXTRA_CA_CERTS` to your CA bundle.',
        ]
      : []),
  ];

  return `${fullErrorMessage}${hintLines.join('\n')}`;
}
