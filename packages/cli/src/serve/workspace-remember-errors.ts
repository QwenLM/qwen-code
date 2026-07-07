/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
