/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const internalWrites = new Map<string, number>();

/**
 * Canonical form of a path: realpath when the path exists; for missing
 * paths, the realpath of the nearest existing ancestor plus the unresolved
 * suffix. Matches are done in this namespace so symlink aliases (e.g.
 * /var vs /private/var on macOS) never cause misses.
 */
export function canonicalPath(filePath: string): string {
  const resolved = resolve(filePath);
  try {
    return realpathSync(resolved);
  } catch {
    // Path does not exist: canonicalize the nearest existing ancestor and
    // re-append the missing suffix.
    const suffix: string[] = [];
    let current = resolved;
    for (;;) {
      const parent = dirname(current);
      if (parent === current) return resolved;
      suffix.unshift(basename(current));
      current = parent;
      try {
        const real = realpathSync(current);
        return suffix.length > 0 ? join(real, ...suffix) : real;
      } catch {
        // keep walking up
      }
    }
  }
}

export function markInternalWrite(filePath: string, now = Date.now()): void {
  internalWrites.set(canonicalPath(filePath), now);
}

export function consumeInternalWrite(
  filePath: string,
  windowMs: number,
  now = Date.now(),
): boolean {
  if (internalWrites.size === 0) return false;
  const normalized = canonicalPath(filePath);
  const writeTime = internalWrites.get(normalized);
  if (writeTime === undefined) return false;

  internalWrites.delete(normalized);
  return now - writeTime < windowMs;
}

export function clearInternalWrites(): void {
  internalWrites.clear();
}
