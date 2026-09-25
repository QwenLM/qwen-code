/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { open } from 'node:fs/promises';
import type { Config } from '../config/config.js';

export const OUTPUT_LANGUAGE_AUTO = 'auto';
export const OUTPUT_LANGUAGE_MARKER_PREFIX = 'qwen-code:llm-output-language:';
export const OUTPUT_LANGUAGE_PREFERENCE_MAX_BYTES = 16 * 1024;
export const OUTPUT_LANGUAGE_LABEL_MAX_LENGTH = 128;

export function isAutoLanguage(value: string | undefined | null): boolean {
  return !value || value.toLowerCase() === OUTPUT_LANGUAGE_AUTO;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export function isValidOutputLanguageLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value === value.trim() &&
    value.length <= OUTPUT_LANGUAGE_LABEL_MAX_LENGTH &&
    !hasControlCharacters(value) &&
    /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} ()'’_\-\uFF08\uFF09]*$/u.test(value)
  );
}

export async function readOutputLanguagePreference(
  config: Config,
): Promise<string | undefined> {
  const filePath = config.getOutputLanguageFilePath?.();
  if (!filePath) return undefined;

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(OUTPUT_LANGUAGE_PREFERENCE_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > OUTPUT_LANGUAGE_PREFERENCE_MAX_BYTES) return undefined;

    const preference = buffer.subarray(0, offset).toString('utf8').trim();
    return preference || undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function parseOutputLanguagePreference(
  preference: string,
): string | null {
  if (
    preference.length > OUTPUT_LANGUAGE_PREFERENCE_MAX_BYTES ||
    Buffer.byteLength(preference, 'utf8') > OUTPUT_LANGUAGE_PREFERENCE_MAX_BYTES
  ) {
    return null;
  }

  const marker = /<!--\s*qwen-code:llm-output-language:\s*/iu.exec(preference);
  if (marker) {
    const valueStart = marker.index + marker[0].length;
    const commentEnd = preference.indexOf('-->', valueStart);
    if (commentEnd !== -1) {
      const language = preference.slice(valueStart, commentEnd).trim();
      if (isValidOutputLanguageLabel(language)) return language;
    }
  }

  for (const line of preference.split(/\r?\n/u)) {
    const titlePrefix = '# Output language preference:';
    if (line.toLowerCase().startsWith(titlePrefix.toLowerCase())) {
      const language = line.slice(titlePrefix.length).trim();
      if (isValidOutputLanguageLabel(language)) return language;
    }

    const autoRule = "Respond in the same language as the user's input.";
    if (line.trim() === autoRule) return OUTPUT_LANGUAGE_AUTO;

    const fixedRulePrefix = 'You MUST always respond in **';
    if (line.startsWith(fixedRulePrefix)) {
      const closingMarker = line.indexOf('**', fixedRulePrefix.length);
      if (closingMarker !== -1) {
        const language = line.slice(fixedRulePrefix.length, closingMarker);
        if (isValidOutputLanguageLabel(language)) return language;
      }
    }

    if (!line.startsWith('#')) continue;
    const criticalMatch = /critical:/iu.exec(line);
    if (!criticalMatch) continue;
    const languageStart = criticalMatch.index + criticalMatch[0].length;
    const ruleOffset = line
      .slice(languageStart)
      .search(/output language rule\b/iu);
    if (ruleOffset === -1) continue;
    const ruleIndex = languageStart + ruleOffset;
    const language = line.slice(languageStart, ruleIndex).trim();
    if (isValidOutputLanguageLabel(language)) return language;
  }

  return null;
}
