/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('CORRUPT_FILE');

/**
 * Moves a corrupt (un-parseable) JSON state file aside to `${filePath}.corrupted`
 * so the next write does not clobber recoverable user data.
 *
 * The extension state stores (favorites/scopes, the marketplace source list)
 * fall back to an empty default when their backing file fails to parse, then
 * persist that empty default on the next mutation — silently wiping data that a
 * truncated/partial third-party write (disk-full, editor save error, cloud
 * partial sync) left recoverable. Renaming the bad file aside keeps the
 * original bytes for recovery and lets the next write start cleanly. Best
 * effort: any rename failure is logged and swallowed.
 */
export function quarantineCorruptFile(filePath: string): void {
  const quarantinePath = `${filePath}.corrupted`;
  try {
    fs.renameSync(filePath, quarantinePath);
    // `debugLogger.warn` is gated behind QWEN_DEBUG_LOG_FILE (unset for almost
    // all users), so without this the user's favorites/scopes/sources would
    // appear to vanish with no trail. Surface the quarantine on stderr too.
    process.stderr.write(
      `[warn] Corrupt extension state file ${filePath} moved aside to ${quarantinePath}\n`,
    );
    debugLogger.warn(
      `Corrupt file ${filePath} could not be parsed; moved aside to ${quarantinePath}.`,
    );
  } catch (error) {
    process.stderr.write(
      `[warn] Corrupt extension state file ${filePath} could not be moved aside: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    debugLogger.warn(
      `Corrupt file ${filePath} could not be parsed and could not be moved aside: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
