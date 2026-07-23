/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { StoredMediaRecord } from './media-memory-store.js';

/**
 * P4 · Auto-linking heuristic (Q6: scaffold-built, deterministic).
 *
 * The `MediaMemory.linkOf` interface is A-class and fixed; the heuristic that
 * decides "which files are related" is B-class and swappable without touching
 * that interface. v1 uses only deterministic signals — same directory, and
 * explicit derived-from provenance — because they never produce a wrong link.
 * Embedding-similarity linking is a later opt-in plugin.
 */

export interface LinkTarget {
  hash: string;
  path: string;
  /** Hash of the file this one was derived from (media_extract byproduct). */
  derivedFrom?: string;
}

/**
 * Compute related-file hashes for `target` against known records, using only
 * deterministic heuristics.
 */
export function computeAutoLinks(
  target: LinkTarget,
  others: StoredMediaRecord[],
): string[] {
  const links = new Set<string>();
  if (target.derivedFrom) {
    links.add(target.derivedFrom);
  }
  const targetDir = path.dirname(path.resolve(target.path));
  for (const other of others) {
    if (other.hash === target.hash || !other.path) continue;
    if (path.dirname(path.resolve(other.path)) === targetDir) {
      links.add(other.hash);
    }
    // Reverse derived provenance: if another record was derived from this file.
    if (other.links.includes(target.hash)) {
      links.add(other.hash);
    }
  }
  return [...links];
}
