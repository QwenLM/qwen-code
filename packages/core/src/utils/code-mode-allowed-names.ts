/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<readonly string[]>();

// Nested-binding reachability is per-agent: the session-wide binding plan
// can hold bindings the calling agent's exec surface does not. An `undefined`
// store leaves the ambient set untouched so tools scheduled from a parent
// exec keep its allowlist.
export function runWithCodeModeAllowedNames<T>(
  allowedNames: readonly string[] | undefined,
  callback: () => T,
): T {
  return allowedNames === undefined
    ? callback()
    : storage.run(allowedNames, callback);
}

export function getCurrentCodeModeAllowedNames():
  | readonly string[]
  | undefined {
  return storage.getStore();
}
