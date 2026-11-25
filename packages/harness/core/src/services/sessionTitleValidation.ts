/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const DEFAULT_SESSION_TITLE_MAX_CHARS = 80;

const wordSegmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('und', { granularity: 'word' })
    : null;

function sanitizeTitle(raw: string, maxChars: number): string {
  const collapsed = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  const hard = collapsed.slice(0, maxChars);
  const lastSpace = hard.lastIndexOf(' ');
  if (lastSpace > maxChars * 0.75) {
    return hard.slice(0, lastSpace).trim();
  }
  return hard.trim();
}

function limitTitleWords(
  title: string,
  maxWords: number | undefined,
): string {
  if (!maxWords) {
    return title;
  }

  if (wordSegmenter) {
    const wordSegments: Array<{ index: number; segment: string }> = [];
    for (const part of wordSegmenter.segment(title)) {
      if (!part.isWordLike) {
        continue;
      }
      wordSegments.push({
        index: part.index,
        segment: part.segment,
      });
      if (wordSegments.length > maxWords) {
        const cutoff = wordSegments[maxWords - 1];
        return title.slice(0, cutoff.index + cutoff.segment.length).trim();
      }
    }
    if (wordSegments.length > 0) {
      return title;
    }
  }

  let seen = 0;
  let endIndex = title.length;
  const wordPattern = /[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g;
  for (const match of title.matchAll(wordPattern)) {
    seen++;
    if (seen === maxWords) {
      endIndex = (match.index ?? 0) + match[0].length;
      break;
    }
  }
  return title.slice(0, endIndex).trim();
}

export interface NormalizeGeneratedSessionTitleOptions {
  maxChars?: number;
  maxWords?: number;
}

export function normalizeGeneratedSessionTitle(
  raw: unknown,
  options: NormalizeGeneratedSessionTitleOptions = {},
): string | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const sanitized = limitTitleWords(
    sanitizeTitle(
      trimmed,
      options.maxChars ?? DEFAULT_SESSION_TITLE_MAX_CHARS,
    ),
    options.maxWords,
  );
  return sanitized || null;
}
