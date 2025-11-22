/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Creates a debounced version of the given function that delays invoking it
 * until after `wait` milliseconds have elapsed since the last time it was invoked.
 *
 * @param func The function to debounce
 * @param wait The number of milliseconds to delay
 * @param immediate If true, triggers the function on the leading edge instead of the trailing edge
 * @returns The debounced function
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number,
  immediate: boolean = false,
): (...args: Parameters<T>) => ReturnType<T> | undefined {
  let timeoutId: NodeJS.Timeout | null = null;
  let result: ReturnType<T> | undefined = undefined;

  return function executedFunction(
    this: unknown,
    ...args: Parameters<T>
  ): ReturnType<T> | undefined {
    const callNow = immediate && !timeoutId;

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (callNow) {
      result = func.apply(this, args);
    }

    timeoutId = setTimeout(() => {
      timeoutId = null;
      if (!immediate) {
        func.apply(this, args);
      }
    }, wait);

    return callNow ? result : undefined;
  };
}

/**
 * Creates a debounced function with a leading execution followed by trailing executions.
 * This can be useful for operations that need to happen immediately and then continue
 * to react to changes with a delay.
 *
 * @param func The function to debounce
 * @param wait The number of milliseconds to delay after the last invocation
 * @returns The debounced function
 */
export function debounceLeadingTrailing<
  T extends (...args: unknown[]) => unknown,
>(func: T, wait: number): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout | null = null;
  let lastCallTime: number | null = null;
  let isLeading = false;

  return function executedFunction(
    this: unknown,
    ...args: Parameters<T>
  ): void {
    const currentTime = Date.now();

    // If this is the first call or if enough time has passed since the last execution
    if (lastCallTime === null || currentTime - lastCallTime >= wait) {
      // Execute immediately
      func.apply(this, args);
      lastCallTime = currentTime;
      isLeading = true;

      // Set timeout for potential trailing call
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      return;
    }

    isLeading = false;

    // Clear previous timeout
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    // Set timeout for trailing call
    timeoutId = setTimeout(
      () => {
        if (!isLeading) {
          func.apply(this, args);
        }
        lastCallTime = Date.now();
        timeoutId = null;
      },
      wait - (currentTime - lastCallTime),
    );
  };
}
