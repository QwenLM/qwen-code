/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';

export async function readOutputLanguagePreference(
  filePath: string | undefined,
): Promise<string | undefined> {
  if (!filePath) return undefined;

  try {
    return (await readFile(filePath, 'utf8')).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function formatOutputLanguageInstruction(
  preference: string | undefined,
): string | undefined {
  if (!preference) return undefined;

  return [
    'Follow the user-visible output language preference below for this side query.',
    'This preference overrides any earlier language-selection rule in this system instruction.',
    preference,
  ].join('\n\n');
}
