/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Extract JSON from LLM response text that may be wrapped in markdown
 * code fences, preceded by explanatory prose, or followed by comments.
 *
 * Three-level priority strategy (ported from the Go implementation's `extractPromptJSON`):
 * 1. Find ` ```json ... ``` ` code block → extract content
 * 2. Find ` ``` ... ``` ` generic code block → extract if starts with `{` or `[`
 * 3. Find first `{` or `[` → extract to matching balanced closer
 *
 * Returns the extracted JSON string, or the original text if no JSON found.
 */

/**
 * Extract a JSON string from text that may contain markdown fences or prose.
 *
 * @param text - The raw LLM response text.
 * @returns The extracted JSON string, or the original text if no JSON detected.
 */
export function extractJsonFromText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;

  const jsonFenceResult = extractFromJsonFence(trimmed);
  if (jsonFenceResult !== null) return jsonFenceResult;

  const genericFenceResult = extractFromGenericFence(trimmed);
  if (genericFenceResult !== null) return genericFenceResult;

  const bracketResult = extractFromBrackets(trimmed);
  if (bracketResult !== null) return bracketResult;

  return text;
}

function extractFromJsonFence(text: string): string | null {
  const marker = '```json';
  const idx = text.indexOf(marker);
  if (idx === -1) return null;

  const contentStart = idx + marker.length;
  const endIdx = text.indexOf('```', contentStart);
  if (endIdx === -1) {
    return text.slice(contentStart).trim();
  }
  return text.slice(contentStart, endIdx).trim();
}

function extractFromGenericFence(text: string): string | null {
  const marker = '```';
  const idx = text.indexOf(marker);
  if (idx === -1) return null;

  let contentStart = idx + marker.length;
  // Skip optional language tag on the same line
  const newlineAfterFence = text.indexOf('\n', contentStart);
  if (newlineAfterFence !== -1) {
    contentStart = newlineAfterFence + 1;
  }

  const endIdx = text.indexOf('```', contentStart);
  const content =
    endIdx === -1
      ? text.slice(contentStart).trim()
      : text.slice(contentStart, endIdx).trim();

  if (content.startsWith('{') || content.startsWith('[')) {
    return content;
  }
  return null;
}

/**
 * Find the first `{` or `[` in `text` and extract to its balanced closer,
 * tracking string/escape state to handle nested structures correctly.
 */
function extractFromBrackets(text: string): string | null {
  const startIdx = text.search(/[{[]/);
  if (startIdx === -1) return null;

  const opener = text[startIdx];
  const closer = opener === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (inString) {
      if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === opener) {
      depth++;
    } else if (ch === closer) {
      depth--;
      if (depth === 0) {
        return text.slice(startIdx, i + 1);
      }
    }
  }

  // Unbalanced — return from start to end (truncated JSON, let caller handle)
  return text.slice(startIdx);
}
