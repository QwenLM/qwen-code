/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-attempt retry context propagated through AsyncLocalStorage from
 * `retryWithBackoff` down to `LoggingContentGenerator`. Lets each per-attempt
 * `qwen-code.llm_request` span carry meaningful `attempt` / `request_setup_ms`
 * / `retry_total_delay_ms` attributes without changing the LLM API surface.
 *
 * See docs/design/telemetry-llm-request-timing-design.md (Phase 4b, D4).
 */
export interface RetryAttemptContext {
  /**
   * 1-based monotonic iteration counter for the current `retryWithBackoff`
   * execution. Always reflects "this is the Nth time fn was called",
   * regardless of normal vs persistent retry mode. Unaffected by the
   * `attempt = maxAttempts - 1` clamping that keeps the persistent-mode loop
   * alive.
   */
  readonly attempt: number;
  /**
   * Sum of all backoff delays BEFORE this attempt started (ms). 0 for attempt 1.
   * Accumulates across the retry loop.
   */
  readonly retryTotalDelayMs: number;
  /**
   * Time from `retryWithBackoff` entry to THIS attempt's start (ms). 0 for
   * attempt 1 of a no-retry success. For attempt N>1, equals cumulative time
   * spent in attempts 1..N-1 plus their backoff sleeps. Computed in `retry.ts`
   * immediately before `await fn()` to avoid measurement drift across layers.
   */
  readonly requestSetupMs: number;
}

export const retryContext = new AsyncLocalStorage<RetryAttemptContext>();
