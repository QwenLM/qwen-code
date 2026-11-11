/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { CONFIG_DIR } from '../utils/paths.js';

const SETTINGS_SUFFIXES = [
  `${path.sep}${CONFIG_DIR}${path.sep}settings.json`,
  `${path.sep}${CONFIG_DIR}${path.sep}settings.local.json`,
];

/**
 * Returns true if the given absolute file path points to a settings file
 * (e.g. `<project>/${CONFIG_DIR}/settings.json` or `settings.local.json`).
 *
 * The check uses normalized, case-insensitive comparison to prevent
 * bypass via mixed-case paths like `.Qwen-Alpha/Settings.json`.
 */
export function isSettingsPath(filePath: string): boolean {
  const normalized = path.resolve(filePath).toLowerCase();
  return SETTINGS_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}
