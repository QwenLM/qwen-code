/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview loop.md reader — reads `loop.md` from the project's config
 * directory as a user-defined task list that gets injected into /loop fire
 * prompts.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { CONFIG_DIR } from '../../utils/paths.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOOP_MD_FILENAME = 'loop.md';

/** Maximum bytes to read from loop.md before truncation. */
export const MAX_LOOP_MD_BYTES = 8192;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoopMdContent {
  /** The file content (possibly truncated to MAX_LOOP_MD_BYTES). */
  content: string;
  /** True if the file exceeded MAX_LOOP_MD_BYTES and was truncated. */
  truncated: boolean;
  /** Original file size in bytes before any truncation. */
  originalBytes: number;
  /** SHA-256 hash of the content for change detection. */
  contentHash: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read `loop.md` from the config directory under the project root.
 * Returns null if the file doesn't exist or is a directory.
 */
export async function readLoopMd(dir?: string): Promise<LoopMdContent | null> {
  const filePath = join(dir ?? process.cwd(), CONFIG_DIR, LOOP_MD_FILENAME);
  try {
    // Check it's actually a file (not a directory)
    const st = await stat(filePath);
    if (!st.isFile()) return null;

    const buf = await readFile(filePath);
    const originalBytes = buf.byteLength;
    const truncated = originalBytes > MAX_LOOP_MD_BYTES;
    const content = truncated
      ? buf.subarray(0, MAX_LOOP_MD_BYTES).toString('utf-8')
      : buf.toString('utf-8');
    const contentHash = createHash('sha256').update(content).digest('hex');

    return { content, truncated, originalBytes, contentHash };
  } catch {
    return null;
  }
}

/**
 * Returns true if `loop.md` exists under the config directory (quick check
 * without reading content).
 */
export async function hasLoopMd(dir?: string): Promise<boolean> {
  const filePath = join(dir ?? process.cwd(), CONFIG_DIR, LOOP_MD_FILENAME);
  try {
    const st = await stat(filePath);
    return st.isFile();
  } catch {
    return false;
  }
}
