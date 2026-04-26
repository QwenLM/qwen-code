/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { delimiter as defaultPathDelimiter } from 'node:path';

let cachedRawDirectoryList: string | undefined;
let cachedDirectories: string[] = [];
let nextDirectoryIndex = 0;

export function getE2eSelectedDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env['QWEN_DESKTOP_E2E'] !== '1') {
    return null;
  }

  const rawDirectoryList = env['QWEN_DESKTOP_TEST_SELECT_DIRECTORY'];
  if (!rawDirectoryList) {
    return null;
  }

  if (rawDirectoryList !== cachedRawDirectoryList) {
    cachedRawDirectoryList = rawDirectoryList;
    cachedDirectories = parseE2eSelectDirectories(rawDirectoryList);
    nextDirectoryIndex = 0;
  }

  if (cachedDirectories.length === 0) {
    return null;
  }

  const selectedDirectory =
    cachedDirectories[
      Math.min(nextDirectoryIndex, cachedDirectories.length - 1)
    ];
  if (nextDirectoryIndex < cachedDirectories.length - 1) {
    nextDirectoryIndex += 1;
  }

  return selectedDirectory ?? null;
}

export function parseE2eSelectDirectories(
  rawDirectoryList: string,
  pathDelimiter = defaultPathDelimiter,
): string[] {
  const trimmedDirectoryList = rawDirectoryList.trim();
  if (trimmedDirectoryList.length === 0) {
    return [];
  }

  if (trimmedDirectoryList.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmedDirectoryList) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
      }
    } catch {
      // Fall through to delimiter parsing so malformed E2E input remains
      // inspectable in diagnostics instead of crashing the app at startup.
    }
  }

  return rawDirectoryList
    .split(pathDelimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function resetE2eSelectedDirectoryForTest(): void {
  cachedRawDirectoryList = undefined;
  cachedDirectories = [];
  nextDirectoryIndex = 0;
}
