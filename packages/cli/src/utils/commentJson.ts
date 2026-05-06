/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { parse, stringify } from 'comment-json';
import { writeStderrLine } from './stdioHelpers.js';

/**
 * Options for updateSettingsFilePreservingFormat.
 */
export interface UpdateSettingsOptions {
  /**
   * When true, keys present in the original file but NOT in the updates
   * object are removed (sync mode). When false (default), the updates are
   * merged into the existing file (merge mode), preserving keys not
   * mentioned in updates.
   *
   * Use sync mode for migrations that may remove deprecated keys.
   * Use merge mode for runtime setValue that only touches known keys.
   */
  sync?: boolean;
}

/**
 * Updates a JSON file while preserving comments and formatting.
 *
 * In merge mode (default), updates are deep-merged into the existing file,
 * preserving keys not mentioned in the updates object.
 *
 * In sync mode (sync=true), the file is synchronized to match the updates
 * object exactly — keys present in the original but not in updates are
 * removed, preventing zombie keys after migrations.
 *
 * Uses writeWithBackupSync internally for atomic temp-file + rename writes,
 * preventing file corruption if the process crashes mid-write.
 *
 * @returns true if the file was successfully written, false if the write
 * was refused (e.g. the result would not be valid JSON or file not parseable).
 */
export function updateSettingsFilePreservingFormat(
  filePath: string,
  updates: Record<string, unknown>,
  options: UpdateSettingsOptions = {},
): boolean {
  const { sync = false } = options;

  if (!fs.existsSync(filePath)) {
    const content = stringify(updates, null, 2);
    writeFileSyncAtomic(filePath, content);
    return true;
  }

  const originalContent = fs.readFileSync(filePath, 'utf-8');

  let parsed: Record<string, unknown>;
  try {
    parsed = parse(originalContent) as Record<string, unknown>;
  } catch (_error) {
    writeStderrLine('Error parsing settings file.');
    writeStderrLine(
      'Settings file may be corrupted. Please check the JSON syntax.',
    );
    return false;
  }

  let updatedStructure: Record<string, unknown>;
  if (sync) {
    // Sync mode: remove keys not present in updates, then apply updates.
    // This ensures deprecated keys from migrations don't persist as zombies.
    const keysToRemove = Object.keys(parsed).filter((key) => !(key in updates));
    for (const key of keysToRemove) {
      delete parsed[key];
    }
    updatedStructure = applyUpdates(parsed, updates);
  } else {
    // Merge mode: only apply updates, preserve everything else.
    updatedStructure = applyUpdates(parsed, updates);
  }

  const updatedContent = stringify(updatedStructure, null, 2);

  // Validate that the output is parseable before writing to disk.
  // This prevents corrupted settings files that would block startup.
  try {
    parse(updatedContent);
  } catch (validationError) {
    writeStderrLine(
      'Error: Refusing to write settings file — the result would not be valid JSON.',
    );
    writeStderrLine(
      validationError instanceof Error
        ? validationError.message
        : String(validationError),
    );
    return false;
  }

  writeFileSyncAtomic(filePath, updatedContent);
  return true;
}

/**
 * Atomically writes content to a file using a temp-file + rename strategy.
 * Writes to a .tmp file first, backs up the existing target to .orig,
 * then renames the .tmp to the target path.
 *
 * If the rename fails, attempts to restore from the .orig backup.
 */
function writeFileSyncAtomic(targetPath: string, content: string): void {
  const tempPath = `${targetPath}.tmp`;
  const backupPath = `${targetPath}.orig`;

  // Clean up any stale temp file
  try {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  } catch (_e) {
    // Ignore cleanup errors
  }

  try {
    // Write to temp file
    fs.writeFileSync(tempPath, content, 'utf-8');

    // Back up existing target
    if (fs.existsSync(targetPath)) {
      try {
        fs.renameSync(targetPath, backupPath);
      } catch (backupError) {
        try {
          fs.unlinkSync(tempPath);
        } catch (_e) {
          // Ignore
        }
        throw new Error(
          `Failed to backup existing file: ${backupError instanceof Error ? backupError.message : String(backupError)}`,
        );
      }
    }

    // Rename temp to target
    try {
      fs.renameSync(tempPath, targetPath);
    } catch (renameError) {
      // Attempt to restore backup
      if (fs.existsSync(backupPath)) {
        try {
          fs.renameSync(backupPath, targetPath);
        } catch (_restoreError) {
          // Best-effort restore failed; re-throw original error
        }
      }
      throw renameError;
    }
  } catch (error) {
    // Clean up temp file on any error
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch (_e) {
      // Ignore
    }
    throw error;
  }
}

export function applyUpdates(
  current: Record<string, unknown>,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const result = current;

  for (const key of Object.getOwnPropertyNames(updates)) {
    const value = updates[key];
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0 &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = applyUpdates(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}
