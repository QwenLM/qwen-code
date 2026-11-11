/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runLogger } from '../utils/runLogger.js';

const ORPHANED_AT_FILENAME = '.orphaned_at';

/**
 * Mark a plugin version directory as orphaned.
 * Called when a plugin is uninstalled or updated to a new version.
 */
export async function markPluginVersionOrphaned(
  versionPath: string,
): Promise<void> {
  try {
    await writeFile(
      join(versionPath, ORPHANED_AT_FILENAME),
      `${Date.now()}`,
      'utf-8',
    );
  } catch (error) {
    runLogger.warn(`Failed to write .orphaned_at: ${versionPath}: ${error}`);
  }
}
