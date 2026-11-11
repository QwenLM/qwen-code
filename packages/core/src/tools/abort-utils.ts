/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Utilities for hierarchical AbortController management.
 *
 * Child controllers allow per-tool cancellation without aborting the
 * entire session. When the parent signal fires, all children are aborted;
 * aborting a child does NOT propagate upward.
 */

import { isAbortError } from '../utils/errors.js';

const NOOP = () => {};

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Checks signal.aborted first (covers non-DOMException aborts),
 * then falls back to isAbortError for DOMException/AbortError cases.
 */
export function isCancelledError(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted) return true;
  return isAbortError(error);
}

export function createChildAbortController(parentSignal: AbortSignal): {
  controller: AbortController;
  cleanup: () => void;
} {
  const child = new AbortController();

  if (parentSignal.aborted) {
    child.abort(parentSignal.reason);
    return { controller: child, cleanup: NOOP };
  }

  const onParentAbort = () => {
    child.abort(parentSignal.reason);
  };

  parentSignal.addEventListener('abort', onParentAbort, { once: true });

  const cleanup = () => {
    parentSignal.removeEventListener('abort', onParentAbort);
  };

  return { controller: child, cleanup };
}
