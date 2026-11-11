/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Platform detection utilities.
 *
 * Provides a unified platform identifier that distinguishes WSL from regular Linux,
 * which is important for performance tuning (e.g., ripgrep timeouts).
 */

import { readFileSync } from 'node:fs';

export type Platform = 'macos' | 'windows' | 'wsl' | 'linux' | 'unknown';

let _platform: Platform | null = null;

/**
 * Detect the current platform, with WSL detection on Linux.
 *
 * Memoized: the result is cached after the first call.
 *
 * - `'macos'`   – process.platform === 'darwin'
 * - `'windows'` – process.platform === 'win32'
 * - `'wsl'`     – Linux running under Windows Subsystem for Linux
 * - `'linux'`   – native Linux
 * - `'unknown'` – anything else or if detection fails
 */
export function getPlatform(): Platform {
  if (_platform !== null) {
    return _platform;
  }

  try {
    if (process.platform === 'darwin') {
      _platform = 'macos';
      return _platform;
    }

    if (process.platform === 'win32') {
      _platform = 'windows';
      return _platform;
    }

    if (process.platform === 'linux') {
      // Check if running in WSL (Windows Subsystem for Linux)
      try {
        const procVersion = readFileSync('/proc/version', { encoding: 'utf8' });
        if (
          procVersion.toLowerCase().includes('microsoft') ||
          procVersion.toLowerCase().includes('wsl')
        ) {
          _platform = 'wsl';
          return _platform;
        }
      } catch {
        // Error reading /proc/version, assume regular Linux
      }

      _platform = 'linux';
      return _platform;
    }

    _platform = 'unknown';
    return _platform;
  } catch {
    _platform = 'unknown';
    return _platform;
  }
}
