/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import type { ChatCompressionRecordPayload } from '../services/chatRecordingService.js';
import { AUTO_MEMORY_SNAPSHOT_METADATA } from './api-history-metadata.js';

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

/** Media objects retain their identity when history copies its part containers. */
type MediaPayload = NonNullable<Part['inlineData'] | Part['fileData']>;

export function estimatedMedia(content: Content): MediaPayload[] {
  const media: MediaPayload[] = [];
  function visit(part: Part): void {
    const data = part.inlineData ?? part.fileData;
    if (data) media.push(data);
    else if (typeof part.text !== 'string')
      getFunctionResponseParts(part)?.forEach(visit);
  }
  content.parts?.forEach(visit);
  return media;
}

export function catalogSnapshotChars(content: Content): number {
  let chars = 0;
  for (const part of content.parts ?? []) {
    if (part.partMetadata?.[AUTO_MEMORY_SNAPSHOT_METADATA] === true) {
      chars += estimatePartChars(part, 0);
    }
  }
  return chars;
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

export function savedMediaTokenCosts(
  payload: ChatCompressionRecordPayload,
): number[][] | undefined {
  if (!Array.isArray(payload.compressedHistory)) return undefined;
  const costs = payload.mediaTokenCosts;
  if (
    Array.isArray(costs) &&
    costs.length === payload.compressedHistory.length &&
    costs.every(Array.isArray)
  )
    return costs;
  // Older mixed checkpoints rounded pending input on its own. Its excess over
  // the text charge identifies the media share only when it explains the entire override.
  if (!Array.isArray(payload.pruneContentChars) || !payload.info)
    return undefined;
  const pending = payload.compressedHistory.at(-1);
  const saved = payload.pruneContentChars.at(-1);
  if (
    !pending ||
    pending.role !== 'user' ||
    saved === undefined ||
    payload.resumePromptTokenCount === undefined ||
    payload.resumePromptTokenCount - payload.info.newTokenCount !==
      saved / TOKEN_TO_CHAR_RATIO
  )
    return undefined;
  const count = estimatedMedia(pending).length;
  if (!count) return undefined;
  const catalog = catalogSnapshotChars(pending);
  const change = payload.catalogSwitchChars?.at(-1);
  if (catalog && !change) return undefined;
  const text =
    estimateContentChars(pending, 0) - ((change ?? 0) > 0 ? catalog : 0);
  const cost =
    (saved / TOKEN_TO_CHAR_RATIO - Math.ceil(text / TOKEN_TO_CHAR_RATIO)) /
    count;
  if (!Number.isFinite(cost) || cost <= 0) return undefined;
  const recovered: number[][] = payload.compressedHistory.map(() => []);
  recovered[recovered.length - 1] = Array<number>(count).fill(cost);
  return recovered;
}
