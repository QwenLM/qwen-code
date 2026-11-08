/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const INTERNAL_SESSION_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(-agent-[a-zA-Z0-9_.-]+)?$/i;

// Caller IDs stay a strict subset of internal IDs so every accepted value is
// also reachable through CLI resume validation and cannot claim Arena suffixes.
const CALLER_SUPPLIED_SESSION_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CallerSuppliedSessionIdParseResult =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'valid'; sessionId: string };

export function isValidSessionId(value: string): boolean {
  return INTERNAL_SESSION_ID_REGEX.test(value);
}

/**
 * Canonicalize caller-visible UUIDs without changing internal or legacy IDs.
 * Internal Arena agent IDs and legacy IDs preserve their existing spelling.
 */
export function normalizeSessionIdForLookup(value: string): string {
  return CALLER_SUPPLIED_SESSION_ID_REGEX.test(value)
    ? value.toLowerCase()
    : value;
}

export function parseCallerSuppliedSessionId(
  value: unknown,
): CallerSuppliedSessionIdParseResult {
  if (value === undefined || value === null) return { kind: 'absent' };
  if (
    typeof value !== 'string' ||
    !CALLER_SUPPLIED_SESSION_ID_REGEX.test(value)
  ) {
    return { kind: 'invalid' };
  }
  return { kind: 'valid', sessionId: normalizeSessionIdForLookup(value) };
}
