/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import type { ChatCompressionSettings } from '../config/config.js';
import type { InputModalities } from '../core/contentGenerator.js';
import { VISUAL_PIXELS_PER_TOKEN } from '../omni/estimation.js';
import { ToolNames } from '../tools/tool-names.js';
import { parseImageDimensions } from '../utils/image-dimensions.js';

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

/**
 * Generic char/token conversion factor (claude-code's canonical heuristic).
 * Exported so adjacent estimators (`tokenEstimation.ts`'s `CHARS_PER_TOKEN`)
 * stay programmatically linked — if this ever moves, both sites move
 * together rather than drifting silently.
 */
export const TOKEN_TO_CHAR_RATIO = 4;
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
  {
    integer = false,
    minInclusive,
  }: { integer?: boolean; minInclusive: number },
): number {
  const isValid = (value: number) =>
    Number.isFinite(value) &&
    (!integer || Number.isSafeInteger(value)) &&
    value >= minInclusive;

  if (envValue !== undefined && envValue !== '') {
    const trimmed = envValue.trim();
    if (integer && !/^\d+$/.test(trimmed)) {
      return settingsValue !== undefined && isValid(settingsValue)
        ? settingsValue
        : defaultValue;
    }
    const parsed = Number(trimmed);
    if (isValid(parsed)) {
      return parsed;
    }
  }
  if (settingsValue !== undefined && isValid(settingsValue)) {
    return settingsValue;
  }
  return defaultValue;
}

export const DEFAULT_MAX_RECENT_FILES = 5;
export const DEFAULT_MAX_RECENT_IMAGES = 3;
export const DEFAULT_SCREENSHOT_TRIGGER_ENABLED = true;
export const DEFAULT_SCREENSHOT_TRIGGER_THRESHOLD = 20;
export const DEFAULT_IMAGE_PAYLOAD_THRESHOLD = 20;

export interface ResolvedCompactionTuning {
  /** Recent files restored after compaction (0 = restore none). */
  maxRecentFiles: number;
  /** Recent images restored after compaction (0 = restore none). */
  maxRecentImages: number;
  /** Whether tool-image accumulation can trigger auto-compaction. */
  enableScreenshotTrigger: boolean;
  /** Tool-image count at or above which the trigger fires (≥ 1). */
  screenshotTriggerThreshold: number;
  /**
   * Inline image count at or above which historical image payloads
   * are replaced with text references and only recent images are
   * reattached. Below this threshold images stay in-place untouched.
   */
  imagePayloadThreshold: number;
}

/**
 * Resolves the post-compact retention + screenshot-trigger knobs in
 * priority order env > settings > default. Count-like fields require
 * integer values because downstream collectors compare against integer
 * lengths.
 *
 * The screenshot trigger counts only images nested in
 * `functionResponse.parts` (tool results). Compaction replaces those with
 * the summary, and the surviving images are re-embedded as TOP-LEVEL parts
 * in the restoration block — which the counter ignores. So compaction
 * always resets the tool-image count to ~0 and the trigger cannot
 * immediately re-fire, independent of `maxRecentImages`.
 */
export function resolveCompactionTuning(
  settings: ChatCompressionSettings | undefined,
): ResolvedCompactionTuning {
  return {
    maxRecentFiles: resolveNumber(
      process.env['QWEN_COMPACT_MAX_RECENT_FILES'],
      settings?.maxRecentFilesToRetain,
      DEFAULT_MAX_RECENT_FILES,
      { integer: true, minInclusive: 0 },
    ),
    maxRecentImages: resolveNumber(
      process.env['QWEN_COMPACT_MAX_RECENT_IMAGES'],
      settings?.maxRecentImagesToRetain,
      DEFAULT_MAX_RECENT_IMAGES,
      { integer: true, minInclusive: 0 },
    ),
    enableScreenshotTrigger: resolveBoolean(
      process.env['QWEN_COMPACT_SCREENSHOT_TRIGGER'],
      settings?.enableScreenshotTrigger,
      DEFAULT_SCREENSHOT_TRIGGER_ENABLED,
    ),
    screenshotTriggerThreshold: resolveNumber(
      process.env['QWEN_COMPACT_SCREENSHOT_THRESHOLD'],
      settings?.screenshotTriggerThreshold,
      DEFAULT_SCREENSHOT_TRIGGER_THRESHOLD,
      { integer: true, minInclusive: 1 },
    ),
    imagePayloadThreshold: resolveNumber(
      process.env['QWEN_IMAGE_PAYLOAD_THRESHOLD'],
      settings?.imagePayloadThreshold,
      DEFAULT_IMAGE_PAYLOAD_THRESHOLD,
      { integer: true, minInclusive: 1 },
    ),
  };
}

/**
 * Resolves a boolean knob in priority order env > settings > default.
 * Accepts `1`/`true` and `0`/`false` (case-sensitive, matching the
 * existing `getEmitToolUseSummaries` convention); any other env string
 * is ignored so a typo falls through rather than silently flipping the
 * flag.
 */
function resolveBoolean(
  envValue: string | undefined,
  settingsValue: boolean | undefined,
  defaultValue: boolean,
): boolean {
  if (envValue === '1' || envValue === 'true') return true;
  if (envValue === '0' || envValue === 'false') return false;
  if (typeof settingsValue === 'boolean') return settingsValue;
  return defaultValue;
}

/**
 * Approximate char count for a single `Part`, used by
 * `estimateContentChars` and by the slimming module's own budget
 * accounting. Binary parts get a fixed budget (in chars) derived from
 * the configured token estimate; this keeps base64 payloads from
 * skewing compression size estimation or token-budget math. Binary parts
 * carry the configured flat estimate when the header does not parse, and
 * the resolution-derived charge when it does. `imageTokenFloor` (as the
 * transport guard passes) is a LOWER BOUND on the image charge —
 * `max(resolution, floor)` — not a branch back to flat: a 4K image
 * still bills its 4050 resolution tokens even with the 1600 floor.
 */
export function estimatePartChars(
  part: Part,
  imageTokenEstimate: number,
  imageTokenFloor?: number,
): number {
  if (part.inlineData || part.fileData) {
    let tokens = estimateInlineImageTokens(part, imageTokenEstimate);
    // The transport guard prices kept images at no less than the resolved
    // flat estimate: the resolution charge can be LOWER than what the
    // provider actually transports, and under-subtracting there is the
    // non-retryable 400 this budget exists to prevent (#17321 F2). The
    // compression estimators pass no floor — for them the resolution
    // charge is the whole point.
    if (imageTokenFloor !== undefined) {
      tokens = Math.max(tokens, imageTokenFloor);
    }
    return tokens * TOKEN_TO_CHAR_RATIO;
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
    const error = part.functionResponse.response?.['error'];
    if (typeof output === 'string') {
      total += output.length;
    } else if (typeof error === 'string') {
      total += error.length;
    }
    const nested = getFunctionResponseParts(part);
    if (nested) {
      for (const inner of nested) {
        total += estimatePartChars(inner, imageTokenEstimate, imageTokenFloor);
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

/**
 * Token estimate for an inline image (#17315): when the
 * base64 payload carries a parseable image header, charge the patch-grid
 * formula the omni pipeline already uses (pixels / VISUAL_PIXELS_PER_TOKEN)
 * so a small screenshot and a 4K diagram stop costing the same flat 1600.
 * Anything unparseable — other binary kinds, fileData without bytes —
 * keeps the configured flat estimate.
 */
function estimateInlineImageTokens(
  part: Part,
  resolvedTokenEstimate: number,
): number {
  // An explicitly configured estimate (env `QWEN_IMAGE_TOKEN_ESTIMATE` or
  // `chatCompression.imageTokenEstimate`) is an override — it must keep
  // having an effect. Resolution-derived costing runs only when the
  // resolved value IS the default, so any other number is the user's
  // deliberate answer (#17321 maintainer call).
  if (resolvedTokenEstimate !== DEFAULT_IMAGE_TOKEN_ESTIMATE) {
    return resolvedTokenEstimate;
  }
  const inline = part.inlineData;
  if (!inline?.data || !inline.mimeType?.startsWith('image/')) {
    return resolvedTokenEstimate;
  }
  try {
    const buffer = Buffer.from(inline.data, 'base64');
    const bytes = new Uint8Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength,
    );
    // Animated payloads (multi-frame GIF, animated WebP) bill the flat
    // estimate until frame counting lands: a 60-frame GIF at the static
    // formula would be a 27x regression in the unsafe direction
    // (#17321 maintainer call).
    if (isPotentiallyAnimated(bytes, inline.mimeType)) {
      return resolvedTokenEstimate;
    }
    const dimensions = parseImageDimensions(bytes);
    if (!dimensions) return resolvedTokenEstimate;
    return Math.ceil(
      (dimensions.width * dimensions.height) / VISUAL_PIXELS_PER_TOKEN,
    );
  } catch {
    return resolvedTokenEstimate;
  }
}

/**
 * Conservative animation check: every GIF (frame counting needs a real
 * parser), a PNG carrying an acTL chunk (APNG), and a WebP with the VP8X
 * ANIM flag. Anything else — static PNG/WebP included — continues on the
 * resolution path. Keyed on magic bytes, never the mime label.
 */
function isPotentiallyAnimated(bytes: Uint8Array, mime: string): boolean {
  // Keyed on magic bytes, not the mime label (#17321 F3): a text file
  // labeled image/gif must not reach the GIF parser, and a PNG must be
  // checked for APNG animation chunks regardless of the label.
  if (isGifBytes(bytes)) {
    // GIF is always flat: counting image descriptors (0x2C) by byte scan
    // is wrong in both directions. Frame counting needs a real parser
    // (#17321 R1-1).
    return true;
  }
  if (isPngBytes(bytes)) {
    // APNG has an acTL (animation control) chunk before IDAT — a
    // structural marker, not a heuristic. Walk the CHUNK structure
    // (length + type + payload + CRC) and match only TYPE fields: a raw
    // byte scan would let 'acTL' bytes inside a tEXt PAYLOAD decide the
    // answer (#17321 R1-1). Metadata chunks before acTL are legal and
    // unbounded, so the walk covers the whole pre-IDAT region — a 1 KiB
    // window would miss acTL behind a large tEXt chunk (#17321 F1
    // residual).
    let offset = 8;
    while (offset + 8 <= bytes.length) {
      const length =
        (bytes[offset]! * 0x1_00_00_00 +
          bytes[offset + 1]! * 0x1_00_00 +
          bytes[offset + 2]! * 0x1_00 +
          bytes[offset + 3]!) >>>
        0;
      const t0 = bytes[offset + 4]!;
      const t1 = bytes[offset + 5]!;
      const t2 = bytes[offset + 6]!;
      const t3 = bytes[offset + 7]!;
      if (t0 === 0x61 && t1 === 0x63 && t2 === 0x54 && t3 === 0x4c) {
        return true; // 'acTL' chunk type
      }
      if (t0 === 0x49 && t1 === 0x44 && t2 === 0x41 && t3 === 0x54) {
        return false; // 'IDAT' — acTL must appear before the image data
      }
      // Malformed/absurd length: fall back to conservative animated
      // rather than walking past the buffer.
      if (length > bytes.length) return true;
      offset += 12 + length; // length + type + payload + CRC
    }
    return false;
  }
  if (isWebPBytes(bytes)) {
    // VP8X flags byte at payload offset 0: bit 1 (value 2) is ANIM —
    // a real bit in the header, not a heuristic. Keyed on the RIFF/WEBP
    // magic, not the mime label, so a mislabeled animated WebP is still
    // billed flat (#17321 F1 residual).
    if (bytes.length > 20) {
      const tag = String.fromCharCode(
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
      );
      if (tag === 'VP8X') {
        return (bytes[20] & 0x02) !== 0;
      }
    }
    return false;
  }
  // Mime-level fallback for formats without magic-byte checks above.
  return mime === 'image/gif';
}

function isGifBytes(b: Uint8Array): boolean {
  return (
    b.length > 6 &&
    b[0] === 0x47 &&
    b[1] === 0x49 &&
    b[2] === 0x46 && // 'GIF'
    b[3] === 0x38 && // '8'
    (b[4] === 0x37 || b[4] === 0x39) && // '7' or '9'
    b[5] === 0x61 // 'a'
  );
}

function isPngBytes(b: Uint8Array): boolean {
  return (
    b.length > 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 // PNG sig
  );
}

function isWebPBytes(b: Uint8Array): boolean {
  return (
    b.length > 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 && // 'RIFF'
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50 // 'WEBP'
  );
}

export function estimateContentChars(
  content: Content,
  imageTokenEstimate: number,
  imageTokenFloor?: number,
): number {
  if (!content.parts) return 0;
  let total = 0;
  for (const part of content.parts) {
    total += estimatePartChars(part, imageTokenEstimate, imageTokenFloor);
  }
  return total;
}

interface SlimResult {
  slimmedHistory: Content[];
  stats: SlimStats;
}

/** Appended to text payloads truncated by `maxTextChars`. */
export const SLIM_TEXT_TRUNCATION_MARKER = '\n[...truncated for compaction]';

export interface SlimOptions {
  /**
   * When set, text payloads larger than this (top-level `text` parts,
   * tool-result `output`/`error` strings, and `functionCall` string args)
   * are truncated to this many characters plus an elision marker. Used when
   * a compaction is triggered by an HTTP 413 request-body overflow: the
   * side-query must fit under the same gateway byte limit as the request
   * that was rejected (#10380). Regular (token-driven) compactions pass
   * nothing and keep text intact.
   */
  maxTextChars?: number;
}

interface SlimStats {
  imagesStripped: number;
  documentsStripped: number;
  textPartsTruncated: number;
}

/**
 * Strip inline media from compaction input. The returned array has the
 * same length and ordering as the input; identity-equal when nothing
 * changed.
 */
export function slimCompactionInput(
  history: Content[],
  supportedModalities?: InputModalities,
  options?: SlimOptions,
): SlimResult {
  const stats: SlimStats = {
    imagesStripped: 0,
    documentsStripped: 0,
    textPartsTruncated: 0,
  };
  let anyChange = false;

  const slimmed = history.map((content) => {
    if (!content.parts || content.parts.length === 0) return content;

    let touched = false;
    const newParts: Part[] = content.parts.map((part) => {
      const replacement = transformPart(
        part,
        stats,
        supportedModalities,
        options,
      );
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

function transformPart(
  part: Part,
  stats: SlimStats,
  supportedModalities?: InputModalities,
  options?: SlimOptions,
): Part {
  if (part.inlineData) {
    if (
      supportsMimeType(part.inlineData.mimeType, supportedModalities) === true
    ) {
      return part;
    }
    return mediaPlaceholderPart(part.inlineData.mimeType, stats);
  }
  if (part.fileData) {
    if (
      supportsMimeType(part.fileData.mimeType, supportedModalities) === true
    ) {
      return part;
    }
    return mediaPlaceholderPart(part.fileData.mimeType, stats);
  }
  // Walk into functionResponse.parts (qwen-code's nested-media carrier
  // for tool results — see `coreToolScheduler.createFunctionResponsePart`).
  // Without this, base64 images returned by read_file et al. leak into
  // the side-query payload.
  let nextPart: Part = part;
  const nested = getFunctionResponseParts(part);
  if (nested) {
    let touched = false;
    const newNested = nested.map((inner) => {
      const replacement = transformPart(
        inner,
        stats,
        supportedModalities,
        options,
      );
      if (replacement !== inner) {
        touched = true;
      }
      return replacement;
    });
    if (touched) {
      nextPart = {
        ...part,
        functionResponse: {
          ...part.functionResponse!,
          parts: newNested,
        } as Part['functionResponse'],
      };
    }
  }
  // Truncate oversized tool-result text on the payload-overflow compaction
  // path so the side-query itself fits under the gateway byte limit that
  // rejected the main request (#10380). Mirrors `estimatePartChars`, which
  // bills exactly these carriers for tool results.
  const maxTextChars = options?.maxTextChars;
  const fr = nextPart.functionResponse;
  if (maxTextChars !== undefined && fr?.response) {
    const response = fr.response;
    let touched = false;
    const newResponse: Record<string, unknown> = { ...response };
    for (const key of ['output', 'error'] as const) {
      const value = response[key];
      if (typeof value === 'string' && value.length > maxTextChars) {
        newResponse[key] = truncateTextForSlimming(value, maxTextChars);
        stats.textPartsTruncated++;
        touched = true;
      }
    }
    if (touched) {
      nextPart = {
        ...nextPart,
        functionResponse: {
          ...fr,
          response: newResponse,
        } as Part['functionResponse'],
      };
    }
  }
  // Truncate oversized string args on the payload-overflow path as well:
  // `write_file`/`edit` carry entire file contents in
  // `functionCall.args.content`, and `estimatePartChars` bills them through
  // the JSON.stringify fallthrough — left untouched they ride into the
  // side-query at full size (#10380). Bridge calls carry those same args one
  // level deeper under `tool_call.arguments`, so walk that envelope too.
  const fc = nextPart.functionCall;
  if (maxTextChars !== undefined && fc?.args) {
    const args = fc.args;
    let argsTouched = false;
    const newArgs: Record<string, unknown> = { ...args };
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && value.length > maxTextChars) {
        newArgs[key] = truncateTextForSlimming(value, maxTextChars);
        stats.textPartsTruncated++;
        argsTouched = true;
      }
    }
    const bridgedArgs = args['arguments'];
    if (
      fc.name === ToolNames.TOOL_CALL &&
      typeof bridgedArgs === 'object' &&
      bridgedArgs !== null &&
      !Array.isArray(bridgedArgs)
    ) {
      let bridgedArgsTouched = false;
      const newBridgedArgs: Record<string, unknown> = { ...bridgedArgs };
      for (const [key, value] of Object.entries(bridgedArgs)) {
        if (typeof value === 'string' && value.length > maxTextChars) {
          newBridgedArgs[key] = truncateTextForSlimming(value, maxTextChars);
          stats.textPartsTruncated++;
          bridgedArgsTouched = true;
        }
      }
      if (bridgedArgsTouched) {
        newArgs['arguments'] = newBridgedArgs;
        argsTouched = true;
      }
    }
    if (argsTouched) {
      nextPart = {
        ...nextPart,
        functionCall: { ...fc, args: newArgs },
      };
    }
  }
  if (
    maxTextChars !== undefined &&
    typeof nextPart.text === 'string' &&
    nextPart.text.length > maxTextChars
  ) {
    stats.textPartsTruncated++;
    // Spread rather than rebuilding a bare `{ text }` so sibling properties
    // (`thought`, `thoughtSignature`, ...) survive truncation — the converter
    // pipeline keys reasoning parts off those flags (#10380).
    return {
      ...nextPart,
      text: truncateTextForSlimming(nextPart.text, maxTextChars),
    };
  }
  return nextPart;
}

function truncateTextForSlimming(value: string, maxTextChars: number): string {
  let end = maxTextChars;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end--;
  }
  return value.slice(0, end) + SLIM_TEXT_TRUNCATION_MARKER;
}

function supportsMimeType(
  mimeType: string | undefined,
  modalities: InputModalities | undefined,
): boolean | undefined {
  if (!modalities) return undefined;
  const mime = mimeType ?? DEFAULT_MIME;
  if (mime.startsWith('image/')) return modalities.image;
  if (mime === 'application/pdf') return modalities.pdf;
  if (mime.startsWith('audio/')) return modalities.audio;
  if (mime.startsWith('video/')) return modalities.video;
  return false;
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
