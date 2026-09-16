/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';

const INVOKE_PATTERN = /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/g;
const PARAMETER_PATTERN =
  /<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/g;

export interface ExtractedToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Detects whether text contains XML-style tool call patterns.
 */
export function containsXmlToolCalls(text: string): boolean {
  INVOKE_PATTERN.lastIndex = 0;
  return INVOKE_PATTERN.test(text);
}

/**
 * Decodes the five predefined XML entities in a parameter value so
 * recovered args match the literal text the model intended. Models
 * emitting this dialect commonly escape `<`/`&` inside code payloads;
 * without decoding, an `edit` old_string never matches the file and a
 * `write_file` content writes literal `&lt;` into the user's source.
 * `&amp;` is decoded last so `&amp;lt;` correctly becomes `&lt;`.
 */
function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Parses a raw parameter value. Only values that look like structured JSON
 * (objects or arrays) are parsed; scalar strings are preserved as-is to
 * avoid coercing e.g. a file named "null" or a string port "8080".
 */
function parseParameterValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * Strips a single newline immediately after the open tag and immediately
 * before the close tag — the convention this XML dialect follows — while
 * preserving the remaining whitespace that tools treat as significant (e.g.
 * the indentation that makes an `edit` old_string unique). A blanket trim
 * corrupted such arguments. See #8003.
 */
function stripDelimitingNewlines(value: string): string {
  let result = value;
  if (result.startsWith('\n')) {
    result = result.slice(1);
  }
  if (result.endsWith('\n')) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Precomputes the character ranges spanned by invoke blocks so fence
 * detection can skip their interiors. Without this, a fence-like line
 * inside a parameter value (e.g. an `edit` whose `old_string` contains
 * a triple-backtick line) opens a fence that is never closed, causing
 * later invoke blocks to be silently skipped.
 */
function computeInvokeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  INVOKE_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INVOKE_PATTERN.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

/**
 * Returns true when `index` falls inside an unclosed fenced code block.
 * Tracks delimiter type and length so a fence is only closed by a run of
 * the same delimiter that is at least as long as the opener, consistent
 * with CommonMark §4.5 (a shorter same-delimiter run is content, not a
 * close). A closing fence must also be whitespace-only after the delimiter
 * run — CommonMark forbids an info string on a closing fence.
 *
 * Lines inside `invokeRanges` are skipped: they are parameter values,
 * not prose, so fence-like content there must not affect fence state.
 */
function positionInsideFence(
  text: string,
  index: number,
  invokeRanges: Array<[number, number]>,
): boolean {
  let openFence: { delim: string; len: number } | null = null;
  let lineStart = 0;
  for (const line of text.slice(0, index).split('\n')) {
    const lineEnd = lineStart + line.length;
    const insideInvoke = invokeRanges.some(
      ([start, end]) => lineStart >= start && lineEnd <= end,
    );
    lineStart = lineEnd + 1;
    if (insideInvoke) continue;
    const m = /^ {0,3}((`{3,})|~{3,})/.exec(line);
    if (!m) continue;
    const delim = m[2] ? '`' : '~';
    const len = m[1].length;
    if (openFence === null) openFence = { delim, len };
    else if (
      openFence.delim === delim &&
      len >= openFence.len &&
      line.slice(m[0].length).trim() === ''
    )
      openFence = null;
  }
  return openFence !== null;
}

/**
 * Extracts XML-style tool calls from plain text content.
 * Invoke blocks inside fenced code blocks (``` or ~~~) are skipped:
 * they document the format rather than emitting a tool call. See #8003.
 * Returns an array of extracted tool calls, or an empty array if none found.
 */
export function extractXmlToolCalls(text: string): ExtractedToolCall[] {
  const results: ExtractedToolCall[] = [];
  const invokeRanges = computeInvokeRanges(text);

  // Reset lastIndex for global regex
  INVOKE_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = INVOKE_PATTERN.exec(text)) !== null) {
    if (positionInsideFence(text, match.index, invokeRanges)) {
      continue;
    }

    const toolName = match[1];
    const paramsBlock = match[2];

    const args: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    PARAMETER_PATTERN.lastIndex = 0;

    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = PARAMETER_PATTERN.exec(paramsBlock)) !== null) {
      const paramName = paramMatch[1];
      const paramValue = decodeXmlEntities(
        stripDelimitingNewlines(paramMatch[2]),
      );
      args[paramName] = parseParameterValue(paramValue);
    }

    if (toolName && Object.keys(args).length > 0) {
      results.push({ name: toolName, args });
    }
  }

  return results;
}

/**
 * Attempts to recover tool calls from XML-formatted text content.
 * If XML tool calls are found and dominate the content, returns
 * functionCall parts and the remaining text (with recovered XML
 * blocks removed). Parameterless invoke blocks are preserved as
 * plain text since extractXmlToolCalls intentionally skips them.
 */
export function tryRecoverXmlToolCalls(text: string): {
  recovered: boolean;
  functionCallParts: Part[];
  remainingText: string;
} {
  const extracted = extractXmlToolCalls(text);

  if (extracted.length === 0) {
    return { recovered: false, functionCallParts: [], remainingText: text };
  }

  // Intent guard: only recover when XML blocks dominate the content.
  // Substantial surrounding prose suggests the model is documenting or
  // echoing the format, not emitting a tool call. Measure against all
  // invoke blocks (including parameterless ones the extraction skips).
  INVOKE_PATTERN.lastIndex = 0;
  const proseOnly = text
    .replace(INVOKE_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > 0 && proseOnly.length / text.length > 0.8) {
    return { recovered: false, functionCallParts: [], remainingText: text };
  }

  const invokeRanges = computeInvokeRanges(text);

  // Strip only invoke blocks that contain parameters and are outside
  // fenced code blocks (the ones we actually recovered). Parameterless
  // and fenced blocks are preserved as plain text.
  INVOKE_PATTERN.lastIndex = 0;
  const remainingText = text
    .replace(
      INVOKE_PATTERN,
      (block, _name: string, _body: string, offset: number) => {
        if (positionInsideFence(text, offset, invokeRanges)) {
          return block;
        }
        PARAMETER_PATTERN.lastIndex = 0;
        return PARAMETER_PATTERN.test(block) ? '' : block;
      },
    )
    .replace(/<function_calls>\s*<\/function_calls>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const functionCallParts: Part[] = extracted.map((toolCall, index) => ({
    functionCall: {
      id: `xml-recovered-${index}-${Date.now()}`,
      name: toolCall.name,
      args: toolCall.args,
    },
  }));

  return { recovered: true, functionCallParts, remainingText };
}
