/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dir } from 'node:fs';
import { runLogger } from './runLogger.js';

/**
 * Closes an `opendir` handle without masking real errors.
 *
 * Async iteration closes the handle itself, both on completion and on `break`,
 * so an explicit close is only a safety net for the throw path and
 * `ERR_DIR_CLOSED` is the expected outcome rather than a problem. Any other
 * failure is genuine I/O trouble and gets a diagnostic line instead of being
 * swallowed.
 *
 * Always route redundant closes through this helper instead of writing
 * `handle.close().catch(() => {})`: the packaged CLI runs on the bun runtime,
 * where `Dir.close()` on an already-closed handle does not return a thenable.
 * Chaining `.catch()` on that return value throws a `TypeError` that escapes
 * the `finally` block and turns a successful directory walk into a failure.
 * `await` tolerates non-thenable values, so the result is never assumed to be a
 * promise here.
 */
export async function closeDirHandleQuietly(handle: Dir): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ERR_DIR_CLOSED') {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    runLogger.debug(
      `Failed to close directory handle for ${handle.path}: ${message}`,
    );
  }
}
