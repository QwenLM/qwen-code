/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
export function lazySchema<T>(factory: () => T): () => T {
  let cached: T | undefined;
  return () => (cached ??= factory());
}
