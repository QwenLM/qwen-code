/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const REDACTED = '[redacted]';
const DEFAULT_DEBUG_TEXT_LIMIT = 1024;

const SENSITIVE_FIELD_RE =
  /authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|signature|credential|machine[_-]?(token|code|id)|api[_-]?key/i;

export function truncateForDebug(
  value: string,
  limit = DEFAULT_DEBUG_TEXT_LIMIT,
): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}...(truncated)`;
}

export function redactTextForDebug(
  text: string,
  limit = DEFAULT_DEBUG_TEXT_LIMIT,
): string {
  const redacted = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(
      /(["'])([^"']+)\1\s*:\s*(["'])(.*?)\3/g,
      (match, quote: string, key: string, valueQuote: string) =>
        SENSITIVE_FIELD_RE.test(key)
          ? `${quote}${key}${quote}:${valueQuote}${REDACTED}${valueQuote}`
          : match,
    );
  return truncateForDebug(redacted, limit);
}
