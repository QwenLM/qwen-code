/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isProjectionPending } from './hosted-projection-pending.js';

// The envelope ManagedAgentStore.findMessagePage throws while projection is
// behind committed events; the message text is the store's own.
const pending =
  '{"error":{"code":"message_projection_pending","message":"Retry after pending messages have been projected."}}';

describe('isProjectionPending', () => {
  it('retries the documented pending answer', () => {
    expect(isProjectionPending(503, pending)).toBe(true);
  });

  it('keeps a different 503 code final', () => {
    // Without this case, dropping the body test survives: every 503 would
    // read as retryable, including the Runtime's reconciliation refusal.
    expect(
      isProjectionPending(
        503,
        '{"error":{"code":"runtime_reconciliation_required"}}',
      ),
    ).toBe(false);
  });

  it('keeps a 503 with no body final', () => {
    expect(isProjectionPending(503, '')).toBe(false);
  });

  it('keeps a proxy-generated 503 final instead of throwing', () => {
    // The driver reads through a relay, so a 503 need not be the store's
    // JSON at all. It is not the documented answer and must fail the read.
    expect(
      isProjectionPending(503, '<html>503 Service Unavailable</html>'),
    ).toBe(false);
  });

  it('does not retry a successful read that quotes the code', () => {
    // Without this case, dropping the status test survives.
    expect(isProjectionPending(200, pending)).toBe(false);
  });

  it('keeps the same answer on any other status final', () => {
    // 500 and 409 keep a `status >= 500` or `status !== 200` mutant from
    // passing; the pending answer is only retryable as a 503.
    expect(isProjectionPending(500, pending)).toBe(false);
    expect(isProjectionPending(409, pending)).toBe(false);
  });

  it('mirrors the Java fixture substring test', () => {
    // Deliberate: HostedProcessCrashIT.itemsWhenProjected() tests
    // body.contains("message_projection_pending"), so a body that merely
    // mentions the code classifies the same on both sides. Tightening only
    // the TypeScript reader would re-open the asymmetry this helper closes.
    expect(
      isProjectionPending(
        503,
        '{"error":{"code":"other","message":"message_projection_pending"}}',
      ),
    ).toBe(true);
  });
});
