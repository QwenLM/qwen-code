/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import { Lexer, type Token } from 'marked';

const TOOL_CALL_PATTERN =
  /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>|<function=([^\s<>]+)>([\s\S]*?)<\/function>/g;
const PARAMETER_PATTERN =
  /<parameter(?:\s+name=["']([^"']+)["']|=([^\s<>]+))>([\s\S]*?)<\/parameter>/g;
// Parameter open tags. Scanned over a block body to detect a parameter that
// was never closed: PARAMETER_PATTERN then borrows the close tag of a later
// block, which leaves `outsideParameters` empty and slips past the guard.
const PARAM_OPEN_PATTERN = /<parameter(?:\s+name=["'][^"']*["']|=[^\s<>]+)?>/g;

export interface ExtractedToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface ToolCallBlock extends ExtractedToolCall {
  start: number;
  end: number;
}

/**
 * Detects whether text contains XML-style tool call patterns.
 */
export function containsXmlToolCalls(text: string): boolean {
  TOOL_CALL_PATTERN.lastIndex = 0;
  return TOOL_CALL_PATTERN.test(text);
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
 * Returns true when `index` falls inside an unclosed fenced code block.
 * Tracks delimiter type and length so a fence is only closed by a run of
 * the same delimiter that is at least as long as the opener, consistent
 * with CommonMark §4.5 (a shorter same-delimiter run is content, not a
 * close). A closing fence must also be whitespace-only after the delimiter
 * run — CommonMark forbids an info string on a closing fence.
 *
 * Lines inside `parameterRanges` are skipped: they are parameter values,
 * not prose, so fence-like content there must not affect fence state.
 */
function positionInsideFence(
  text: string,
  index: number,
  parameterRanges: Array<[number, number]>,
): boolean {
  let openFence: { delim: string; len: number } | null = null;
  let lineStart = 0;
  for (const line of text.slice(0, index).split('\n')) {
    const lineEnd = lineStart + line.length;
    const insideParameter = parameterRanges.some(
      ([start, end]) => lineStart >= start && lineStart < end,
    );
    lineStart = lineEnd + 1;
    if (insideParameter) continue;
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

function computeExampleRanges(
  text: string,
  parameterRanges: Array<[number, number]>,
): Array<[number, number]> {
  // marked's inline lexer is super-linear on unterminated link/emphasis runs
  // and nothing bounds the model's output length, so it is only worth running
  // when the text can actually produce an example range. The tag scan below
  // re-checks every candidate against `tagPositions`, so skipping the lexer
  // here can only yield "no ranges" — which is what an example-free text has.
  if (!text.includes('<example') && !text.includes('</example')) return [];

  const tagPositions = new Set<number>();
  function collectTags(tokens: Token[], raw: string, baseOffset: number) {
    let cursor = 0;
    for (const token of tokens) {
      const offset = raw.indexOf(token.raw, cursor);
      cursor = offset + token.raw.length;
      if (token.type === 'html' && /^<\/?example(?=[\s/>])/.test(token.raw)) {
        tagPositions.add(baseOffset + offset);
      }
      if ('tokens' in token && token.tokens) {
        collectTags(token.tokens, token.raw, baseOffset + offset);
      }
    }
  }
  const proseParts: string[] = [];
  let cursor = 0;
  for (const [start, end] of parameterRanges) {
    proseParts.push(
      text.slice(cursor, start),
      text.slice(start, end).replace(/[^\r\n]/g, ' '),
    );
    cursor = end;
  }
  proseParts.push(text.slice(cursor));
  const prose = proseParts.join('');
  try {
    collectTags(Lexer.lexInline(prose), prose, 0);
  } catch {
    // The regex-only implementation this replaced could not throw; a lexer
    // failure must degrade to "no example ranges", not abort the turn.
    tagPositions.clear();
  }

  const ranges: Array<[number, number]> = [];
  const tags = /<\/?example(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/g;
  let depth = 0;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(text)) !== null) {
    const tagPosition = match.index;
    if (
      !tagPositions.has(tagPosition) ||
      parameterRanges.some(
        ([start, end]) => tagPosition >= start && tagPosition < end,
      ) ||
      positionInsideFence(text, tagPosition, parameterRanges)
    ) {
      continue;
    }
    if (/\/\s*>$/.test(match[0])) continue;
    if (match[0].startsWith('</')) {
      if (depth > 0 && --depth === 0) {
        ranges.push([start, tagPosition + match[0].length]);
      }
    } else {
      if (depth === 0) start = tagPosition;
      depth += 1;
    }
  }
  if (depth > 0) ranges.push([start, text.length]);
  return ranges;
}

/**
 * Returns the offset just past the end of the open tag at the start of a
 * matched block, or -1 when the block holds no unquoted `>`.
 *
 * The invoke branch of TOOL_CALL_PATTERN admits `>` inside the quoted name, so
 * deriving the tag end with `indexOf('>')` can land in the middle of the open
 * tag. A rescan from there matches a complete call embedded in that name
 * attribute and dispatches it out of a block the guard has just rejected.
 * Tracking quote runs makes the tag end the first `>` outside a quoted run.
 */
function openTagEnd(block: string): number {
  let quote: string | null = null;
  for (let index = 0; index < block.length; index++) {
    const char = block[index];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index + 1;
    }
  }
  return -1;
}

/**
 * Extracts XML-style tool calls from plain text content.
 * Tool-call blocks inside fences or explicit example wrappers are skipped:
 * they document the format rather than emitting a tool call. See #8003.
 * Returns an array of extracted tool calls, or an empty array if none found.
 */
function recoverableToolCallBlocks(text: string): ToolCallBlock[] {
  const blocks: ToolCallBlock[] = [];
  // Parameter spans are a property of the raw text, not of which blocks the
  // guard accepts: they mask parameter data out of the prose handed to the
  // markdown lexer and out of fence tracking. Deriving them from accepted
  // blocks only left a rejected block's data unmasked, where a literal example
  // tag in it could swallow a later valid call.
  const parameterRanges: Array<[number, number]> = [];
  PARAMETER_PATTERN.lastIndex = 0;
  let rangeMatch: RegExpExecArray | null;
  while ((rangeMatch = PARAMETER_PATTERN.exec(text)) !== null) {
    parameterRanges.push([
      rangeMatch.index,
      rangeMatch.index + rangeMatch[0].length,
    ]);
  }

  TOOL_CALL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_CALL_PATTERN.exec(text)) !== null) {
    const toolName = match[1] ?? match[3];
    const paramsBlock = match[2] ?? match[4];
    // A rejected block may have swallowed a complete later block, so rescan
    // from just after this block's open tag instead of its borrowed close.
    // When the tag end is not derivable, skip the whole block: rescanning
    // inside a rejected block is what dispatches markup it never accepted.
    const tagEnd = openTagEnd(match[0]);
    const resumeAt =
      tagEnd === -1 ? match.index + match[0].length : match.index + tagEnd;
    PARAMETER_PATTERN.lastIndex = 0;
    const outsideParameters = paramsBlock.replace(PARAMETER_PATTERN, '');
    PARAM_OPEN_PATTERN.lastIndex = 0;
    // A missing close must not borrow a later block's parameters or recover
    // only the arguments preceding a prematurely matched function close. A
    // borrowed close leaves no residual tag for the second test to see, so
    // count the open tags the accepted matches did not close.
    if (
      /<\/?(?:function|invoke|parameter)(?:[\s=>]|$)/.test(outsideParameters) ||
      /^ {0,3}(?:`{3,}|~{3,})/m.test(outsideParameters) ||
      paramsBlock.match(PARAM_OPEN_PATTERN)?.length !==
        (outsideParameters.match(PARAM_OPEN_PATTERN)?.length ?? 0) +
          (paramsBlock.match(PARAMETER_PATTERN)?.length ?? 0)
    ) {
      TOOL_CALL_PATTERN.lastIndex = resumeAt;
      continue;
    }

    const args: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    PARAMETER_PATTERN.lastIndex = 0;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = PARAMETER_PATTERN.exec(paramsBlock)) !== null) {
      const paramName = paramMatch[1] ?? paramMatch[2];
      const paramValue = decodeXmlEntities(
        stripDelimitingNewlines(paramMatch[3]),
      );
      args[paramName] = parseParameterValue(paramValue);
    }

    if (toolName && Object.keys(args).length > 0) {
      blocks.push({
        name: toolName,
        args,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  const exampleRanges = computeExampleRanges(text, parameterRanges);
  return blocks.filter(
    ({ start, end }) =>
      !positionInsideFence(text, start, parameterRanges) &&
      !positionInsideFence(text, end - 1, parameterRanges) &&
      !exampleRanges.some(
        ([exampleStart, exampleEnd]) =>
          (start >= exampleStart && start < exampleEnd) ||
          (end - 1 >= exampleStart && end - 1 < exampleEnd),
      ),
  );
}

export function extractXmlToolCalls(text: string): ExtractedToolCall[] {
  return recoverableToolCallBlocks(text).map(({ name, args }) => ({
    name,
    args,
  }));
}

/**
 * Attempts to recover tool calls from XML-formatted text content.
 * If XML tool calls are found and dominate the content, returns
 * functionCall parts and the remaining text (with recovered XML
 * blocks removed). Parameterless tool-call blocks are preserved as
 * plain text since extractXmlToolCalls intentionally skips them.
 */
export function tryRecoverXmlToolCalls(text: string): {
  recovered: boolean;
  functionCallParts: Part[];
  remainingText: string;
} {
  const extracted = recoverableToolCallBlocks(text);

  if (extracted.length === 0) {
    return { recovered: false, functionCallParts: [], remainingText: text };
  }

  // Intent guard: only recover when XML blocks dominate the content.
  // Substantial surrounding prose suggests the model is documenting or
  // echoing the format, not emitting a tool call. Measure against all
  // tool-call blocks (including parameterless ones the extraction skips).
  TOOL_CALL_PATTERN.lastIndex = 0;
  const proseOnly = text
    .replace(TOOL_CALL_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > 0 && proseOnly.length / text.length > 0.8) {
    return { recovered: false, functionCallParts: [], remainingText: text };
  }

  const removedRanges = extracted.map(
    ({ start, end }) => [start, end] as const,
  );
  let withoutRecoveredCalls = '';
  let cursor = 0;
  for (const [start, end] of removedRanges) {
    withoutRecoveredCalls += text.slice(cursor, start);
    cursor = end;
  }
  withoutRecoveredCalls += text.slice(cursor);
  const remainingText = withoutRecoveredCalls
    .replace(
      /<tool_call>\s*<\/tool_call>|<function_calls>\s*<\/function_calls>/g,
      (wrapper, offset: number) => {
        // Map back before stripping calls so originally empty examples survive.
        let originalOffset = offset;
        for (const [start, end] of removedRanges) {
          if (start > originalOffset) break;
          originalOffset += end - start;
        }
        return text.slice(originalOffset, originalOffset + wrapper.length) ===
          wrapper
          ? wrapper
          : '';
      },
    )
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
