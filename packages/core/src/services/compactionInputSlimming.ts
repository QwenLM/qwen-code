/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import type { ChatCompressionSettings } from '../config/config.js';

/**
 * Prepares `historyToCompress` for the side-query summary model by
 * stripping inline media. `inlineData` / `fileData` parts are replaced
 * with a short `[image: <mime>]` / `[document: <mime>]` placeholder —
 * the summary model usually cannot interpret raw base64 anyway, and
 * shipping the bytes inflates the side-query payload.
 *
 * The function never mutates the input; it returns a fresh `Content[]`
 * (or the identity-equal input when no changes were made).
 */

export const DEFAULT_IMAGE_TOKEN_ESTIMATE = 1600;

const TOKEN_TO_CHAR_RATIO = 4;
const DEFAULT_MIME = 'application/octet-stream';

/**
 * Placeholder templates. Centralized so the slimming module, the
 * char-counter, and any future consumer agree on the exact wire format
 * the summary model will see.
 */
const imagePlaceholder = (mime: string): string => `[image: ${mime}]`;
const documentPlaceholder = (mime: string): string => `[document: ${mime}]`;

export interface ResolvedSlimmingConfig {
  imageTokenEstimate: number;
}

/**
 * Resolves slimming-related knobs in priority order: env > settings >
 * default. Invalid (non-finite or out-of-range) values fall through to
 * the next source.
 */
export function resolveSlimmingConfig(
  settings: ChatCompressionSettings | undefined,
): ResolvedSlimmingConfig {
  return {
    imageTokenEstimate: resolveNumber(
      process.env['QWEN_IMAGE_TOKEN_ESTIMATE'],
      settings?.imageTokenEstimate,
      DEFAULT_IMAGE_TOKEN_ESTIMATE,
      { minInclusive: 1 },
    ),
  };
}

function resolveNumber(
  envValue: string | undefined,
  settingsValue: number | undefined,
  defaultValue: number,
  { minInclusive }: { minInclusive: number },
): number {
  if (envValue !== undefined && envValue !== '') {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed >= minInclusive) {
      return parsed;
    }
  }
  if (
    settingsValue !== undefined &&
    Number.isFinite(settingsValue) &&
    settingsValue >= minInclusive
  ) {
    return settingsValue;
  }
  return defaultValue;
}

/**
 * Approximate char count for a single `Part`, used by
 * `findCompressSplitPoint` and by the slimming module's own budget
 * accounting. Binary parts get a fixed budget (in chars) derived from
 * the configured token estimate; this keeps base64 payloads from
 * skewing the split point or token-budget math.
 */
export function estimatePartChars(
  part: Part,
  imageTokenEstimate: number,
): number {
  if (part.inlineData || part.fileData) {
    return imageTokenEstimate * TOKEN_TO_CHAR_RATIO;
  }
  if (typeof part.text === 'string') {
    return part.text.length;
  }
  return JSON.stringify(part ?? {}).length;
}

export function estimateContentChars(
  content: Content,
  imageTokenEstimate: number,
): number {
  if (!content.parts) return 0;
  let total = 0;
  for (const part of content.parts) {
    total += estimatePartChars(part, imageTokenEstimate);
  }
  return total;
}

interface SlimResult {
  slimmedHistory: Content[];
  stats: SlimStats;
}

interface SlimStats {
  imagesStripped: number;
  documentsStripped: number;
}

/**
 * Strip inline media from compaction input. The returned array has the
 * same length and ordering as the input; identity-equal when nothing
 * changed.
 */
export function slimCompactionInput(history: Content[]): SlimResult {
  const stats: SlimStats = {
    imagesStripped: 0,
    documentsStripped: 0,
  };
  let anyChange = false;

  const slimmed = history.map((content) => {
    if (!content.parts || content.parts.length === 0) return content;

    let touched = false;
    const newParts: Part[] = content.parts.map((part) => {
      const replacement = transformPart(part, stats);
      if (replacement !== part) {
        touched = true;
        return replacement;
      }
      return part;
    });

    if (!touched) return content;
    anyChange = true;
    return { ...content, parts: newParts };
  });

  return {
    slimmedHistory: anyChange ? slimmed : history,
    stats,
  };
}

function transformPart(part: Part, stats: SlimStats): Part {
  if (part.inlineData) {
    return mediaPlaceholderPart(part.inlineData.mimeType, stats);
  }
  if (part.fileData) {
    return mediaPlaceholderPart(part.fileData.mimeType, stats);
  }
  return part;
}

function mediaPlaceholderPart(
  mimeType: string | undefined,
  stats: SlimStats,
): Part {
  const mime = mimeType ?? DEFAULT_MIME;
  if (isNonImageMime(mime)) {
    stats.documentsStripped++;
    return { text: documentPlaceholder(mime) };
  }
  stats.imagesStripped++;
  return { text: imagePlaceholder(mime) };
}

function isNonImageMime(mime: string): boolean {
  // Anything outside image/* is rendered with the `[document: ...]`
  // placeholder. audio/video are rare on qwen-code's tool surface and
  // the placeholder is purely informational, so the conservative
  // grouping is acceptable.
  return !mime.startsWith('image/');
}
