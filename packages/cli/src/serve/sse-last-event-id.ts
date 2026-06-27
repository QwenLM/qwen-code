/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeStderrLine } from '../utils/stdioHelpers.js';

/** Truncate + sanitize an untrusted header value for a single log line. */
function safeLogValue(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : String(raw);
  const clipped = s.length > 64 ? `${s.slice(0, 64)}…` : s;
  // Strip ALL C0 control chars + DEL (covers CR/LF log-forging AND ANSI ESC
  // `\x1b` / null bytes a crafted header could use to manipulate an operator's
  // terminal when this value is written to stderr). Matching control chars in
  // the regex is the intent here, so the lint rule is deliberately disabled.
  // eslint-disable-next-line no-control-regex
  return clipped.replace(/[\x00-\x1f\x7f]+/g, ' ');
}

/**
 * Parse a `Last-Event-ID` header into a bus event id for the ACP `GET /acp`
 * SSE surface.
 *
 * NOTE: the REST `GET /session/:id/events` surface still has its own copy in
 * `server/request-helpers.ts` (the two implement the same accept/reject rule).
 * Unifying them onto this util is a worthwhile cleanup but is deliberately
 * deferred: it would change the REST surface, and this PR keeps REST untouched
 * (no behavioural side effects). Tracked as a follow-up.
 *
 * Stricter than `Number.parseInt`: accept ONLY pure decimal digits (so
 * "1abc" / "1.5" don't silently parse to 1) and reject values past
 * `Number.MAX_SAFE_INTEGER` (the EventBus's monotonic ids are bounded by it).
 * Returns `undefined` for missing/invalid headers ⇒ live-only subscription.
 * Rejections are logged with the offending value for operators; the common
 * "first connect, no resume" case (missing/empty header) is silent.
 *
 * @param logPrefix distinguishes the surface in logs, e.g. `'/acp '` vs `''`.
 */
export function parseLastEventId(
  raw: unknown,
  logPrefix = '',
): number | undefined {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    if (typeof raw === 'string' && raw.length > 0) {
      writeStderrLine(
        `qwen serve: ${logPrefix}rejected Last-Event-ID ${safeLogValue(raw)} ` +
          `(not a decimal integer)`,
      );
    }
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER) {
    writeStderrLine(
      `qwen serve: ${logPrefix}rejected Last-Event-ID ${safeLogValue(raw)} ` +
        `(exceeds Number.MAX_SAFE_INTEGER)`,
    );
    return undefined;
  }
  return n;
}
