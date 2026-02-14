/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const QWEN_DIR = '.qwen';
const SETTINGS_FILE = 'settings.json';

/**
 * Read the user-level Qwen settings from ~/.qwen/settings.json.
 * Returns the parsed JSON object, or an empty object on any failure.
 */
function readUserSettings(): Record<string, unknown> {
  try {
    const settingsPath = path.join(os.homedir(), QWEN_DIR, SETTINGS_FILE);
    const content = fs.readFileSync(settingsPath, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Check whether the dedicated terminal feature is enabled.
 * Reads `ide.dedicatedTerminal` from ~/.qwen/settings.json.
 * Defaults to `true` if the setting is not present.
 */
export function isDedicatedTerminalEnabled(): boolean {
  const settings = readUserSettings();
  const ide = settings['ide'] as Record<string, unknown> | undefined;
  if (ide && typeof ide['dedicatedTerminal'] === 'boolean') {
    return ide['dedicatedTerminal'];
  }
  return true;
}
