/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Best-effort JSON-object extraction from a model's text response. Used as a
 * fallback when the model emits plain-text JSON instead of calling the
 * registered tool. Strips a leading ```json / ``` fence, then takes the
 * substring from the first `{` to the matching last `}` and JSON-parses it.
 * Returns the parsed object on success, or `null` if nothing usable is found.
 */
export function parseLooseJsonObject(
  text: string,
): Record<string, unknown> | null {
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  }
  const firstStructuredChar = s.search(/[[{]/);
  if (firstStructuredChar !== -1 && s[firstStructuredChar] === '[') {
    return null;
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    const parsed = JSON.parse(s.slice(first, last + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
