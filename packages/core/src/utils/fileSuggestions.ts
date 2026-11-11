/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File suggestion utilities for improved error messages.
 * When a file is not found, these helpers suggest similar files
 * or corrected paths under the current working directory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { runLogger } from './runLogger.js';

/**
 * Find files with the same base name but different extensions in the same directory.
 *
 * @param filePath - The path to the file that doesn't exist
 * @returns The found filename with a different extension, or undefined if none found
 */
export function findSimilarFile(filePath: string): string | undefined {
  try {
    const dir = path.dirname(filePath);
    const fileBaseName = path.basename(filePath, path.extname(filePath));

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    const match = entries.find(
      (entry) =>
        path.basename(entry.name, path.extname(entry.name)) === fileBaseName &&
        path.join(dir, entry.name) !== filePath,
    );

    return match?.name;
  } catch (error: unknown) {
    // Missing dir (ENOENT) is expected; for other errors log and return undefined
    const isENOENT =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code: string }).code === 'ENOENT';
    if (!isENOENT) {
      runLogger.error('findSimilarFile error:', String(error));
    }
    return undefined;
  }
}

/**
 * Suggests a corrected path under the current working directory when a file
 * is not found. Detects the "dropped repo folder" pattern where the model
 * constructs an absolute path missing the repo directory component.
 *
 * @example
 *   cwd = /Users/dev/src/myRepo
 *   requestedPath = /Users/dev/src/foobar       (doesn't exist)
 *   returns        /Users/dev/src/myRepo/foobar  (if it exists)
 */
export async function suggestPathUnderCwd(
  requestedPath: string,
  cwd: string,
): Promise<string | undefined> {
  const cwdParent = path.dirname(cwd);

  // Resolve symlinks in the requested path's parent directory
  let resolvedPath = requestedPath;
  try {
    const resolvedDir = await fs.promises.realpath(path.dirname(requestedPath));
    resolvedPath = path.join(resolvedDir, path.basename(requestedPath));
  } catch {
    // Parent directory doesn't exist, use the original path
  }

  const cwdParentPrefix =
    cwdParent === path.sep ? path.sep : cwdParent + path.sep;
  if (
    !resolvedPath.startsWith(cwdParentPrefix) ||
    resolvedPath.startsWith(cwd + path.sep) ||
    resolvedPath === cwd
  ) {
    return undefined;
  }

  const relFromParent = path.relative(cwdParent, resolvedPath);
  const correctedPath = path.join(cwd, relFromParent);
  try {
    await fs.promises.stat(correctedPath);
    return correctedPath;
  } catch {
    return undefined;
  }
}

/**
 * For macOS screenshot paths with AM/PM, the space before AM/PM may be a
 * regular space or a thin space (U+202F) depending on the macOS version.
 * Returns the alternate path to try, or undefined if not applicable.
 */
export function getAlternateScreenshotPath(
  filePath: string,
): string | undefined {
  const THIN_SPACE = String.fromCharCode(8239);
  const filename = path.basename(filePath);
  const amPmPattern = /^(.+)([ \u202F])(AM|PM)(\.png)$/;
  const match = filename.match(amPmPattern);
  if (!match) return undefined;

  const currentSpace = match[2];
  const alternateSpace = currentSpace === ' ' ? THIN_SPACE : ' ';
  return filePath.replace(
    `${currentSpace}${match[3]}${match[4]}`,
    `${alternateSpace}${match[3]}${match[4]}`,
  );
}

/**
 * Marker included in file-not-found error messages with a cwd note.
 * UI renderers can check for this to show a short "File not found" message.
 */
export const FILE_NOT_FOUND_CWD_NOTE =
  'Note: your current working directory is';
