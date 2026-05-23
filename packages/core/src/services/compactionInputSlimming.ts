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
 * Strip characters that could break out of the placeholder envelope or
 * inject prompt-shaped content into the summary side-query. MCP tools
 * surface `mimeType` from arbitrary servers; an adversarial server
 * could craft something like `image/png]\n\n[SYSTEM: …` and have it
 * appear verbatim in the slimmed prompt.
 */
export function sanitizeMimeForPlaceholder(mime: string): string {
  return mime
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[[\]]/g, '')
    .trim()
    .slice(0, 128);
}

/**
 * Placeholder templates. Centralized so the slimming module, the
 * char-counter, and any future consumer agree on the exact wire format
 * the summary model will see.
 */
const imagePlaceholder = (mime: string): string =>
  `[image: ${sanitizeMimeForPlaceholder(mime)}]`;
const documentPlaceholder = (mime: string): string =>
  `[document: ${sanitizeMimeForPlaceholder(mime)}]`;

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
  // Tool results in qwen-code carry media on `functionResponse.parts`
  // (an extension to the @google/genai schema; see
  // `coreToolScheduler.createFunctionResponsePart`). Walk into those
  // nested parts so a base64 image attached to a `read_file` result
  // isn't billed as ~350K chars by `JSON.stringify`.
  if (part.functionResponse) {
    let total = 0;
    const output = part.functionResponse.response?.['output'];
    if (typeof output === 'string') {
      total += output.length;
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
 */
function getFunctionResponseParts(part: Part): Part[] | undefined {
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
  // Walk into functionResponse.parts (qwen-code's nested-media carrier
  // for tool results — see `coreToolScheduler.createFunctionResponsePart`).
  // Without this, base64 images returned by read_file et al. leak into
  // the side-query payload.
  const nested = getFunctionResponseParts(part);
  if (nested) {
    let touched = false;
    const newNested = nested.map((inner) => {
      const replacement = transformPart(inner, stats);
      if (replacement !== inner) {
        touched = true;
      }
      return replacement;
    });
    if (touched) {
      return {
        ...part,
        functionResponse: {
          ...part.functionResponse!,
          parts: newNested,
        } as Part['functionResponse'],
      };
    }
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
