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
  // Strip CR/LF so a crafted header can't forge extra log lines.
  return clipped.replace(/[\r\n]+/g, ' ');
}

/**
 * Parse a `Last-Event-ID` header into a bus event id, shared by the REST
 * (`GET /session/:id/events`) and ACP (`GET /acp`) SSE surfaces so their
 * accept/reject rules can't drift.
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
