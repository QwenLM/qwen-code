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

const SENSITIVE_HEADER_RE =
  /authorization|cookie|token|secret|signature|credential|api[_-]?key/i;

export function truncateForDebug(
  value: string,
  limit = DEFAULT_DEBUG_TEXT_LIMIT,
): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}...(truncated)`;
}

/** Copy request headers for debug logging, masking credential-bearing values. */
export function redactHeadersForDebug(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = SENSITIVE_HEADER_RE.test(name) ? REDACTED : value;
  }
  return result;
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
