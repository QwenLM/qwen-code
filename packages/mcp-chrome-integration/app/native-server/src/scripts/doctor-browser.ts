/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * doctor-browser.ts
 *
 * Browser resolution utilities for the doctor diagnostic script.
 */

import {
  BrowserType,
  detectInstalledBrowsers,
  parseBrowserType,
} from './browser-config';

/**
 * Resolve target browsers from command-line argument.
 * @returns Array of browsers to check, or undefined for auto-detection.
 */
export function resolveTargetBrowsers(
  browserArg: string | undefined,
): BrowserType[] | undefined {
  if (!browserArg) return undefined;
  const normalized = browserArg.toLowerCase();
  if (normalized === 'all') return [BrowserType.CHROME, BrowserType.CHROMIUM];
  if (normalized === 'detect' || normalized === 'auto') return undefined;
  const parsed = parseBrowserType(normalized);
  if (!parsed) {
    throw new Error(
      `Invalid browser: ${browserArg}. Use 'chrome', 'chromium', or 'all'`,
    );
  }
  return [parsed];
}

/**
 * Resolve the final list of browsers to check.
 * Uses requested browsers, or auto-detected installed browsers, or defaults.
 */
export function resolveBrowsersToCheck(
  requested: BrowserType[] | undefined,
): BrowserType[] {
  if (requested && requested.length > 0) return requested;
  const detected = detectInstalledBrowsers();
  if (detected.length > 0) return detected;
  return [BrowserType.CHROME, BrowserType.CHROMIUM];
}
