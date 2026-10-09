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
const FENCE_DELIMITER_LINE = /^ {0,3}((`{3,})|~{3,})/;

function positionInsideFence(
  text: string,
  index: number,
  parameterRanges: Array<[number, number]>,
): boolean {
  let openFence: { delim: string; len: number } | null = null;
  let lineStart = 0;
  for (const line of text.slice(0, index).split('\n')) {
    const lineEnd = lineStart + line.length;
    const startsInsideParameter = parameterRanges.some(
      ([start, end]) => lineStart >= start && lineStart < end,
    );
    lineStart = lineEnd + 1;
    const m = FENCE_DELIMITER_LINE.exec(line);
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
  // when the text can actually produce an example range. The tag scan below
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
    const masked = parameterRanges.some(
      ([start, end]) => tagPosition >= start && tagPosition < end,
    );
    if (masked || (tagPositions !== null && !tagPositions.has(tagPosition))) {
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

// Matches a parameter open or close tag. Quoted runs are admitted whole so a
// `>` inside an attribute value does not end the tag early.
const PARAMETER_TAG_PATTERN =
  /<\/?parameter(?=[\s=>])(?:[^>"']|"[^"]*"|'[^']*')*>/g;

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
function parameterOwnership(text: string): {
  closed: Array<[number, number]>;
  unclosed: number[];
} {
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
  return { closed: spans, unclosed: openStarts };
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

  // Regions a closed parameter value owns. A call matched inside one is markup
  // the value quotes rather than a call the model emitted, so it must not be
  // dispatched: documentation would otherwise execute. The block quoting it is
  // still recovered, with that value intact. Skipping the match whole also
  // keeps the rejected-block rescan below out of the value it belongs to. See
  // #13492.
  const ownership = parameterOwnership(text);
  const valueSpans = ownership.closed.sort(
    ([startA, endA], [startB, endB]) => startA - startB || endB - endA,
  );
  const quotedValueRanges: Array<[number, number]> = [];
  let outerEnd = 0;
  for (const [start, end] of valueSpans) {
    if (start < outerEnd) continue;
    outerEnd = end;
    const element = text.slice(start, end);
    // Classifying on a scan-derived offset is only sound when the open tag is
    // the same well-formed element the flat matcher consumes. A name whose two
    // quotes do not pair — which the name group admits, its delimiters being
    // independent classes — sends `openTagEnd` out of quote mode inside the
    // value, so the element would be classified from behind its own leading
    // text and a truncated argument dispatched. Fall back to the flat match
    // instead, which leaves the block rejected. See #13492.
    if (!/^<parameter(?:\s+name=(["'])[^"']+\1|=[^\s<>"']+)>/.test(element)) {
      continue;
    }
    const valueStart = openTagEnd(element);
    if (
      valueStart !== -1 &&
      element.endsWith('</parameter>') &&
      hasBalancedQuotedCalls(element.slice(valueStart, -'</parameter>'.length))
    ) {
      quotedValueRanges.push([start, end]);
    }
  }
  const tagPositions = exampleTagPositions(text, parameterRanges);
  const exampleRanges = computeExampleRanges(
    text,
    parameterRanges,
    tagPositions,
    quotedValueRanges,
  );
  // Documentation spans are appended out of text order and overlap the flat
  // matches they extend, so restore the ordered, disjoint sequence the mask
  // below needs: it blanks these ranges with a single forward cursor, which is
  // only length-preserving while no range starts behind that cursor. Example
  // tag offsets are read back against the unmasked text, and the lexer cap is
  // measured on text.length, so a mask that grows breaks both.
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
    // A rejected block may have swallowed a complete later block, so rescan
    // from just after this block's open tag instead of its borrowed close.
    const tagEnd = openTagEnd(match[0]);
    const resumeAt =
      tagEnd === -1 ? match.index + match[0].length : match.index + tagEnd;
    const closeTag = match[1] !== undefined ? '</invoke>' : '</function>';
    let closeStart = match.index + match[0].length - closeTag.length;
    // Where this match's own closer sat before the advance below moved it.
    const lazyCloseStart = closeStart;
    // The ranges are sorted and disjoint and `closeStart` only moves forward,
    // so the scan resumes past every range it has already left instead of
    // re-finding from index 0: a turn built of many value-quoting blocks makes
    // the repeated whole-list search cubic, and every step here reaches further
    // right anyway.
    let rangeIndex = 0;
    while (rangeIndex < quotedValueRanges.length) {
      const quotedValue = quotedValueRanges[rangeIndex];
      if (quotedValue[1] <= closeStart) {
        rangeIndex++;
        continue;
      }
      if (closeStart < quotedValue[0]) break;
      closeStart = text.indexOf(closeTag, quotedValue[1]);
      if (closeStart === -1) break;
    }
    if (closeStart === -1) {
      TOOL_CALL_PATTERN.lastIndex = resumeAt;
      continue;
    }
    // `match[0]` is exactly openTag + body + closeTag, so the body length is
    // what separates this block's open tag from its parameters. Deriving the
    // split location by scanning instead returns an offset inside the body
    // whenever the name attribute opens with one quote character and closes
    // with the other — the name group's delimiters are independent classes —
    // which silently drops every parameter before that offset.
    const paramsStart = lazyCloseStart - (match[2] ?? match[4]).length;
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
    PARAMETER_PATTERN.lastIndex = 0;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = PARAMETER_PATTERN.exec(paramsBlock)) !== null) {
      const parameterStart = paramsStart + paramMatch.index;
      const ownedRange = quotedValueRanges.find(
        ([start, end]) => start === parameterStart && end <= closeStart,
      );
      let value = paramMatch[3];
      let parameterEnd = paramMatch.index + paramMatch[0].length;
      if (ownedRange) {
        parameterEnd = ownedRange[1] - paramsStart;
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
      args[paramName] = parseParameterValue(
        decodeXmlEntities(stripDelimitingNewlines(value)),
      );
    }
    outsideParameters += paramsBlock.slice(cursor);
    let unquotedParameters = '';
    cursor = paramsStart;
    for (const [start, end] of quotedValueRanges) {
      if (start < paramsStart || end > closeStart) continue;
      unquotedParameters += text.slice(cursor, start);
      cursor = end;
    }
    unquotedParameters += text.slice(cursor, closeStart);
    // An advance may only step over regions this block owns: the search for a
    // later closer is unbounded, so without this it also binds the block to a
    // closer merely mentioned in the prose that follows, which silently drops
    // every parameter behind it and reinserts the block's own markup into the
    // visible turn. What the advance swallowed must therefore be nothing but
    // the block's own parameter elements and the quoted values inside them.
    if (closeStart > lazyCloseStart) {
      // Extending a call from inside an unclosed outer value would promote
      // that value's documentation into executable syntax. Flat recovery of
      // a separate call remains unchanged when no advance is needed.
      if (ownership.unclosed.some((start) => start < matchStart)) {
        TOOL_CALL_PATTERN.lastIndex = resumeAt;
        continue;
      }
      const covered: Array<[number, number]> = [];
      for (const span of parameterSpans.concat(quotedValueRanges)) {
        const coveredStart = Math.max(span[0], lazyCloseStart);
        const coveredEnd = Math.min(span[1], closeStart);
        if (coveredStart < coveredEnd) covered.push([coveredStart, coveredEnd]);
      }
      covered.sort(([startA], [startB]) => startA - startB);
      let borrowed = '';
      let borrowedCursor = lazyCloseStart;
      for (const [start, end] of covered) {
        if (start > borrowedCursor) {
          borrowed += text.slice(borrowedCursor, start);
        }
        borrowedCursor = Math.max(borrowedCursor, end);
      }
      borrowed += text.slice(borrowedCursor, closeStart);
      if (borrowed.trim() !== '') {
        TOOL_CALL_PATTERN.lastIndex = resumeAt;
        continue;
      }
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
      TOOL_CALL_PATTERN.lastIndex = resumeAt;
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

  return blocks.filter(
    ({ start, end, parameterSpans }) =>
      !positionInsideFence(text, start, parameterRanges) &&
      !positionInsideFence(
        text,
        end - 1,
        parameterRanges.concat(parameterSpans),
      ) &&
      !exampleRanges.some(
        ([exampleStart, exampleEnd]) =>
          (start >= exampleStart && start < exampleEnd) ||
          (end - 1 >= exampleStart &&
            end - 1 < exampleEnd &&
            !parameterSpans.some(
              ([from, to]) => exampleStart >= from && exampleStart < to,
            )),
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
  // The measure counts something as prose only when no block claimed it, on the
  // complete boundaries argument extraction uses: a rejected block leaves an
  // opener behind that the lazy pattern can only delete as a pair, so charging
  // that markup to prose refused a turn whose only call was recovered. Text
  // that merely looks like a tag stays prose, as it does on the base. See
  // #13492.
  const proseRanges = removedRanges.slice() as Array<[number, number]>;
  TOOL_CALL_PATTERN.lastIndex = 0;
  let claimed: RegExpExecArray | null;
  while ((claimed = TOOL_CALL_PATTERN.exec(text)) !== null) {
    proseRanges.push([claimed.index, claimed.index + claimed[0].length]);
  }
  proseRanges.sort(([startA], [startB]) => startA - startB);
  let proseOnly = '';
  cursor = 0;
  for (const [start, end] of proseRanges) {
    if (start > cursor) proseOnly += text.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  proseOnly += text.slice(cursor);
  proseOnly = proseOnly.replace(/\n{3,}/g, '\n\n').trim();
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
