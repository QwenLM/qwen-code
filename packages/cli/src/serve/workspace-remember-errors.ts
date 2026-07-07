/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { redactLogCredentials } from '@qwen-code/acp-bridge/logRedaction';

const MAX_REMEMBER_ERROR_DETAILS_CHARS = 1000;

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

export function extractRememberErrorCode(
  err: unknown,
  fallback = 'remember_failed',
): string {
  if (err && typeof err === 'object') {
    const record = err as Record<string, unknown>;
    const direct = errorCodeFromRecord(record);
    if (direct) return direct;
    const cause = record['cause'];
    if (cause && typeof cause === 'object') {
      const causedBy = errorCodeFromRecord(cause as Record<string, unknown>);
      if (causedBy) return causedBy;
    }
  }
  return fallback;
}

function detailFromRecord(
  record: Record<string, unknown>,
  seen: WeakSet<object>,
): string | undefined {
  const data = record['data'];
  if (typeof data === 'string' && data.length > 0) return data;
  if (data && typeof data === 'object') {
    const dataRecord = data as Record<string, unknown>;
    const details = dataRecord['details'];
    if (typeof details === 'string' && details.length > 0) return details;
    const message = dataRecord['message'];
    if (typeof message === 'string' && message.length > 0) return message;
  }

  const message = record['message'];
  if (typeof message === 'string' && message.length > 0) return message;

  const cause = record['cause'];
  if (cause && typeof cause === 'object') {
    return rawRememberErrorDetails(cause, seen);
  }

  return undefined;
}

function rawRememberErrorDetails(
  err: unknown,
  seen: WeakSet<object>,
): string | undefined {
  if (typeof err === 'string' && err.length > 0) return err;
  if (!err || typeof err !== 'object') return undefined;
  if (seen.has(err)) return undefined;
  seen.add(err);
  return detailFromRecord(err as Record<string, unknown>, seen);
}

function replaceControlChars(details: string): string {
  return Array.from(details, (char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || (code >= 127 && code <= 159) ? ' ' : char;
  }).join('');
}

function sanitizeRememberErrorDetails(details: string): string | undefined {
  const normalized = replaceControlChars(redactLogCredentials(details)).trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_REMEMBER_ERROR_DETAILS_CHARS) {
    return normalized;
  }
  const truncationSuffix = '... [truncated]';
  return `${normalized.slice(
    0,
    MAX_REMEMBER_ERROR_DETAILS_CHARS - truncationSuffix.length,
  )}${truncationSuffix}`;
}

export function extractRememberErrorDetails(err: unknown): string | undefined {
  const raw = rawRememberErrorDetails(err, new WeakSet<object>());
  if (!raw) return undefined;
  return sanitizeRememberErrorDetails(raw);
}
