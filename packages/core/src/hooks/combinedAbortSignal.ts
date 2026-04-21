/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Create a combined AbortSignal that aborts when either:
 * - The provided external signal is aborted, OR
 * - The timeout is reached
 *
 * @param externalSignal - Optional external AbortSignal to combine
 * @param timeoutMs - Timeout in milliseconds
 * @returns Object containing the combined signal and a cleanup function
 */
export function createCombinedAbortSignal(
  externalSignal?: AbortSignal,
  options?: { timeoutMs?: number },
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();

  const timeoutMs = options?.timeoutMs;

  // Set up timeout
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
  }

  // Listen to external signal
  let abortHandler: (() => void) | undefined;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      abortHandler = () => {
        controller.abort();
      };
      externalSignal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  const cleanup = () => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    if (externalSignal && abortHandler) {
      externalSignal.removeEventListener('abort', abortHandler);
      abortHandler = undefined;
    }
  };

  return { signal: controller.signal, cleanup };
}
