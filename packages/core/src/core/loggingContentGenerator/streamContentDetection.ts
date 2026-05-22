/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponse } from '@google/genai';

/**
 * Detects whether a streaming chunk contains user-visible model output.
 *
 * Used by the LoggingContentGenerator stream wrapper to identify the first
 * chunk that should trigger TTFT (time-to-first-token) measurement.
 *
 * A chunk is "user-visible" if any normalized Part in candidates[0].content.parts
 * is one of:
 *   - text with a non-empty string
 *   - functionCall (tool use — even tool-call-only responses count)
 *   - inlineData (image, binary blob)
 *   - executableCode (sandbox / code-execution responses)
 *   - thought / reasoning content (provider-dependent; o1, qwen thinking, Anthropic <thinking>)
 *
 * Chunks containing only role metadata, only usageMetadata (final summary
 * chunk), or empty parts are NOT user-visible — TTFT should not fire on these.
 *
 * Centralised here (single predicate over the normalized GenerateContentResponse
 * shape) so the four provider generators (Anthropic / OpenAI / Gemini / Qwen)
 * don't each need their own first-token logic. Each provider already normalizes
 * its native chunk shape to GenerateContentResponse before LoggingContentGenerator
 * sees it (see loggingContentGenerator.ts generateContentStream).
 */
export function hasUserVisibleContent(chunk: GenerateContentResponse): boolean {
  const parts = chunk.candidates?.[0]?.content?.parts;
  if (!parts || parts.length === 0) return false;
  return parts.some(isUserVisiblePart);
}

function isUserVisiblePart(part: unknown): boolean {
  if (part === null || typeof part !== 'object') return false;
  const p = part as {
    text?: unknown;
    functionCall?: unknown;
    inlineData?: unknown;
    executableCode?: unknown;
    thought?: unknown;
  };
  if (typeof p.text === 'string' && p.text.length > 0) return true;
  if (p.functionCall !== undefined) return true;
  if (p.inlineData !== undefined) return true;
  if (p.executableCode !== undefined) return true;
  // `thought` is a boolean flag in this codebase — `true` means the part
  // carries reasoning content, false / absent means none (see loggingContentGenerator.ts
  // where `part.thought ? {...} : {}` is the canonical pattern). Match strict `=== true`
  // rather than checking presence — `thought: false` parts are explicitly NOT user-visible.
  if (p.thought === true) return true;
  return false;
}
