/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * doctor-registry.ts
 *
 * Windows registry utilities for the doctor diagnostic script.
 */

import { execFileSync } from 'child_process';
import { stringifyError } from './doctor-utils';

type RegistryValueType = 'REG_SZ' | 'REG_EXPAND_SZ';

/**
 * Query the default value of a Windows registry key.
 * @returns Object with value, valueType, and optional error.
 */
export function queryWindowsRegistryDefaultValue(registryKey: string): {
  value?: string;
  valueType?: RegistryValueType;
  error?: string;
} {
  try {
    const output = execFileSync('reg', ['query', registryKey, '/ve'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2500,
      windowsHide: true,
    });
    const lines = output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      const match = line.match(/\b(REG_SZ|REG_EXPAND_SZ)\b\s+(.*)$/i);
      if (match?.[2]) {
        const valueType = match[1].toUpperCase() as RegistryValueType;
        return { value: match[2].trim(), valueType };
      }
    }
    return { error: 'No REG_SZ/REG_EXPAND_SZ default value found' };
  } catch (e) {
    return { error: stringifyError(e) };
  }
}
