/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isSettingsPath } from '@qwen-code/core';
import { formatValidationError } from './settings-validation.js';
import { normalizeLegacySettingsShape } from './settingsCompatibility.js';
import type { SettingsDefinition } from '@qwen-code/resource';

/**
 * Creates a settings content validator callback suitable for
 * `Config.setSettingsContentValidator()`.
 *
 * The returned function:
 *  1. Checks whether the target file is a settings path.
 *  2. Parses the proposed content as JSON.
 *  3. Validates the parsed object against the settings Zod schema.
 *  4. Returns a human-readable error string on failure, or null if OK.
 */
export function createSettingsContentValidator(
  validation: SettingsDefinition['validation'],
): (filePath: string, content: string) => string | null {
  return (filePath: string, content: string): string | null => {
    if (!isSettingsPath(filePath)) {
      return null;
    }

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      return `Invalid JSON in settings file: ${e instanceof Error ? e.message : String(e)}`;
    }

    // Must be an object
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return 'Settings file must contain a JSON object.';
    }
    normalizeLegacySettingsShape(parsed as Record<string, unknown>);

    // Validate against schema
    const result = validation.safeParse(parsed);
    if (!result.success && result.error) {
      return formatValidationError(result.error, filePath);
    }

    return null;
  };
}
