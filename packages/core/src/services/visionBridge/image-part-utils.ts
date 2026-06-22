/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part, PartListUnion } from '@google/genai';

/**
 * Maximum base64 payload size (in MB) a single image part may carry before the
 * vision bridge refuses it. Mirrors the limit already enforced when files are
 * read into `inlineData` parts (`fileUtils.ts`), so the bridge never tries a
 * side call that the provider would reject for size.
 */
const MAX_IMAGE_BASE64_MB = 9.9;

/**
 * Normalize a {@link PartListUnion} into a flat array of {@link Part} objects.
 *
 * A `PartListUnion` may be a bare string, a single `Part`, or an array mixing
 * strings and `Part`s. Strings are wrapped as `{ text }` parts so callers can
 * treat the result uniformly.
 *
 * @param input The part list union to normalize.
 * @returns A flat array of `Part` objects (never mutated from the input).
 */
export function normalizeParts(input: PartListUnion): Part[] {
  if (typeof input === 'string') {
    return [{ text: input }];
  }
  if (Array.isArray(input)) {
    return input.map((part) =>
      typeof part === 'string' ? { text: part } : part,
    );
  }
  return [input];
}

/**
 * Determine whether a part is an inline image with usable data.
 *
 * Only `inlineData` parts whose MIME type begins with `image/` and that carry
 * non-empty base64 data qualify. This deliberately excludes audio, video, and
 * PDF `inlineData` parts, which also use the same wire shape but are not
 * something an image model can interpret. It also excludes `fileData` image
 * references because the bridge side-query path expects local inline bytes
 * produced by `@` file resolution.
 *
 * @param part The part to inspect.
 * @returns `true` when the part is a usable inline image.
 */
export function isImagePart(part: Part): boolean {
  const mimeType = part.inlineData?.mimeType;
  const data = part.inlineData?.data;
  return (
    typeof mimeType === 'string' &&
    mimeType.startsWith('image/') &&
    typeof data === 'string' &&
    data.length > 0
  );
}

/**
 * Report whether a part list contains at least one usable inline image.
 *
 * @param input The part list union to inspect.
 * @returns `true` when any part is a usable inline image.
 */
export function hasImageParts(input: PartListUnion): boolean {
  return normalizeParts(input).some(isImagePart);
}

/** Result of splitting a part list into image and non-image parts. */
export interface SplitParts {
  /** Inline image parts, in their original order. */
  imageParts: Part[];
  /** Everything that is not a usable inline image (text, tool data, etc.). */
  nonImageParts: Part[];
}

/**
 * Split a part list into image parts and everything else, preserving order.
 *
 * @param input The part list union to split.
 * @returns The image parts and non-image parts as separate arrays.
 */
export function splitImageParts(input: PartListUnion): SplitParts {
  const imageParts: Part[] = [];
  const nonImageParts: Part[] = [];
  for (const part of normalizeParts(input)) {
    if (isImagePart(part)) {
      imageParts.push(part);
    } else {
      nonImageParts.push(part);
    }
  }
  return { imageParts, nonImageParts };
}

/**
 * Validate that an image part is safe to send to the bridge model.
 *
 * Guards against empty/corrupt payloads and payloads that exceed the provider
 * size limit. Callers should drop parts that fail validation and report them
 * to the user rather than attempting a side call that is certain to fail.
 *
 * @param part The image part to validate.
 * @returns `null` when valid, otherwise a human-readable reason string.
 */
export function validateImagePart(part: Part): string | null {
  const data = part.inlineData?.data;
  if (typeof data !== 'string' || data.length === 0) {
    return 'image data is empty or unreadable';
  }
  const sizeMb = data.length / (1024 * 1024);
  if (sizeMb > MAX_IMAGE_BASE64_MB) {
    return `image exceeds the ${MAX_IMAGE_BASE64_MB}MB limit (${sizeMb.toFixed(2)}MB encoded)`;
  }
  return null;
}

/**
 * Concatenate the text of all non-image parts and trim it.
 *
 * Used both to derive the user's "intent" for the bridge prompt and to decide,
 * on failure, whether there is a real text question worth answering without the
 * image.
 *
 * @param parts The parts to collect text from.
 * @returns The joined, trimmed text (empty string when there is none).
 */
export function collectText(parts: Part[]): string {
  return parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter((text) => text.length > 0)
    .join('\n')
    .trim();
}
