/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Locate the plugin root inside an extracted plugin archive.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { looksLikePluginRoot } from './pluginLoader.js';

/**
 * Returns the directory whose contents should become the plugin root.
 *
 * Strategy — uses "looks like a plugin" (manifest OR convention content) as
 * the signal, not just "exactly one entry". This handles three failure
 * modes the naive single-entry check has:
 *
 *   1. A minimal plugin whose only top-level item is `commands/` (or any
 *      single convention dir) is NOT a wrapper — it's the plugin itself.
 *   2. A GitHub-style wrapper (`repo-main/<plugin-meta-dir>/...`) with sibling
 *      junk at the top still gets stripped because the inner dir wins on
 *      the convention check, not on entry count.
 *   3. A wrapper whose inner dir has no plugin content (empty / wrong
 *      shape) is NOT stripped — we leave it to fail in the loader where
 *      the error surface is clearer.
 *
 * `extractZipToDirectory` already filters macOS junk (`__MACOSX/`, `._*`),
 * so we don't have to ignore them here.
 */
export async function detectSingleWrapperDir(dir: string): Promise<string> {
  // Step 1: if the top level already looks like a plugin, never strip.
  if (await looksLikePluginRoot(dir)) return dir;

  // Step 2: look for exactly one directory child (no file siblings) that
  // itself looks like a plugin — the classic GitHub `repo-branch/` wrapper.
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return dir;
  }

  let onlyDir: string | null = null;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (onlyDir !== null) return dir; // multiple dirs → not a wrapper shape
      onlyDir = entry.name;
    } else {
      return dir; // any sibling file → not a wrapper shape
    }
  }
  if (onlyDir === null) return dir;

  const child = join(dir, onlyDir);
  if (await looksLikePluginRoot(child)) return child;
  return dir;
}
