/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { combineAbortSignals } from '../utils/abortController.js';

/**
 * @deprecated Use {@link combineAbortSignals} from `utils/abortController.js`.
 * Thin wrapper preserved so existing callers (httpHookRunner) keep working
 * during the abort-controller helper rollout.
 */
export function createCombinedAbortSignal(
  externalSignal?: AbortSignal,
  options?: { timeoutMs?: number },
): { signal: AbortSignal; cleanup: () => void } {
  return combineAbortSignals([externalSignal], {
    timeoutMs: options?.timeoutMs,
  });
}
