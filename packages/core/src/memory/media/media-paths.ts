/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { Storage } from '../../config/storage.js';

/**
 * P2 · Media memory paths (Q7: independent index, per-user cross-project).
 *
 * Media understandings live under the runtime base dir (typically
 * `~/.qwen/media-memory/`), shared across projects and keyed by content hash so
 * the same file is one object in every session. This is deliberately separate
 * from the text auto-memory `MEMORY.md`.
 */

export const MEDIA_MEMORY_DIRNAME = 'media-memory';
export const MEDIA_INDEX_FILENAME = 'MEDIA_INDEX.md';

/** Root dir for all media understandings. */
export function getMediaMemoryRoot(): string {
  return path.join(Storage.getRuntimeBaseDir(), MEDIA_MEMORY_DIRNAME);
}

/** Per-file understanding record path, keyed by content hash. */
export function getMediaRecordPath(hash: string): string {
  return path.join(getMediaMemoryRoot(), `${sanitizeHash(hash)}.md`);
}

/** The independent media index path. */
export function getMediaIndexPath(): string {
  return path.join(getMediaMemoryRoot(), MEDIA_INDEX_FILENAME);
}

/** Hashes are hex; reject anything else so they can't escape the root. */
function sanitizeHash(hash: string): string {
  const clean = hash.toLowerCase().replace(/[^a-f0-9]/g, '');
  if (clean.length < 8) {
    throw new Error(`Invalid media hash: ${hash}`);
  }
  return clean;
}
