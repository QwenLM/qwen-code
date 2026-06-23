/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part, PartListUnion } from '@google/genai';

/**
 * Conservative cap on a single image part's base64 length (in MB) before the
 * vision bridge refuses it, so the bridge never makes a side call a provider
 * would reject for size. Measured on the base64 string, which overstates the
 * decoded bytes by ~33%, keeping this comfortably under the repo's ~10MB
 * decoded inline-media ceiling.
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
 * Replace inline image parts with a single text part, preserving order.
 *
 * The first image's slot becomes `{ text }`; any further image parts are
 * dropped. Non-image parts keep their position. This keeps a transcribed
 * description adjacent to the "Content from <file>:" prefix that preceded the
 * image, so the primary model reads it as that file's content instead of seeing
 * an empty header and re-reading the file with a tool. If there is no image
 * part, the text is appended at the end.
 *
 * @param input The original part list (text + inline images).
 * @param text The replacement text to drop into the first image's position.
 * @returns A new flat array of parts with images collapsed into `text`.
 */
export function replaceImagesWithText(
  input: PartListUnion,
  text: string,
): Part[] {
  const result: Part[] = [];
  let replaced = false;
  for (const part of normalizeParts(input)) {
    if (isImagePart(part)) {
      if (!replaced) {
        result.push({ text });
        replaced = true;
      }
      continue; // drop additional images
    }
    result.push(part);
  }
  if (!replaced) {
    result.push({ text });
  }
  return result;
}

/**
 * Report whether an image part is safe to send to the bridge model.
 *
 * Guards against empty/corrupt payloads and payloads that exceed the provider
 * size limit. Callers should drop parts that fail so they never attempt a side
 * call that is certain to fail.
 *
 * @param part The image part to check.
 * @returns `true` when the part carries non-empty, within-limit image data.
 */
export function isUsableImagePart(part: Part): boolean {
  const data = part.inlineData?.data;
  if (typeof data !== 'string' || data.length === 0) {
    return false;
  }
  return data.length / (1024 * 1024) <= MAX_IMAGE_BASE64_MB;
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
