/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tolerance for transient model-serving failures on ACP `session/prompt`.
 *
 * The shared model gateway degrades in seconds-long windows, and the agent
 * surfaces that to `session/prompt` as a JSON-RPC `-32603` whose error data
 * names model serving (seen twice on the macOS E2E leg in #11271). The
 * client's waiter rejects on the first hit, and vitest's `retry: 2` then
 * re-issues the whole minute-long case into the same window. A bounded
 * in-test retry rides the window out — each attempt still carries its own
 * `REQUEST_TIMEOUT_MS` budget — while a persistent outage keeps failing the
 * case. The predicate lives next to the wrapper so the unit test pins both.
 */

import { setTimeout as delay } from 'node:timers/promises';

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;

/**
 * True when the rejection is the agent's JSON-RPC wrapping of an upstream
 * model-serving error — transient by construction. A `-32603` raised by the
 * agent itself (loop protection, handler bugs) does not match, so genuine
 * agent regressions still fail fast on the first attempt.
 */
export function isTransientModelServingError(error: unknown): boolean {
  const response = (error as { response?: unknown } | null)?.response;
  if (
    typeof response !== 'object' ||
    response === null ||
    (response as { code?: unknown }).code !== -32603
  ) {
    return false;
  }
  return JSON.stringify(response).includes('model serving');
}

export async function withTransientModelServingRetry<T>(
  sendPrompt: () => Promise<T>,
  retryDelayMs = RETRY_DELAY_MS,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await sendPrompt();
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isTransientModelServingError(error)) {
        throw error;
      }
      await delay(retryDelayMs);
    }
  }
}
