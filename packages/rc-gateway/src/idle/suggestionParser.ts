/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Parse options. */
export interface ParseSuggestionsOptions {
  /** Max suggestions returned (default 3). */
  max?: number;
  /** Max chars per suggestion before ellipsis truncation (default 80). */
  maxLen?: number;
}

function coerce(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Parse a model reply into a clean list of suggestion strings. TOTAL and
 * never-throws — ANY malformed reply yields `[]` (spec I5: "bad model response
 * is dropped", no UI breakage, no transcript pollution). Handles the realistic
 * failure modes:
 *
 *  - a ```json fenced ``` block (the fence is stripped first);
 *  - a prose preamble before the array ("Here are some suggestions: [...]") via
 *    a bracket-span fallback ONLY after a whole-string parse fails;
 *  - a JSON OBJECT instead of an array → `[]` (a whole-string parse yields a
 *    non-array, so we never surprise-extract an inner array from an object);
 *  - non-string array elements → skipped;
 *  - an empty array / truncated-or-unterminated JSON / non-string input → `[]`.
 *
 * Survivors are whitespace-collapsed, trimmed, empty-dropped, capped at `max`,
 * and ellipsis-truncated at `maxLen`.
 */
export function parseSuggestions(
  raw: unknown,
  opts: ParseSuggestionsOptions = {},
): string[] {
  const max = opts.max ?? 3;
  const maxLen = opts.maxLen ?? 80;
  if (typeof raw !== 'string') return [];

  let s = raw.trim();
  // Strip a ```json ... ``` / ``` ... ``` fence if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // Primary: parse the whole string. An array is accepted; an object (or any
  // non-array) is NOT — so `{"suggestions":[...]}` deliberately drops to [].
  let parsed = coerce(s);
  // Fallback for a prose preamble around the array: only when the whole-string
  // parse failed (so a valid non-array object is never bracket-mined).
  if (parsed === undefined) {
    const lb = s.indexOf('[');
    const rb = s.lastIndexOf(']');
    if (lb !== -1 && rb > lb) parsed = coerce(s.slice(lb, rb + 1));
  }
  if (!Array.isArray(parsed)) return [];

  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const t = item.trim().replace(/\s+/g, ' ');
    if (!t) continue;
    out.push(t.length > maxLen ? t.slice(0, maxLen - 1) + '…' : t);
    if (out.length >= max) break;
  }
  return out;
}
