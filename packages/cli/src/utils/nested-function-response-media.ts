/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helpers for policing inline media nested inside `functionResponse.parts` —
 * the carrier qwen-code uses for tool-result images/audio (see
 * `coreToolScheduler.createFunctionResponsePart`). Both the interactive hook
 * (`useLlmStream.applyToolResultMediaGate`) and the headless loop
 * (`nonInteractiveCli`) gate these against the active media route, so the
 * helpers live here (a leaf module with no UI dependency) and are shared.
 */

import type { Part, PartListUnion } from '@google/genai';
import { clampInlineMediaPart } from '@qwen-code/qwen-code-core';

/**
 * True when a nested tool-result part carries usable media bytes. Both
 * carriers count: core's `convertToFunctionResponse` nests `inlineData` AND
 * `fileData` parts into `functionResponse.parts` (tested at
 * coreToolScheduler's 'should handle llmContent with fileData'), and core's
 * slimming/microcompact treat `inlineData || fileData` as media. Policing
 * only `inlineData` would let an extension/custom tool's `fileData` media
 * slip past the gate into silent route slimming.
 */
function nestedPartCarriesMedia(inner: Part): boolean {
  const hasInline =
    typeof inner.inlineData?.data === 'string' &&
    inner.inlineData.data.length > 0;
  const fileUri = (inner.fileData as { fileUri?: unknown } | undefined)
    ?.fileUri;
  return hasInline || (typeof fileUri === 'string' && fileUri.length > 0);
}

/** MIME types are case-insensitive (RFC 6838); MCP servers supply them verbatim. */
function nestedPartMime(inner: Part): string | undefined {
  const mime =
    inner.inlineData?.mimeType ??
    (inner.fileData as { mimeType?: unknown } | undefined)?.mimeType;
  return typeof mime === 'string' ? mime : undefined;
}

/**
 * Extension-supplied parts reach the walkers verbatim and may be null or
 * non-object; only plain objects can be media carriers. Guarded so a
 * malformed part list fails closed instead of throwing mid-prepare.
 */
function isMediaCarrierCandidate(inner: unknown): inner is Part {
  return inner !== null && typeof inner === 'object';
}

/** The only modalities the routing layer can exact-route to a model. */
function isRoutableMime(mime: string): boolean {
  const lower = mime.toLowerCase();
  return lower.startsWith('image/') || lower.startsWith('audio/');
}

/**
 * Detect inline media nested inside `functionResponse.parts`. The top-level
 * `hasImageParts`/`hasAudioParts` helpers only see top-level `inlineData`, so
 * a tool-result continuation's media is invisible to them.
 *
 * MIME-less media carriers are reported as `hasUntyped` and fail closed
 * unconditionally: core's route slimming resolves a missing MIME to
 * `DEFAULT_MIME` (`application/octet-stream`), which matches NO modality, so
 * such a part is placeholder-substituted on EVERY route — even an
 * all-capable one. The gates must police it themselves (visibly) instead of
 * letting the model answer about media it never received. Core's
 * `convertToFunctionResponse` nests tool-supplied parts verbatim without
 * normalizing `mimeType`, so untyped custom/extension adapters reach this
 * code path.
 *
 * The axes key on CARRIER PRESENCE, not an enumeration of known MIME
 * classes: any media carrier whose MIME matches no routable modality
 * (image/ or audio/) is reported as `hasForeign` — `video/*`,
 * `application/pdf`, `application/octet-stream` (the MCP default for a
 * MIME-less embedded resource), or an empty-string MIME. Core's slimming
 * placeholder-substitutes such carriers on every route (they match no
 * modality), so the gates must fail them closed visibly instead of letting
 * the model answer about media it never received. Enumerating MIME
 * prefixes can never converge on an unbounded tool-supplied entrance space.
 */
export function detectNestedFunctionResponseMedia(parts: PartListUnion): {
  hasImage: boolean;
  hasAudio: boolean;
  hasUntyped: boolean;
  hasForeign: boolean;
} {
  const list = Array.isArray(parts) ? parts : [parts];
  let hasImage = false;
  let hasAudio = false;
  let hasUntyped = false;
  let hasForeign = false;
  for (const part of list) {
    if (!isMediaCarrierCandidate(part)) continue;
    const nested = (part.functionResponse as { parts?: unknown } | undefined)
      ?.parts;
    if (!Array.isArray(nested)) continue;
    for (const inner of nested as unknown[]) {
      if (!isMediaCarrierCandidate(inner)) continue;
      if (!nestedPartCarriesMedia(inner)) {
        continue;
      }
      const mime = nestedPartMime(inner);
      if (mime === undefined) {
        hasUntyped = true;
        continue;
      }
      // Case-insensitive, mirroring the audio bridge's own `isAudioPart`
      // (which lowercases first): an 'AUDIO/WAV' tool result must be policed
      // exactly like 'audio/wav'.
      if (isRoutableMime(mime)) {
        if (mime.toLowerCase().startsWith('image/')) hasImage = true;
        else hasAudio = true;
      } else {
        hasForeign = true;
      }
    }
  }
  return { hasImage, hasAudio, hasUntyped, hasForeign };
}

export function stringifyStructuredToolOutput(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Replace inline media nested inside `functionResponse.parts` with a text note
 * and append the note to the response text, so a fail-closed tool-result media
 * payload keeps its shape but carries no raw bytes. Returns the input unchanged
 * (identity) when no nested media matched.
 */
export function replaceNestedFunctionResponseMedia(
  parts: PartListUnion,
  match: 'image' | 'audio' | 'untyped' | 'foreign',
  note: string,
): Part[] {
  const prefix = match === 'image' ? 'image/' : 'audio/';
  const list = Array.isArray(parts) ? parts : [parts];
  return list.map((part) => {
    if (typeof part === 'string') return { text: part };
    if (!isMediaCarrierCandidate(part)) return part as Part;
    const functionResponse = part.functionResponse as
      | ({ parts?: unknown } & Record<string, unknown>)
      | undefined;
    const nested = functionResponse?.parts;
    if (!Array.isArray(nested)) return part;
    let touched = false;
    const retained: Part[] = [];
    for (const inner of nested as unknown[]) {
      if (!isMediaCarrierCandidate(inner)) {
        retained.push(inner as Part);
        continue;
      }
      const mime = nestedPartMime(inner);
      // Same predicates as `detectNestedFunctionResponseMedia` — both
      // carriers (`inlineData` and `fileData`), case-insensitive MIME
      // matching, MIME-less carriers for the `untyped` axis, and any
      // non-routable MIME for the `foreign` axis (core's slimming
      // placeholder-substitutes both on every route, so the gates fail them
      // closed visibly).
      const isMatch =
        match === 'untyped'
          ? mime === undefined && nestedPartCarriesMedia(inner)
          : match === 'foreign'
            ? mime !== undefined &&
              nestedPartCarriesMedia(inner) &&
              !isRoutableMime(mime)
            : mime !== undefined &&
              mime.toLowerCase().startsWith(prefix) &&
              nestedPartCarriesMedia(inner);
      if (isMatch) {
        touched = true;
      } else {
        retained.push(inner);
      }
    }
    if (!touched) return part;
    const { parts: _dropped, ...rest } = functionResponse ?? {};
    // Core's convertToFunctionResponse passes tool-supplied functionResponse
    // parts through verbatim, so `response` is not guaranteed to be a plain
    // object — untyped custom tool adapters return arrays, scalars, and raw
    // strings (the boundary coreToolScheduler's tests exercise). Spreading a
    // non-object `response` into the rebuilt object would silently mangle the
    // payload: an array becomes a numeric-keyed object, a scalar spreads to
    // `{}` (erasing the tool output entirely), a string scatters into
    // char-indexed entries — violating the preserve-don't-erase invariant
    // this rebuild is bound by. Spread only plain objects; preserve any other
    // shape by folding its stringified form into the appended note.
    const rawResponse = rest['response'];
    const isPlainObjectResponse =
      typeof rawResponse === 'object' &&
      rawResponse !== null &&
      !Array.isArray(rawResponse);
    const response = (isPlainObjectResponse ? rawResponse : {}) as Record<
      string,
      unknown
    >;
    const key = typeof response['error'] === 'string' ? 'error' : 'output';
    const current = response[key];
    const preservedResponse =
      !isPlainObjectResponse &&
      rawResponse !== undefined &&
      rawResponse !== null
        ? `${stringifyStructuredToolOutput(rawResponse)}\n\n`
        : '';
    // A structured (non-string) output — core's convertToFunctionResponse
    // passes tool-supplied functionResponse parts through verbatim — must be
    // preserved, not erased: stringify it and append the note, so the tool
    // result survives even though the nested media it carried is omitted.
    const nextResponse = {
      ...response,
      [key]:
        typeof current === 'string' && current.length > 0
          ? `${current}\n\n${note}`
          : current === undefined || current === null || current === ''
            ? `${preservedResponse}${note}`
            : `${stringifyStructuredToolOutput(current)}\n\n${note}`,
    };
    return {
      ...part,
      functionResponse: {
        ...rest,
        response: nextResponse,
        ...(retained.length > 0 ? { parts: retained } : {}),
      } as Part['functionResponse'],
    };
  });
}

/**
 * Clamp inline media nested inside `functionResponse.parts` with the same
 * `QWEN_CODE_MAX_INLINE_MEDIA_BYTES` ceiling every top-level routing path
 * applies (audio-route clamp, native-skip clamp, image-route clamp, R33-2
 * clamp, full-turn clamp; core's `clampNestedImages` covers the vision-bridge
 * path). Without this, a media-routed tool-result continuation carrying an
 * oversized supported-modality blob skips the clamp entirely — the exact
 * blowup `clampInlineMediaPart` documents. Returns the input unchanged
 * (identity) when nothing is oversized.
 */
export function clampNestedFunctionResponseMedia(
  parts: PartListUnion,
): PartListUnion {
  const list = Array.isArray(parts) ? parts : [parts];
  let touched = false;
  const mapped: Part[] = list.map((part) => {
    if (typeof part === 'string') return { text: part };
    if (!isMediaCarrierCandidate(part)) return part as Part;
    const functionResponse = part.functionResponse as
      | ({ parts?: unknown } & Record<string, unknown>)
      | undefined;
    const nested = functionResponse?.parts;
    if (!Array.isArray(nested)) return part;
    let nestedTouched = false;
    const clampedInner = (nested as unknown[]).map((inner) => {
      if (!isMediaCarrierCandidate(inner)) return inner as Part;
      const clamped = clampInlineMediaPart(inner);
      if (clamped !== inner) nestedTouched = true;
      return clamped;
    });
    if (!nestedTouched) return part;
    touched = true;
    const { parts: _oversized, ...rest } = functionResponse ?? {};
    return {
      ...part,
      functionResponse: {
        ...rest,
        parts: clampedInner,
      } as Part['functionResponse'],
    };
  });
  return touched ? mapped : parts;
}
