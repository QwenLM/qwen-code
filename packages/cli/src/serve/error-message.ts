/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const maybe = (err as { message?: unknown }).message;
    if (typeof maybe === 'string' && maybe.length > 0) return maybe;
    try {
      return JSON.stringify(err);
    } catch {
      // Fall back to String for values that cannot be serialized.
    }
  }
  return String(err);
}
