/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';

export const DEFAULT_IMAGE_TOKEN_ESTIMATE = 1600;
export const TOKEN_TO_CHAR_RATIO = 4;

/**
 * Approximate char count for a single `Part`, used by
 * `estimateContentChars` and by the slimming module's own budget
 * accounting. Binary parts get a fixed budget (in chars) derived from
 * the configured token estimate; this keeps base64 payloads from
 * skewing compression size estimation or token-budget math.
 */
export function estimatePartChars(
  part: Part,
  imageTokenEstimate: number,
): number {
  if (part.inlineData || part.fileData) {
    return imageTokenEstimate * TOKEN_TO_CHAR_RATIO;
  }
  if (typeof part.text === 'string') {
    // A thought's signature is replayed beside its text, so it takes room in
    // the request too (#9455). Other parts reach `JSON.stringify` below,
    // which already counts it.
    return part.text.length + (part.thoughtSignature?.length ?? 0);
  }
  // Tool results in qwen-code carry media on `functionResponse.parts`
  // (an extension to the @google/genai schema; see
  // `coreToolScheduler.createFunctionResponsePart`). Walk into those
  // nested parts so a base64 image attached to a `read_file` result
  // isn't billed as ~350K chars by `JSON.stringify`.
  if (part.functionResponse) {
    let total = 0;
    const output = part.functionResponse.response?.['output'];
    const error = part.functionResponse.response?.['error'];
    if (typeof output === 'string') {
      total += output.length;
    } else if (typeof error === 'string') {
      total += error.length;
    }
    const nested = getFunctionResponseParts(part);
    if (nested) {
      for (const inner of nested) {
        total += estimatePartChars(inner, imageTokenEstimate);
      }
    }
    // Add a small fixed floor for the wrapper metadata (id, name) so a
    // pure media-only response isn't reported as just the image budget.
    return total + 64;
  }
  return JSON.stringify(part ?? {}).length;
}

/**
 * Returns the nested-parts array from a `functionResponse`, if present.
 * qwen-code attaches media here (see
 * `coreToolScheduler.createFunctionResponsePart`); the standard
 * `@google/genai` FunctionResponse type does not declare it.
 *
 * Exported so post-compact image extraction/counting walks the SAME
 * carrier the slimmer strips — otherwise the two disagree on where tool
 * media lives and screenshots silently vanish from restoration.
 */
export function getFunctionResponseParts(part: Part): Part[] | undefined {
  const fr = part.functionResponse as { parts?: unknown } | undefined;
  return Array.isArray(fr?.parts) ? (fr.parts as Part[]) : undefined;
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

/**
 * Estimate the token count of a list of Content objects via char/4.
 *
 * Reuses `estimateContentChars` so that inlineData / functionCall /
 * functionResponse get the same treatment they receive when computing
 * compression size estimates — keeping the two estimators in sync prevents
 * the auto-compaction trigger and the compressor from disagreeing on size.
 *
 * This is a local estimate for budgeting and cannot measure provider usage.
 */
export function estimateContentTokens(
  contents: Content[],
  imageTokenEstimate: number = DEFAULT_IMAGE_TOKEN_ESTIMATE,
): number {
  return Math.ceil(
    contentChars(contents, imageTokenEstimate) / TOKEN_TO_CHAR_RATIO,
  );
}

export function contentChars(
  contents: Content[],
  imageTokenEstimate: number,
): number {
  let totalChars = 0;
  for (const content of contents) {
    totalChars += estimateContentChars(content, imageTokenEstimate);
  }
  return totalChars;
}
