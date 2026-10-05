/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import path from 'node:path';

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
 * Staging and backup files belong to a private directory beside the target.
 * Publication replaces the target with one rename, keeping existing settings
 * readable throughout the save. Failed publication retains a recovery copy
 * unless it matches the current target; it never restores the copy over another
 * writer's newer data.
 * Successful saves clean up their private directory on a best-effort basis.
 *
 * @param targetPath - The path to write to
 * @param content - The content to write
 * @param options - Optional configuration
 * @throws Error if any step of the write process fails
 *
 * @example
 * ```typescript
 * await writeWithBackup('/path/to/settings.json', JSON.stringify(settings, null, 2));
 * // On success only /path/to/settings.json remains if cleanup succeeds.
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
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
    throw new Error(
      `Cannot write to '${targetPath}' because it is a directory`,
    );
  }

  const workingDirectory = fs.mkdtempSync(`${targetPath}.write-`);
  const basename = path.basename(targetPath);
  const tempPath = path.join(workingDirectory, `${basename}.tmp`);
  const backupPath = path.join(workingDirectory, `${basename}${backupSuffix}`);
  let backupCreated = false;

  try {
    fs.writeFileSync(tempPath, content, { encoding, flag: 'wx', flush: true });

    if (fs.existsSync(targetPath)) {
      try {
        fs.copyFileSync(targetPath, backupPath, fs.constants.COPYFILE_EXCL);
        backupCreated = true;
      } catch (backupError) {
        throw new Error(
          `Failed to backup existing file: ${backupError instanceof Error ? backupError.message : String(backupError)}`,
        );
      }
    }

    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    // Identical copies recover nothing and would accumulate on persistent failures.
    const recoveryRetained =
      backupCreated && !sameContents(backupPath, targetPath);
    try {
      if (recoveryRetained) {
        fs.unlinkSync(tempPath);
      } else {
        fs.rmSync(workingDirectory, { recursive: true, force: true });
      }
    } catch {
      // Cleanup must not obscure the write failure or remove a recovery copy.
    }
    if (recoveryRetained) {
      throw new Error(
        `Failed to write file: ${error instanceof Error ? error.message : String(error)}. ` +
          `Recovery copy retained at '${backupPath}'; inspect the current target before restoring it.`,
      );
    }
    throw error;
  }

  try {
    fs.rmSync(workingDirectory, { recursive: true, force: true });
  } catch {
    // Publication already succeeded; leftover artifacts do not invalidate it.
  }
}

function sameContents(first: string, second: string): boolean {
  try {
    return fs.readFileSync(first).equals(fs.readFileSync(second));
  } catch {
    return false;
  }
}
