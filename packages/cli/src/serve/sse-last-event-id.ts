/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeStderrLine } from '../utils/stdioHelpers.js';
import { logSafe } from './acp-http/json-rpc.js';

/** Truncate + sanitize an untrusted header value for a single log line. */
function safeLogValue(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : String(raw);
  const clipped = s.length > 64 ? `${s.slice(0, 64)}…` : s;
  // Reuse the shared sanitizer so this surface can't drift: `logSafe` strips C0
  // controls + DEL AND the C1 controls (\x80-\x9f, incl. 8-bit CSI \x9b) and
  // Unicode bidi/format chars (U+202E RTL override, zero-width, BOM) a crafted
  // `Last-Event-ID` could use to spoof or split an operator's stderr log line.
  return logSafe(clipped);
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

/**
 * Parse an `X-Qwen-Event-Epoch` request header into an epoch token for the
 * EventBus stale-cursor detection (DAEMON-001). Shared by the REST
 * `GET /session/:id/events` surface and the ACP `GET /acp` surface — a
 * single implementation on purpose, to avoid re-growing the
 * `parseLastEventId` dual-copy problem noted above.
 *
 * Accepts only non-empty `[A-Za-z0-9_-]` strings of length ≤ 64 (the daemon
 * emits `randomUUID()` tokens; the bound guards against log/header abuse).
 * Invalid values are treated as "not provided" (the bus falls back to the
 * numeric heuristic) and logged for operators; a missing header is silent.
 *
 * @param logPrefix distinguishes the surface in logs, e.g. `'/acp '` vs `''`.
 */
export function parseEventEpochHeader(
  raw: unknown,
  logPrefix = '',
): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  if (raw.length > 64 || !/^[\w-]+$/.test(raw)) {
    writeStderrLine(
      `qwen serve: ${logPrefix}rejected X-Qwen-Event-Epoch ` +
        `${safeLogValue(raw)} (expected [A-Za-z0-9_-]{1,64})`,
    );
    return undefined;
  }
  return raw;
}
