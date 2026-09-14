/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const MAX_NOTIFICATION_SOURCE_LENGTH = 4096;

export function notificationTextLines(text: string): string[] {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const raw of text
    .slice(0, MAX_NOTIFICATION_SOURCE_LENGTH)
    .replace(/[\uD800-\uDBFF]$/, '')
    .split('\n')) {
    const delimiter = raw.match(/^\s*(`{3,}|~{3,})([^`~]*)$/);
    if (delimiter && !fence) {
      fence = delimiter[1];
      continue;
    }
    if (
      delimiter &&
      fence &&
      delimiter[1].startsWith(fence) &&
      !delimiter[2].trim()
    ) {
      fence = undefined;
      continue;
    }
    if (!fence && /^\s*---+\s*$/.test(raw)) continue;
    const content = fence
      ? raw
      : raw
          .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/, '')
          .split(/(`+[^`]*`+|!?\[[^\u005b\u005d]*\]\([^()]*\))/g)
          .map((part) =>
            part.startsWith('`') && part.endsWith('`')
              ? part.replace(/^`+|`+$/g, '')
              : part
                  .replace(
                    /!?\[([^\u005b\u005d]*)\]\([^()]*\)/g,
                    (_match, label: string) =>
                      label.replace(/(`+)(.*?)\1/g, '$2'),
                  )
                  .replace(/(\*\*|~~)(.*?)\1/g, '$2'),
          )
          .join('');
    const plain = content
      .replace(/[\p{Cc}\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (plain) lines.push(plain);
  }
  return lines;
}

export function notificationExcerpt(text: string, limit: number): string {
  const plain = notificationTextLines(text).join(' ');
  const chars = Array.from(plain);
  return chars.length > limit
    ? chars.slice(0, limit - 1).join('') + '…'
    : plain;
}
