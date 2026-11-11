/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tool name sanitization for the API's naming constraints.
 *
 * Provides a bidirectional mapping between original tool names (which may
 * contain characters invalid for the wire format) and their sanitized forms.
 * Module-level Maps are shared across callers so names sanitized during
 * request building can be looked up during stream parsing. Collisions are
 * rare given the 6-char base36 hash suffix, but when two distinct originals
 * map to the same wire name — including the case where a previously hashed
 * form coincides with a later raw name — an incrementing counter on the
 * hash branch disambiguates.
 */

/** Wire-format hard upper bound for tool names (OpenAI / Anthropic / Gemini). */
const MAX_TOOL_NAME_LENGTH = 64;
/** Base36 hash suffix length. */
const HASH_SUFFIX_LENGTH = 6;

/** original → sanitized (forward cache) */
const forwardMapping: Map<string, string> = new Map();
/** sanitized → original (reverse lookup for stream parsing) */
const reverseMapping: Map<string, string> = new Map();

/**
 * Sanitize a tool/function name for the wire-format naming constraints
 * shared by OpenAI / Anthropic / Gemini: `^[a-zA-Z0-9_-]{1,64}$`.
 * Replaces any character outside that set with '_', truncates to 64 chars,
 * and appends a short hash suffix if the name had to be modified.
 */
export function sanitizeToolName(name: string): string {
  const cached = forwardMapping.get(name);
  if (cached !== undefined) return cached;

  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');

  if (sanitized === name && sanitized.length <= MAX_TOOL_NAME_LENGTH) {
    // Identity-pass only when the slot is free or already owned by this same
    // name. If a previously hashed form happens to equal this raw name, fall
    // through to the hash branch so the counter tiebreaker can disambiguate
    // instead of silently clobbering the prior reverse mapping.
    const owner = reverseMapping.get(sanitized);
    if (owner === undefined || owner === name) {
      forwardMapping.set(name, sanitized);
      reverseMapping.set(sanitized, name);
      return sanitized;
    }
  }

  // djb2-variant hash: `| 0` keeps arithmetic in 32-bit signed integer range.
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  // Pad short hashes; for long ones keep the low-order base36 digits.
  const raw = Math.abs(hash).toString(36);
  const hashSuffix =
    raw.length >= HASH_SUFFIX_LENGTH
      ? raw.slice(-HASH_SUFFIX_LENGTH)
      : raw.padStart(HASH_SUFFIX_LENGTH, '0');
  const suffix = '_' + hashSuffix;
  const maxBase = MAX_TOOL_NAME_LENGTH - suffix.length;
  let result = sanitized.slice(0, maxBase) + suffix;

  // Tiebreaker for the rare case where two distinct originals produce the
  // same sanitized form. The counter eats into the base budget.
  let counter = 1;
  let existing = reverseMapping.get(result);
  while (existing !== undefined && existing !== name) {
    const tail = String(counter);
    const base = MAX_TOOL_NAME_LENGTH - suffix.length - tail.length;
    result = sanitized.slice(0, base) + suffix + tail;
    counter++;
    existing = reverseMapping.get(result);
  }

  forwardMapping.set(name, result);
  reverseMapping.set(result, name);
  return result;
}

/**
 * Reverse lookup: get the original tool name from a sanitized one.
 * Returns the input unchanged if no mapping exists.
 */
export function getOriginalToolName(sanitized: string): string {
  return reverseMapping.get(sanitized) ?? sanitized;
}
