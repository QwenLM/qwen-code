/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #15909: the public Items reader answers 503 message_projection_pending while
 * projection catches up, and its contract calls that retryable — a projection
 * lagging behind committed events must be retried, not exported as history.
 * HostedProcessCrashIT.itemsWhenProjected() already polls again for exactly
 * this answer; a driver read that hard-fails instead unwinds on the first
 * lagging read, which is the one taken right after an injected crash (#15892).
 *
 * Every other answer stays final: a different 503 code, a 503 whose body does
 * not name the code, and any other status must still fail the read. The body
 * test is a substring check because the Java fixture uses one — the two
 * readers of the same endpoint have to classify it identically, or the
 * asymmetry this pins comes back with the next contract change.
 */
export function isProjectionPending(status: number, body: string): boolean {
  return status === 503 && body.includes('message_projection_pending');
}
