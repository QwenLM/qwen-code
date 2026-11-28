/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Canonical MIME aliases for common non-standard audio MIME types produced by
 * OS file detectors or browsers (e.g. `audio/x-wav`, `audio/x-flac`). Shared
 * across Gemini, OpenAI Chat Completions, and OpenAI Responses converters so
 * alias tables stay in lockstep.
 */
export const AUDIO_MIME_ALIASES: Readonly<Record<string, string>> = {
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/x-mp3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/mpeg3': 'audio/mpeg',
  'audio/x-ogg': 'audio/ogg',
  'audio/x-flac': 'audio/flac',
  'audio/x-aac': 'audio/aac',
  'audio/x-m4a': 'audio/m4a',
};

export type AudioWireFormat =
  | 'wav'
  | 'mp3'
  | 'aac'
  | 'flac'
  | 'ogg'
  | 'm4a'
  | 'webm';

const CANONICAL_AUDIO_MIME_TO_FORMAT: Readonly<
  Record<string, AudioWireFormat>
> = {
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/webm': 'webm',
};

/**
 * Strip optional MIME parameters (`;codecs=...`, `;charset=...`), trim,
 * lowercase, and canonicalize known audio MIME aliases. Non-string runtime
 * inputs (e.g. `null` from persisted history) return `undefined`.
 */
export function normalizeMediaMimeType(
  mimeType: string | undefined,
): string | undefined {
  if (typeof mimeType !== 'string') {
    return undefined;
  }
  const semicolonIndex = mimeType.indexOf(';');
  const baseType =
    semicolonIndex >= 0 ? mimeType.slice(0, semicolonIndex) : mimeType;
  const normalized = baseType.trim().toLowerCase();
  return Object.hasOwn(AUDIO_MIME_ALIASES, normalized)
    ? AUDIO_MIME_ALIASES[normalized]
    : normalized;
}

/**
 * Resolve a raw audio MIME type (including parameters and aliases such as
 * `audio/x-wav; codecs=1`) into its canonical MIME type and wire format token.
 * Uses `Object.hasOwn` to avoid prototype-chain lookups.
 */
export function resolveAudioMimeAndFormat(
  mimeType: string | undefined,
): { mimeType: string; format: AudioWireFormat } | undefined {
  const canonical = normalizeMediaMimeType(mimeType);
  if (!canonical || !Object.hasOwn(CANONICAL_AUDIO_MIME_TO_FORMAT, canonical)) {
    return undefined;
  }
  return {
    mimeType: canonical,
    format: CANONICAL_AUDIO_MIME_TO_FORMAT[canonical],
  };
}

/**
 * Strip a leading `data:<mime>[;params];base64,` (or RFC 2397 empty-MIME
 * `data:;base64,`) prefix if present, returning raw base64 payload bytes.
 */
export function stripBase64DataUriPrefix(data: string): string {
  return data.replace(/^data:[^,]*;base64,/i, '');
}
