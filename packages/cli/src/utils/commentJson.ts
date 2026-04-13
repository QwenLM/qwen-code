/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { parse, stringify } from 'comment-json';
import { writeStderrLine } from './stdioHelpers.js';

/**
 * Updates a JSON file while preserving comments and formatting.
 * Returns true if the file was successfully written, false if the write
 * was refused (e.g. the result would not be valid JSON).
 */
export function updateSettingsFilePreservingFormat(
  filePath: string,
  updates: Record<string, unknown>,
): boolean {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(updates, null, 2), 'utf-8');
    return true;
  }

  const originalContent = fs.readFileSync(filePath, 'utf-8');

  let parsed: Record<string, unknown>;
  try {
    parsed = parse(originalContent) as Record<string, unknown>;
  } catch (error) {
    writeStderrLine('Error parsing settings file.');
    writeStderrLine(error instanceof Error ? error.message : String(error));
    writeStderrLine(
      'Settings file may be corrupted. Please check the JSON syntax.',
    );
    return false;
  }

  const updatedStructure = applyUpdates(parsed, updates);
  const updatedContent = stringify(updatedStructure, null, 2);

  // Validate that the output is parseable before writing to disk.
  // This prevents corrupted settings files that would block startup.
  // Use comment-json's parse since the output may contain preserved comments.
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

  fs.writeFileSync(filePath, updatedContent, 'utf-8');
  return true;
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
