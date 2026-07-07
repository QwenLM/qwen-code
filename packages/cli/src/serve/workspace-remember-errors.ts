/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { redactLogCredentials } from '@qwen-code/acp-bridge/logRedaction';

const MAX_REMEMBER_ERROR_DETAILS_CHARS = 1000;
const MAX_REMEMBER_ERROR_CAUSE_DEPTH = 50;

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

function shouldReplaceControlChar(code: number): boolean {
  return (
    code <= 31 ||
    (code >= 127 && code <= 159) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

function replaceControlChars(details: string): string {
  let normalized = '';
  let last = 0;
  for (let index = 0; index < details.length; ) {
    const code = details.codePointAt(index);
    if (code === undefined) break;
    const width = code > 0xffff ? 2 : 1;
    if (shouldReplaceControlChar(code)) {
      normalized += details.slice(last, index) + ' ';
      last = index + width;
    }
    index += width;
  }
  return last === 0 ? details : normalized + details.slice(last);
}

function sanitizeRememberErrorDetails(details: string): string | undefined {
  const redacted = redactLogCredentials(details);
  const normalized = redactLogCredentials(replaceControlChars(redacted)).trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_REMEMBER_ERROR_DETAILS_CHARS) {
    return normalized;
  }
  const truncationSuffix = '... [truncated]';
  let cutPoint = MAX_REMEMBER_ERROR_DETAILS_CHARS - truncationSuffix.length;
  const codeUnit = normalized.charCodeAt(cutPoint - 1);
  if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
    cutPoint -= 1;
  }
  return `${normalized.slice(0, cutPoint)}${truncationSuffix}`;
}

export function extractRememberErrorDetails(err: unknown): string | undefined {
  const raw = rawRememberErrorDetails(err, new WeakSet<object>(), 0);
  if (!raw) return undefined;
  return sanitizeRememberErrorDetails(raw);
}
