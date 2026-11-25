/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const DEFAULT_CHAT_MODEL_MAX_RETRIES = 4;
export const DEFAULT_CHAT_MODEL_MAX_ATTEMPTS =
  DEFAULT_CHAT_MODEL_MAX_RETRIES + 1;

/**
 * Normalize a configured max-attempts value to a positive safe integer,
 * falling back to the default for non-finite input. One attempt means "do not
 * retry"; a non-positive numeric setting must not silently expand into the
 * default and amplify traffic. There is no product-level retry ceiling; the
 * safe-integer bound only prevents a counter that can no longer advance.
 */
export function normalizeMaxAttempts(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CHAT_MODEL_MAX_ATTEMPTS;
  }
  return Math.min(Math.max(1, Math.trunc(value)), Number.MAX_SAFE_INTEGER);
}
