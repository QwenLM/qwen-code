/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const DEFAULT_BROWSER_URL = 'https://www.google.com/';

export function normalizeBrowserUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return undefined;
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

export function isSafeBrowserUrl(input: string): boolean {
  return normalizeBrowserUrl(input) === input;
}
