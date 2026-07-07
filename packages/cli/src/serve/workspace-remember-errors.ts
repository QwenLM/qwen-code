/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { redactLogCredentials } from '@qwen-code/acp-bridge/logRedaction';

const MAX_REMEMBER_ERROR_DETAILS_CHARS = 1000;
const MAX_REMEMBER_ERROR_CAUSE_DEPTH = 50;
const REMEMBER_ERROR_INVISIBLE_RE =
  /[\p{Cf}\u2028\u2029]|\p{Variation_Selector}/gu;
const REMEMBER_ERROR_AUTH_SCHEME_INVISIBLE_RE =
  /\b(Bearer|QQBot)(?:[\p{Cf}\u2028\u2029]|\p{Variation_Selector})+(?=[A-Za-z0-9._~+/=-])/giu;
// eslint-disable-next-line no-control-regex
const REMEMBER_ERROR_CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;

function errorCodeFromRecord(
  record: Record<string, unknown>,
): string | undefined {
  if (typeof record['code'] === 'string') return record['code'];
  const data = record['data'];
  if (data && typeof data === 'object') {
    const dataRecord = data as Record<string, unknown>;
    if (typeof dataRecord['errorKind'] === 'string') {
      return dataRecord['errorKind'];
    }
    if (typeof dataRecord['code'] === 'string') return dataRecord['code'];
  }
  return undefined;
}

function rawRememberErrorCode(
  err: unknown,
  seen: WeakSet<object>,
  depth: number,
): string | undefined {
  if (depth > MAX_REMEMBER_ERROR_CAUSE_DEPTH) return undefined;
  if (!err || typeof err !== 'object') return undefined;
  if (seen.has(err)) return undefined;
  seen.add(err);

  const record = err as Record<string, unknown>;
  const direct = errorCodeFromRecord(record);
  if (direct) return direct;

  const cause = record['cause'];
  if (cause != null) {
    return rawRememberErrorCode(cause, seen, depth + 1);
  }

  return undefined;
}

export function extractRememberErrorCode(
  err: unknown,
  fallback = 'remember_failed',
): string {
  return rawRememberErrorCode(err, new WeakSet<object>(), 0) ?? fallback;
}

function detailFromRecord(
  record: Record<string, unknown>,
  seen: WeakSet<object>,
  depth: number,
): string | undefined {
  // Bridge errors carry the best failure reason in `data`; top-level
  // `message` and `cause` are generic fallbacks.
  const data = record['data'];
  if (data && typeof data === 'object') {
    const dataRecord = data as Record<string, unknown>;
    const details = dataRecord['details'];
    if (typeof details === 'string' && details.length > 0) return details;
    const message = dataRecord['message'];
    if (typeof message === 'string' && message.length > 0) return message;
  }

  const message = record['message'];
  if (typeof message === 'string' && message.length > 0) return message;

  if (typeof data === 'string' && data.length > 0) return data;

  const cause = record['cause'];
  if (cause != null) {
    return rawRememberErrorDetails(cause, seen, depth + 1);
  }

  return undefined;
}

function rawRememberErrorDetails(
  err: unknown,
  seen: WeakSet<object>,
  depth: number,
): string | undefined {
  if (depth > MAX_REMEMBER_ERROR_CAUSE_DEPTH) return undefined;
  if (typeof err === 'string' && err.length > 0) return err;
  if (!err || typeof err !== 'object') return undefined;
  if (seen.has(err)) return undefined;
  seen.add(err);
  return detailFromRecord(err as Record<string, unknown>, seen, depth);
}

function replaceControlChars(details: string): string {
  return details
    .replace(REMEMBER_ERROR_AUTH_SCHEME_INVISIBLE_RE, '$1 ')
    .replace(REMEMBER_ERROR_INVISIBLE_RE, '')
    .replace(REMEMBER_ERROR_CONTROL_RE, ' ');
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function truncateBeforeDanglingSurrogate(
  details: string,
  cutPoint: number,
): number {
  const beforeCut = details.charCodeAt(cutPoint - 1);
  const atCut = details.charCodeAt(cutPoint);
  if (isHighSurrogate(beforeCut) && isLowSurrogate(atCut)) {
    return cutPoint - 1;
  }
  return cutPoint;
}

function sanitizeRememberErrorDetails(details: string): string | undefined {
  const normalized = replaceControlChars(details);
  const redacted = redactLogCredentials(normalized).trim();
  if (!redacted) return undefined;
  if (redacted.length <= MAX_REMEMBER_ERROR_DETAILS_CHARS) {
    return redacted;
  }
  const truncationSuffix = '... [truncated]';
  const cutPoint = truncateBeforeDanglingSurrogate(
    redacted,
    MAX_REMEMBER_ERROR_DETAILS_CHARS - truncationSuffix.length,
  );
  return `${redacted.slice(0, cutPoint)}${truncationSuffix}`;
}

export function extractRememberErrorDetails(err: unknown): string | undefined {
  const raw = rawRememberErrorDetails(err, new WeakSet<object>(), 0);
  if (!raw) return undefined;
  return sanitizeRememberErrorDetails(raw);
}

export function extractRememberErrorStack(err: unknown): string | undefined {
  if (!(err instanceof Error) || !err.stack) return undefined;
  return sanitizeRememberErrorDetails(err.stack);
}
