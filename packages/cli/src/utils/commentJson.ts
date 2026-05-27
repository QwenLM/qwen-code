/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { parse, stringify } from 'comment-json';
import { writeStderrLine } from './stdioHelpers.js';
import { writeWithBackupSync } from './writeWithBackup.js';

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
  sync = false,
): boolean {
  if (!fs.existsSync(filePath)) {
    const content = stringify(updates, null, 2);
    writeWithBackupSync(filePath, content);
    return true;
  }

  const originalContent = fs.readFileSync(filePath, 'utf-8');

  let parsed: Record<string, unknown>;
  try {
    parsed = parse(originalContent) as Record<string, unknown>;
  } catch (_error) {
    writeStderrLine('Error parsing settings file.');
    writeStderrLine(
      `Settings file may be corrupted: ${_error instanceof Error ? _error.message : String(_error)}`,
    );
    return false;
  }

  // In sync mode, applyUpdates recursively removes keys not present in the
  // migrated object, preventing zombie keys at every nesting level.
  // In merge mode, only the specified updates are applied.
  const updatedStructure = applyUpdates(parsed, updates, sync);

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

  writeWithBackupSync(filePath, updatedContent);
  return true;
}

export function applyUpdates(
  current: Record<string, unknown>,
  updates: Record<string, unknown>,
  sync = false,
): Record<string, unknown> {
  const result = current;

  if (sync) {
    // Sync mode: remove keys from current that are not present in updates,
    // then recursively apply updates. This prevents nested zombie keys
    // from persisting after migrations that restructure nested objects.
    const keysToRemove = Object.keys(result).filter((key) => !(key in updates));
    for (const key of keysToRemove) {
      delete result[key];
    }
  }

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
        sync,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}
