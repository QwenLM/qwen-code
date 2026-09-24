/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import type { Config } from '../config/config.js';

const OUTPUT_LANGUAGE_MARKER_PREFIX = 'qwen-code:llm-output-language:';

export async function readOutputLanguagePreference(
  config: Config,
): Promise<string | undefined> {
  const filePath = config.getOutputLanguageFilePath?.();
  if (!filePath) return undefined;

  try {
    const preference = (await readFile(filePath, 'utf8')).trim();
    return preference || undefined;
  } catch {
    return undefined;
  }
}

export function parseOutputLanguagePreference(
  preference: string,
): string | null {
  const marker = preference.match(
    new RegExp(
      String.raw`<!--\s*${OUTPUT_LANGUAGE_MARKER_PREFIX}\s*(.*?)\s*-->`,
      'i',
    ),
  );
  if (marker?.[1]?.trim()) return marker[1].trim();

  const heading = preference.match(
    /^#.*?CRITICAL:\s*(.*?)\s+Output Language Rule\b/im,
  );
  return heading?.[1]?.trim() || null;
}
