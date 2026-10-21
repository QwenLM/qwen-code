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

// marked's inline lexer is quadratic on unterminated emphasis runs and
// nothing upstream bounds a model turn's length: measured on this build, a
// `'*a '.repeat(n)` run after one example marker costs 238ms at 2k units,
// 794ms at 4k, 3.0s at 8k and 11.7s at 16k (~64KB) — a synchronous stall
// inside a streaming turn. Past this size the lexer pass is skipped and
// example detection degrades to the regex-only tag scan.
const MAX_LEXER_SCAN_LENGTH = 64 * 1024;

export interface ExtractedToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface ToolCallBlock extends ExtractedToolCall {
  start: number;
  end: number;
  parameterSpans: Array<[number, number]>;
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

function rangeContains(
  ranges: ReadonlyArray<readonly [number, number]>,
  index: number,
): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/**
 * Returns `text` between `from` and `to` with `ranges` removed. The ranges
 * must be sorted by start; an overlap is trimmed, not double-counted.
 */
function textOutside(
  text: string,
  ranges: ReadonlyArray<readonly [number, number]>,
  from = 0,
  to = text.length,
): string {
  let result = '';
  let cursor = from;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    if (start > cursor) result += text.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  return result + text.slice(cursor, to);
}

/**
 * Returns true when `index` falls inside an unclosed fenced code block.
 * Tracks delimiter type and length so a fence is only closed by a run of
 * the same delimiter that is at least as long as the opener, consistent
 * with CommonMark §4.5 (a shorter same-delimiter run is content, not a
 * close). A closing fence must also be whitespace-only after the delimiter
 * run — CommonMark forbids an info string on a closing fence.
 *
 * Parameter data is skipped; only prose can open or close its fences.
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
    const startsInsideParameter = rangeContains(parameterRanges, lineStart);
    lineStart = lineEnd + 1;
    const m = /^ {0,3}((`{3,})|~{3,})/.exec(line);
    if (!m) continue;
    const delim = m[2] ? '`' : '~';
    const len = m[1].length;
    const closes =
      openFence !== null &&
      openFence.delim === delim &&
      len >= openFence.len &&
      line.slice(m[0].length).trim() === '';
    if (startsInsideParameter) continue;
    if (openFence === null) {
      openFence = { delim, len };
    } else if (closes) {
      openFence = null;
    }
  }
  return openFence !== null;
}

function exampleTagPositions(
  text: string,
  parameterRanges: Array<[number, number]>,
): Set<number> | null {
  // marked's inline lexer is super-linear on unterminated link/emphasis runs
  // and nothing bounds the model's output length, so it is only worth running
  // when the text can actually produce an example range. The caller's tag scan
  // re-checks every candidate against `tagPositions`, so skipping the lexer
  // here can only yield "no ranges" — which is what an example-free text has.
  if (!text.includes('<example') && !text.includes('</example'))
    return new Set();

  // Over the cap the lexer is skipped and every regex-matched tag is taken at
  // face value, which is the regex-only behaviour this replaced.
  if (text.length > MAX_LEXER_SCAN_LENGTH) return null;
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
    // Preserve example filtering with the same fallback as oversized text.
    return null;
  }
  return tagPositions;
}

function computeExampleRanges(
  text: string,
  parameterRanges: Array<[number, number]>,
  tagPositions: Set<number> | null,
  quotedValueRanges: Array<[number, number]>,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let ambiguousFrom = -1;
  const tags = /<\/?example(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/g;
  let depth = 0;
  let start = 0;
  let quotedIndex = 0;
  // Earlier documentation masks affect later values' context, so merge their
  // start events into this tag scan instead of classifying them all up front.
  function maskValuesBefore(index: number) {
    while (quotedIndex < quotedValueRanges.length) {
      const span = quotedValueRanges[quotedIndex];
      if (span[0] > index) break;
      if (depth > 0 || positionInsideFence(text, span[0], parameterRanges)) {
        if (
          depth > 0 &&
          /<\/?example(?=[\s/>])/.test(text.slice(span[0], span[1]))
        ) {
          // A value inside a documentation region carries an example tag:
          // whether the tag is data or structure cannot be resolved. Treat
          // everything from the open example up to the last tag that could
          // close it as documentation — the resolution that widens the mask —
          // so the ambiguous region stays inert without swallowing the calls
          // that follow the documentation.
          if (ambiguousFrom === -1) ambiguousFrom = start;
        }
        parameterRanges.push(span);
      }
      quotedIndex++;
    }
  }
  let match: RegExpExecArray | null;
  while ((match = tags.exec(text)) !== null) {
    const tagPosition = match.index;
    maskValuesBefore(tagPosition);
    const closes = match[0].startsWith('</');
    if (
      rangeContains(parameterRanges, tagPosition) ||
      (tagPositions !== null && !tagPositions.has(tagPosition))
    ) {
      continue;
    }
    if (positionInsideFence(text, tagPosition, parameterRanges)) continue;
    if (/\/\s*>$/.test(match[0])) continue;
    if (closes) {
      if (depth > 0 && --depth === 0) {
        ranges.push([start, tagPosition + match[0].length]);
      }
    } else {
      if (depth === 0) start = tagPosition;
      depth += 1;
    }
  }
  maskValuesBefore(text.length);
  if (depth > 0) ranges.push([start, text.length]);
  if (ambiguousFrom !== -1) {
    let ambiguousEnd = text.length;
    const closers = /<\/example(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/g;
    let closer: RegExpExecArray | null;
    while ((closer = closers.exec(text)) !== null) {
      if (
        closer.index > ambiguousFrom &&
        !rangeContains(quotedValueRanges, closer.index) &&
        !rangeContains(parameterRanges, closer.index) &&
        (tagPositions === null || tagPositions.has(closer.index)) &&
        !positionInsideFence(text, closer.index, parameterRanges) &&
        !/\/\s*>$/.test(closer[0])
      ) {
        ambiguousEnd = closer.index + closer[0].length;
      }
    }
    ranges.push([ambiguousFrom, ambiguousEnd]);
  }
  return ranges;
}

/**
 * Returns the offset just past the end of the open tag at the start of a
 * matched block, or -1 when the block holds no unquoted `>`.
 *
 * Quote pairs determine the actual boundary. Compare it with the flat
 * matcher's boundary before trusting a matched call's attributes.
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

// Matches a parameter open or close tag. Quoted runs are admitted whole so a
// `>` inside an attribute value does not end the tag early.
const PARAMETER_TAG_PATTERN =
  /<\/?parameter(?=[\s=>])(?:[^>"']|"[^"]*"|'[^']*')*>/g;

// A parameter opener the strict grammar can validate, matched at a fixed
// offset. PARAMETER_PATTERN is looser and also admits mixed quote characters.
const PARAMETER_OPEN_TAG_PATTERN =
  /<parameter(?:\s+name=(["'])[^"']+\1|=[^\s<>"']+)>/y;

/**
 * Returns the value of a complete parameter element the strict grammar
 * validates, or null when the element is malformed or truncated. The flat
 * grammar admits mixed quote characters in a name, where the value boundary
 * cannot be trusted.
 */
function parameterValue(element: string): string | null {
  PARAMETER_OPEN_TAG_PATTERN.lastIndex = 0;
  if (
    !PARAMETER_OPEN_TAG_PATTERN.test(element) ||
    !element.endsWith('</parameter>')
  ) {
    return null;
  }
  return element.slice(openTagEnd(element), -'</parameter>'.length);
}

function hasBalancedQuotedCalls(value: string): boolean {
  const tags =
    /<invoke\s+name=["'][^"']+["']>|<function=[^\s<>]+>|<\/(invoke|function)>/g;
  const stack: string[] = [];
  let hasCall = false;
  let tag: RegExpExecArray | null;
  while ((tag = tags.exec(value)) !== null) {
    if (tag[1]) {
      if (stack.pop() !== tag[1]) return false;
      hasCall = true;
    } else {
      stack.push(tag[0].startsWith('<invoke') ? 'invoke' : 'function');
    }
  }
  return hasCall && stack.length === 0;
}

/**
 * Returns the spans of the parameter elements whose open tag is paired with a
 * later close tag, matched by depth.
 *
 * PARAMETER_PATTERN is flat and lazy, so an element nested inside a value
 * consumes that value's own terminator: over a content value quoting a whole
 * call, the flat match stops at the quoted call's parameter close and reports
 * the quoting value as unclosed. Pairing by depth gives the quoting value the
 * span it actually owns, which is what separates "a call the truncated block
 * swallowed" from "a call a value quotes" — the two have the same text shape
 * and differ only in whether a value owns the region.
 *
 * An open tag that is never closed stays on the stack and owns nothing, so a
 * value merely mentioning the tag shape does not make the region behind it
 * unrescannable.
 */
function closedParameterSpans(
  text: string,
): [Array<[number, number]>, number[]] {
  const spans: Array<[number, number]> = [];
  const openStarts: number[] = [];
  PARAMETER_TAG_PATTERN.lastIndex = 0;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = PARAMETER_TAG_PATTERN.exec(text)) !== null) {
    if (tagMatch[0].startsWith('</')) {
      const start = openStarts.pop();
      if (start !== undefined) {
        spans.push([start, tagMatch.index + tagMatch[0].length]);
      }
    } else {
      openStarts.push(tagMatch.index);
    }
  }
  // Whatever is left on the stack is an element the stream never closed. Its
  // interior is still value data, so the comment scan must treat it as opaque
  // exactly like a closed span; without it a `<!--` in a truncated value opens
  // a comment region that runs to end of turn and vetoes genuine siblings.
  return [spans, openStarts];
}

/**
 * Offsets of call openers the stream never closed, matched by depth.
 *
 * An unclosed parameter opener is only evidence of a truncated value when a
 * call opener the stream never closed precedes it. A prose mention of the tag
 * shape is unclosed too, and counting it would treat the whole remainder of
 * the turn as value data.
 */
function unclosedCallOpenerOffsets(text: string): number[] {
  const tags =
    /<invoke\s+name=["'][^"']+["']>|<function=[^\s<>]+>|<\/(invoke|function)>/g;
  const open: number[] = [];
  let tag: RegExpExecArray | null;
  while ((tag = tags.exec(text)) !== null) {
    if (tag[0][1] === '/') open.pop();
    else open.push(tag.index);
  }
  return open;
}

/**
 * Documentation regions the fence and `<example>` guards cannot see: HTML
 * comments and CommonMark indented code blocks. A call there is shown to the
 * model, not emitted by it, so it must not dispatch. See #13492.
 *
 * Comments only open at the start of a line outside a fence, so a prose
 * mention of the sequence stays prose and an opener a value owns is data —
 * whether or not the stream ever closed that value. Indented code cannot
 * interrupt a paragraph or a list item, so it starts only after a blank line
 * and, inside a list item, only past that item's content column.
 */
function hiddenDocumentationRanges(
  text: string,
  valueSpans: ReadonlyArray<readonly [number, number]>,
  parameterRanges: Array<[number, number]>,
  unclosedParameterStarts: readonly number[],
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let lineStart = 0;
  let commentStart = -1;
  let inComment = false;
  let previousBlank = true;
  let inIndentedCode = false;
  let listContentIndent = -1;
  for (const line of text.split('\n')) {
    const blank = line.trim() === '';
    const indent = line.length - line.trimStart().length;
    // No terminator search on the continuation lines: the opener scan below
    // already walked every `-->` in the remainder and found none outside a
    // value, so a terminator here is necessarily value data. An unterminated
    // region runs to end of turn, pushed once after the loop.
    if (!inComment) {
      const listItem = /^( {0,3})(?:[-*+]|\d{1,9}[.)])(\s+)/.exec(line);
      if (listItem) {
        const markerEnd = listItem[0].length - listItem[2].length;
        listContentIndent =
          markerEnd + (listItem[2].length >= 5 ? 1 : listItem[2].length);
      } else if (!blank && indent < listContentIndent) {
        listContentIndent = -1;
      }
      const open = /^ {0,3}<!--/.exec(line);
      const openerStart = open ? lineStart + open[0].length - 4 : -1;
      if (
        open &&
        !rangeContains(valueSpans, openerStart) &&
        !positionInsideFence(text, openerStart, parameterRanges)
      ) {
        // The scan starts at the opener itself so the abrupt-close forms
        // `<!-->` and `<!--->` — complete empty comments, whose terminator
        // overlaps the opener — close here instead of masking the whole
        // remainder of the turn. A terminator inside a value is data, not the
        // end of the comment.
        let close = text.indexOf('-->', openerStart);
        while (close !== -1 && rangeContains(valueSpans, close)) {
          close = text.indexOf('-->', close + 3);
        }
        if (close !== -1) {
          ranges.push([openerStart, close + 3]);
        } else if (
          // Unterminated, the region runs to end of turn. When the opener sits
          // in a value the stream never closed, that value is data, and
          // masking the remainder would veto genuine siblings in exactly the
          // truncated streams this fallback exists for. A terminated comment
          // stays masked whichever value owns it.
          !unclosedParameterStarts.some((start) => start <= openerStart)
        ) {
          inComment = true;
          commentStart = openerStart;
        }
      } else if (
        /^(?: {4,}|\t)\S/.test(line) &&
        (inIndentedCode || previousBlank) &&
        // A list item's lazy continuation is indented below its content column
        // + 4, which makes it a paragraph rather than an indented code block.
        (listContentIndent < 0 ||
          /^\t/.test(line) ||
          indent >= listContentIndent + 4)
      ) {
        ranges.push([lineStart, lineStart + line.length]);
        inIndentedCode = true;
      } else if (!blank) {
        inIndentedCode = false;
      }
    }
    previousBlank = blank;
    lineStart += line.length + 1;
  }
  if (inComment) ranges.push([commentStart, text.length]);
  return ranges;
}

/**
 * Extracts XML-style tool calls from plain text content.
 * Tool-call blocks inside fences, explicit example wrappers, HTML comments or
 * indented code blocks are skipped: they document the format rather than
 * emitting a tool call. See #8003.
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
  // Regions a closed parameter value owns, outermost only. A call matched
  // inside one is markup the value quotes rather than a call the model
  // emitted, so it must not be dispatched; the flat match of a block quoting
  // such a value also ends inside one, so the value is what tells the scan
  // where that block really ends. See #13492.
  const [closedSpans, unclosedParameterStarts] = closedParameterSpans(text);
  const valueSpans: Array<[number, number]> = [];
  let valueEnd = 0;
  for (const span of closedSpans.sort(
    ([startA], [startB]) => startA - startB,
  )) {
    if (span[0] < valueEnd) continue;
    valueEnd = span[1];
    valueSpans.push(span);
  }
  // A value the strict grammar can delimit owns its complete extent, so the
  // block's arguments are read from that span instead of the flat match.
  const ownedValueRanges: Array<[number, number]> = [];
  const quotedValueRanges: Array<[number, number]> = [];
  for (const [start, end] of valueSpans) {
    const value = parameterValue(text.slice(start, end));
    if (value === null) continue;
    ownedValueRanges.push([start, end]);
    if (hasBalancedQuotedCalls(value)) quotedValueRanges.push([start, end]);
  }
  const unclosedCallStarts = unclosedCallOpenerOffsets(text);
  const hiddenDocs = hiddenDocumentationRanges(
    text,
    valueSpans,
    parameterRanges,
    // Containment, not precedence: an unclosed parameter opener only marks
    // the region behind it as value data when a call opener the stream never
    // closed precedes it. A prose mention of the tag shape is unclosed too,
    // and letting it stand disables the comment mask for the whole remainder.
    unclosedParameterStarts.filter((start) =>
      unclosedCallStarts.some((callStart) => callStart < start),
    ),
  );
  const tagPositions = exampleTagPositions(text, parameterRanges);
  const exampleRanges = computeExampleRanges(
    text,
    parameterRanges,
    tagPositions,
    quotedValueRanges,
  );

  TOOL_CALL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_CALL_PATTERN.exec(text)) !== null) {
    const matchStart = match.index;
    if (
      valueSpans.some(([start, end]) => matchStart >= start && matchStart < end)
    ) {
      continue;
    }
    const toolName = match[1] ?? match[3];
    const closeTag = match[1] !== undefined ? '</invoke>' : '</function>';
    // `match[0]` is exactly openTag + body + closeTag, so the body length is
    // what separates this block's open tag from its parameters. Deriving the
    // split location by scanning instead returns an offset inside the body
    // whenever the name attribute opens with one quote character and closes
    // with the other — the name group's delimiters are independent classes —
    // which silently drops every parameter before that offset.
    let closeStart = match.index + match[0].length - closeTag.length;
    const lazyCloseStart = closeStart;
    const paramsStart = lazyCloseStart - (match[2] ?? match[4]).length;
    const openTagEndOffset = openTagEnd(match[0]);
    if (openTagEndOffset !== paramsStart - matchStart) {
      // Only this block's boundary is untrustworthy: a quote run in the name
      // leaves no unquoted `>`, or quote pairs put the flat boundary inside an
      // attribute. Reject the block and resume past its open tag rather than
      // costing the turn; resuming at or before `matchStart` would spin the
      // `/g` scan, so fall back to the match end.
      TOOL_CALL_PATTERN.lastIndex =
        openTagEndOffset === -1
          ? match.index + match[0].length
          : match.index + openTagEndOffset;
      continue;
    }
    // A value the block quotes a call in owns the flat close that landed
    // inside it; the block's own closer is the first one past that value. The
    // spans are sorted and disjoint and `closeStart` only moves forward.
    for (const [start, end] of quotedValueRanges) {
      if (end <= closeStart) continue;
      if (start > closeStart) break;
      closeStart = text.indexOf(closeTag, end);
      if (closeStart === -1) break;
    }
    if (closeStart === -1) {
      TOOL_CALL_PATTERN.lastIndex = paramsStart;
      continue;
    }
    const paramsBlock = text.slice(paramsStart, closeStart);
    const blockEnd = closeStart + closeTag.length;
    TOOL_CALL_PATTERN.lastIndex = blockEnd;

    const args: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    let outsideParameters = '';
    let cursor = 0;
    // Text-coordinate spans of the parameter elements this block consumed.
    const parameterSpans: Array<[number, number]> = [];
    // Only the values this block's own scan consumed may be excised from
    // `unquotedParameters`: excising a value that merely lies inside the block
    // hides a call opener the flat scan dispatched verbatim inside an argument.
    const consumedValueSpans: Array<[number, number]> = [];
    let duplicateParameter = false;
    PARAMETER_PATTERN.lastIndex = 0;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = PARAMETER_PATTERN.exec(paramsBlock)) !== null) {
      const parameterStart = paramsStart + paramMatch.index;
      const owned = ownedValueRanges.find(
        ([start, end]) => start === parameterStart && end <= closeStart,
      );
      let value = paramMatch[3];
      let parameterEnd = paramMatch.index + paramMatch[0].length;
      if (owned) {
        consumedValueSpans.push(owned);
        parameterEnd = owned[1] - paramsStart;
        value = paramsBlock.slice(
          paramMatch.index + openTagEnd(paramMatch[0]),
          parameterEnd - '</parameter>'.length,
        );
        PARAMETER_PATTERN.lastIndex = parameterEnd;
      }
      outsideParameters += paramsBlock.slice(cursor, paramMatch.index);
      cursor = parameterEnd;
      parameterSpans.push([parameterStart, paramsStart + parameterEnd]);
      const paramName = paramMatch[1] ?? paramMatch[2];
      // A second element with the same name would silently overwrite the
      // first, and the advance can pull a stray element behind a quoted value
      // into the block. Duplicate names are ambiguous, so reject the block.
      if (paramName in args) {
        duplicateParameter = true;
      } else {
        args[paramName] = parseParameterValue(
          decodeXmlEntities(stripDelimitingNewlines(value)),
        );
      }
    }
    outsideParameters += paramsBlock.slice(cursor);
    if (duplicateParameter) {
      TOOL_CALL_PATTERN.lastIndex = paramsStart;
      continue;
    }
    const unquotedParameters = textOutside(
      text,
      consumedValueSpans,
      paramsStart,
      closeStart,
    );
    // An advance may only step over regions this block owns: the search for a
    // later closer is unbounded, so without this it also binds the block to a
    // closer merely mentioned in the prose that follows, which silently drops
    // every parameter behind it and reinserts the block's own markup into the
    // visible turn. What the advance swallowed must therefore be nothing but
    // the block's own parameter elements and the values inside them.
    if (
      closeStart > lazyCloseStart &&
      textOutside(text, parameterSpans, lazyCloseStart, closeStart).trim() !==
        ''
    ) {
      TOOL_CALL_PATTERN.lastIndex = paramsStart;
      continue;
    }
    // A missing close must not borrow a later block's parameters or recover
    // only the arguments preceding a prematurely matched function close, so
    // reject a call opener the parameters did not consume. A closer is only
    // borrowed when the swallowed region contains a nested call: an open tag
    // inside an accepted value is that value's own text — a value may document
    // this syntax literally — and counting it as unclosed rejected the intact
    // call, which then never ran and left its raw markup visible.
    if (
      /<(?:function|invoke)(?:[\s=>]|$)/.test(unquotedParameters) ||
      /<\/?(?:function|invoke|parameter)(?:[\s=>]|$)/.test(outsideParameters) ||
      /^ {0,3}(?:`{3,}|~{3,})/m.test(outsideParameters)
    ) {
      TOOL_CALL_PATTERN.lastIndex = paramsStart;
      continue;
    }

    if (toolName && Object.keys(args).length > 0) {
      blocks.push({
        name: toolName,
        args,
        start: match.index,
        end: blockEnd,
        parameterSpans,
      });
    }
  }

  const eligibleBlocks = blocks.filter((block) => isEligibleBlock(block));
  let extendedMasks = false;
  for (const block of eligibleBlocks) {
    for (const [start, end] of block.parameterSpans) {
      if (!parameterRanges.some(([from, to]) => start >= from && end <= to)) {
        parameterRanges.push([start, end]);
        extendedMasks = true;
      }
    }
  }
  if (!extendedMasks) return eligibleBlocks;
  // Documentation spans are appended out of text order and overlap the flat
  // matches they extend, so restore the ordered, disjoint sequence the mask
  // below needs: example tag offsets are read back against the unmasked text.
  parameterRanges.sort(([startA], [startB]) => startA - startB);
  let rangeCount = 0;
  for (let index = 0; index < parameterRanges.length; index++) {
    const current = parameterRanges[index];
    const previous = parameterRanges[rangeCount - 1];
    if (previous && current[0] <= previous[1]) {
      previous[1] = Math.max(previous[1], current[1]);
    } else {
      parameterRanges[rangeCount++] = current;
    }
  }
  parameterRanges.length = rangeCount;
  const refreshedExamples = computeExampleRanges(
    text,
    parameterRanges,
    exampleTagPositions(text, parameterRanges),
    quotedValueRanges,
  );
  // Reconsider every block, not just the ones the un-extended masks kept: a
  // live block's value tail is data, so it can move a later sibling out of a
  // fence the flat view put it in.
  return blocks.filter((block) => isEligibleBlock(block, refreshedExamples));

  function isEligibleBlock(
    { start, end, parameterSpans }: ToolCallBlock,
    examples: Array<[number, number]> = exampleRanges,
  ): boolean {
    return (
      // Both ends, like the fence and example guards below: a comment opener
      // inside the block's own body masks its tail, so probing only `start`
      // dispatches a call the module just classified as documentation.
      !hiddenDocs.some(
        ([from, to]) =>
          (start >= from && start < to) || (end - 1 >= from && end - 1 < to),
      ) &&
      !positionInsideFence(text, start, parameterRanges) &&
      !positionInsideFence(
        text,
        end - 1,
        parameterRanges.concat(parameterSpans),
      ) &&
      !examples.some(
        ([exampleStart, exampleEnd]) =>
          (start >= exampleStart && start < exampleEnd) ||
          (end - 1 >= exampleStart &&
            end - 1 < exampleEnd &&
            !parameterSpans.some(
              ([from, to]) => exampleStart >= from && exampleStart < to,
            )),
      )
    );
  }
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

  const removedRanges: Array<[number, number]> = extracted.map(
    ({ start, end }) => [start, end],
  );
  const withoutRecoveredCalls = textOutside(text, removedRanges);
  // The measure counts something as prose only when no block claimed it, on the
  // complete boundaries argument extraction uses: a rejected block leaves an
  // opener behind that the lazy pattern can only delete as a pair, so charging
  // that markup to prose refused a turn whose only call was recovered. Text
  // that merely looks like a tag stays prose, as it does on the base. See
  // #13492.
  const proseRanges: Array<[number, number]> = [...removedRanges];
  TOOL_CALL_PATTERN.lastIndex = 0;
  let claimed: RegExpExecArray | null;
  while ((claimed = TOOL_CALL_PATTERN.exec(text)) !== null) {
    proseRanges.push([claimed.index, claimed.index + claimed[0].length]);
  }
  proseRanges.sort(([startA], [startB]) => startA - startB);
  const proseOnly = textOutside(text, proseRanges)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > 0 && proseOnly.length / text.length > 0.8) {
    return { recovered: false, functionCallParts: [], remainingText: text };
  }
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
