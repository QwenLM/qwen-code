/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';

/**
 * Options for writeWithBackup function.
 */
export interface WriteWithBackupOptions {
  /** Suffix for backup file (default: '.orig') */
  backupSuffix?: string;
  /** File encoding (default: 'utf-8') */
  encoding?: BufferEncoding;
}

/**
 * Safely writes content to a file with backup protection.
 *
 * This function ensures data safety by:
 * 1. Writing content to a temporary file first
 * 2. Backing up the existing target file (if any)
 * 3. Renaming the temporary file to the target path
 *
 * If any step fails, an error is thrown and no partial changes are left on disk.
 * The backup file (if created) can be used for manual recovery.
 *
 * Note: This is not 100% atomic but provides good protection. In the worst case,
 * a .orig backup file remains that can be manually restored.
 *
 * @param targetPath - The path to write to
 * @param content - The content to write
 * @param options - Optional configuration
 * @throws Error if any step of the write process fails
 *
 * @example
 * ```typescript
 * await writeWithBackup('/path/to/settings.json', JSON.stringify(settings, null, 2));
 * // If /path/to/settings.json existed, it's now backed up to /path/to/settings.json.orig
 * ```
 */
export async function writeWithBackup(
  targetPath: string,
  content: string,
  options: WriteWithBackupOptions = {},
): Promise<void> {
  // Async version delegates to sync version since file operations are synchronous
  writeWithBackupSync(targetPath, content, options);
}

/**
 * Synchronous version of writeWithBackup.
 *
 * @param targetPath - The path to write to
 * @param content - The content to write
 * @param options - Optional configuration
 * @throws Error if any step of the write process fails
 */
export function writeWithBackupSync(
  targetPath: string,
  content: string,
  options: WriteWithBackupOptions = {},
): void {
  const { backupSuffix = '.orig', encoding = 'utf-8' } = options;
  const tempPath = `${targetPath}.tmp`;
  const backupPath = `${targetPath}${backupSuffix}`;

  // Clean up any existing temp file from previous failed attempts
  try {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  } catch (_e) {
    // Ignore cleanup errors
  }

  try {
    // Step 1: Write to temporary file
    fs.writeFileSync(tempPath, content, { encoding });

    // Step 2: If target exists, back it up
    if (fs.existsSync(targetPath)) {
      // Check if target is a directory - we can't write to a directory
      const targetStat = fs.statSync(targetPath);
      if (targetStat.isDirectory()) {
        // Clean up temp file before throwing
        try {
          fs.unlinkSync(tempPath);
        } catch (_e) {
          // Ignore cleanup error
        }
        throw new Error(
          `Cannot write to '${targetPath}' because it is a directory`,
        );
      }

      try {
        fs.renameSync(targetPath, backupPath);
      } catch (backupError) {
        // Clean up temp file before throwing
        try {
          fs.unlinkSync(tempPath);
        } catch (_e) {
          // Ignore cleanup error
        }
        throw new Error(
          `Failed to backup existing file: ${backupError instanceof Error ? backupError.message : String(backupError)}`,
        );
      }
    }

    // Step 3: Rename temp file to target
    try {
      fs.renameSync(tempPath, targetPath);
    } catch (renameError) {
      let restoreFailedMessage: string | undefined;
      let backupExisted = false;

      // Attempt to restore backup if rename failed
      if (fs.existsSync(backupPath)) {
        backupExisted = true;
        try {
          fs.renameSync(backupPath, targetPath);
        } catch (restoreError) {
          restoreFailedMessage =
            restoreError instanceof Error
              ? restoreError.message
              : String(restoreError);
        }
      }

      const writeFailureMessage =
        renameError instanceof Error
          ? renameError.message
          : String(renameError);

      if (restoreFailedMessage) {
        throw new Error(
          `Failed to write file: ${writeFailureMessage}. ` +
            `Automatic restore failed: ${restoreFailedMessage}. ` +
            `Manual recovery may be required using backup file '${backupPath}'.`,
        );
      }

      if (backupExisted) {
        throw new Error(
          `Failed to write file: ${writeFailureMessage}. ` +
            `Target was automatically restored from backup '${backupPath}'.`,
        );
      }

      throw new Error(
        `Failed to write file: ${writeFailureMessage}. No backup file was available for restoration.`,
      );
    }
  } catch (error) {
    // Ensure temp file is cleaned up on any error
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch (_e) {
      // Ignore cleanup error
    }
    throw error;
  }
}
