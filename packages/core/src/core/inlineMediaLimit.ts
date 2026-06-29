/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import { sanitizeMimeForPlaceholder } from '../services/compactionInputSlimming.js';

/**
 * Default ceiling for a single inline media payload (image/audio/blob) sent to
 * the model, measured in decoded bytes. Oversized payloads blow up the request
 * size and token budget, so they are replaced with a text placeholder instead.
 */
export const DEFAULT_MAX_INLINE_MEDIA_BYTES = 10 * 1024 * 1024;

/**
 * Resolve the inline-media byte ceiling, allowing override via the
 * `QWEN_CODE_MAX_INLINE_MEDIA_BYTES` env var. Falls back to the default for
 * missing, non-numeric, non-integer, or non-positive values.
 */
export function getMaxInlineMediaBytes(): number {
  const raw = process.env['QWEN_CODE_MAX_INLINE_MEDIA_BYTES'];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_MAX_INLINE_MEDIA_BYTES;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_INLINE_MEDIA_BYTES;
}

/**
 * Estimate the decoded byte length of a base64 string without decoding it.
 * Tolerates an optional `data:<mime>;base64,` prefix.
 */
export function approxBase64Bytes(base64: string): number {
  // Measure by string length (no decode/copy) so multi-MB payloads stay cheap
  // on the prompt hot path. Only scan for the comma when a data: prefix is
  // actually present; raw base64 (the common case) skips the scan entirely.
  let start = 0;
  if (base64.startsWith('data:')) {
    const commaIndex = base64.indexOf(',');
    if (commaIndex !== -1) {
      start = commaIndex + 1;
    }
  }
  const length = base64.length - start;
  if (length === 0) {
    return 0;
  }
  // Padding chars are always trailing, so endsWith on the full string is safe.
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((length * 3) / 4) - padding;
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * Build the placeholder text substituted for an oversized inline media part.
 */
export function oversizedMediaPlaceholder(
  mimeType: string,
  bytes: number,
  limitBytes: number,
): string {
  // Sanitize: the mime can originate from an untrusted resource/MCP server,
  // and is embedded into a bracketed envelope the model reads as text.
  const mime = sanitizeMimeForPlaceholder(mimeType);
  return (
    `[Media omitted: ${mime} is ~${formatMb(bytes)}MB, exceeding the ` +
    `${formatMb(limitBytes)}MB inline limit. Ask the user to resize/compress ` +
    `it, or reference it via an @file path so it can be read from disk.]`
  );
}

/**
 * Guard a single Gemini {@link Part}: if it carries inline media larger than
 * `limitBytes`, return a text placeholder part instead; otherwise return the
 * part unchanged. Non-media parts pass through untouched.
 */
export function clampInlineMediaPart(
  part: Part,
  limitBytes: number = getMaxInlineMediaBytes(),
): Part {
  const data = part.inlineData?.data;
  if (!data) {
    return part;
  }
  const bytes = approxBase64Bytes(data);
  if (bytes <= limitBytes) {
    return part;
  }
  const mimeType = part.inlineData?.mimeType ?? 'application/octet-stream';
  return { text: oversizedMediaPlaceholder(mimeType, bytes, limitBytes) };
}
