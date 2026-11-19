/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Lets `LoggingContentGenerator` time a request from the moment a provider
 * hands the built request to its SDK or fetch, so client-side request
 * building is not counted as time to first token.
 */
const requestDispatchContext = new AsyncLocalStorage<() => void>();

export function observeRequestDispatch<T>(
  onDispatch: () => void,
  fn: () => T,
): T {
  return requestDispatchContext.run(onDispatch, fn);
}

/** Called by providers immediately before sending a built request. */
export function markRequestDispatched(): void {
  requestDispatchContext.getStore()?.();
}
