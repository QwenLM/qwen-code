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

type Span = [number, number];

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
 * Sorts and merges spans into an ordered, disjoint sequence. Every consumer
 * of the span model relies on that property, so it is restored once, here,
 * rather than being re-established by each derivation.
 */
function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort(([startA], [startB]) => startA - startB);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) {
      last[1] = Math.max(last[1], span[1]);
    } else {
      merged.push([span[0], span[1]]);
    }
  }
  return merged;
}

/**
 * Returns true when `index` falls inside one of `spans`. The spans are
 * ordered and disjoint, so this is a binary search rather than the linear
 * scan every guard used to run for itself.
 */
function spanContains(
  spans: ReadonlyArray<readonly [number, number]>,
  index: number,
): boolean {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = spans[middle];
    if (index < start) {
      high = middle - 1;
    } else if (index >= end) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
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

const FENCE_LINE_PATTERN = /^ {0,3}((`{3,})|~{3,})/;

interface FenceMark {
  delim: '`' | '~';
  len: number;
}

interface FenceTable {
  /**
   * True when `index` falls inside an unclosed fenced code block, with the
   * same line-granular answers the per-query rescan gave: a position on a
   * fence line is inside the block that line opens or keeps open, except for
   * the offsets before the delimiter run.
   */
  insideFence(index: number): boolean;
}

/**
 * Builds the fence view of the turn once, left to right. Fence state is a
 * property of the whole text and of which lines are parameter data, so
 * deriving it per query (once per tag, once per block, once per comment
 * opener) made recovery quadratic in turn length. Keeping the per-line state
 * in a table makes every query a lookup, and keeps the rule that matters — a
 * fence is closed only by a run of the same delimiter at least as long as its
 * opener with nothing but whitespace after it — in one place.
 */
function buildFenceTable({ lines, starts, isData }: LineIndex): FenceTable {
  const openBefore: Array<FenceMark | null> = new Array(lines.length);
  let open: FenceMark | null = null;
  for (let index = 0; index < lines.length; index++) {
    openBefore[index] = open;
    if (isData[index]) continue;
    const match = FENCE_LINE_PATTERN.exec(lines[index]);
    if (!match) continue;
    const delim = match[2] ? '`' : '~';
    const len = match[1].length;
    if (open === null) {
      open = { delim, len };
    } else if (
      open.delim === delim &&
      len >= open.len &&
      lines[index].slice(match[0].length).trim() === ''
    ) {
      open = null;
    }
  }
  return {
    insideFence(index: number): boolean {
      if (index <= 0) return false;
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (starts[middle] <= index) low = middle;
        else high = middle - 1;
      }
      const before = openBefore[low] !== null;
      if (isData[low]) return before;
      const column = index - starts[low];
      if (column === 0) return before;
      const partial = lines[low].slice(0, column);
      const match = FENCE_LINE_PATTERN.exec(partial);
      if (!match) return before;
      const mark = openBefore[low];
      const delim = match[2] ? '`' : '~';
      const len = match[1].length;
      if (
        mark !== null &&
        mark.delim === delim &&
        len >= mark.len &&
        partial.slice(match[0].length).trim() === ''
      ) {
        return false;
      }
      return true;
    },
  };
}

/**
 * Splits the turn into lines once. Every line-based derivation (fences,
 * comments, indented code) reads these arrays instead of re-slicing the
 * text, so the number of full-text passes no longer depends on how many
 * markers the turn mentions.
 */
interface LineIndex {
  lines: string[];
  starts: number[];
  isData: boolean[];
}

function buildLineIndex(text: string, dataSpans: Span[]): LineIndex {
  const lines = text.split('\n');
  const starts: number[] = new Array(lines.length);
  const isData: boolean[] = new Array(lines.length);
  let offset = 0;
  let spanIndex = 0;
  for (let index = 0; index < lines.length; index++) {
    starts[index] = offset;
    while (spanIndex < dataSpans.length && dataSpans[spanIndex][1] <= offset) {
      spanIndex++;
    }
    isData[index] =
      spanIndex < dataSpans.length && dataSpans[spanIndex][0] <= offset;
    offset += lines[index].length + 1;
  }
  return { lines, starts, isData };
}

/**
 * Documentation regions the fence and `<example>` guards cannot see: HTML
 * comments and CommonMark indented code blocks. A call there is shown to the
 * model, not emitted by it, so it must not dispatch. See #13492.
 *
 * Comments only open at the start of a line outside a fence and outside
 * parameter data, so a prose mention of the sequence stays prose and an
 * opener a value owns is data — whether or not the stream ever closed that
 * value. Indented code cannot interrupt a paragraph or a list item, so it
 * starts only after a blank line and, inside a list item, only past that
 * item's content column; like a fence, it cannot start inside parameter
 * data, which is a file's literal content rather than prose CommonMark
 * rules describe.
 */
function computeDocumentationSpans(
  text: string,
  lines: LineIndex,
  dataSpans: Span[],
  openValueSpans: Span[],
  fences: FenceTable,
): Span[] {
  const spans: Span[] = [];
  // A terminator inside a value is data, not the end of the comment — whether
  // or not the stream closed that value. Filtering the terminator list once
  // keeps the per-opener search O(1) instead of rescanning the remainder of the
  // turn from every comment opener.
  const terminators: number[] = [];
  for (let index = text.indexOf('-->'); index !== -1; ) {
    if (
      !spanContains(dataSpans, index) &&
      !spanContains(openValueSpans, index)
    ) {
      terminators.push(index);
    }
    index = text.indexOf('-->', index + 3);
  }
  let terminatorIndex = 0;
  let commentStart = -1;
  let inComment = false;
  let previousBlank = true;
  let inIndentedCode = false;
  let listContentIndent = -1;
  for (let lineIndex = 0; lineIndex < lines.lines.length; lineIndex++) {
    const line = lines.lines[lineIndex];
    const lineStart = lines.starts[lineIndex];
    const blank = line.trim() === '';
    const indent = line.length - line.trimStart().length;
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
        !spanContains(dataSpans, openerStart) &&
        !fences.insideFence(openerStart)
      ) {
        // The scan starts at the opener itself so the abrupt-close forms
        // `<!-->` and `<!--->` — complete empty comments, whose terminator
        // overlaps the opener — close here instead of masking the whole
        // remainder of the turn.
        while (
          terminatorIndex < terminators.length &&
          terminators[terminatorIndex] < openerStart
        ) {
          terminatorIndex++;
        }
        const close =
          terminatorIndex < terminators.length
            ? terminators[terminatorIndex]
            : -1;
        if (close !== -1) {
          spans.push([openerStart, close + 3]);
        } else if (
          // Unterminated, the region runs to end of turn. When the opener sits
          // in a value the stream never closed, that value is data, and
          // masking the remainder would veto genuine siblings in exactly the
          // truncated streams this fallback exists for. A terminated comment
          // stays masked whichever value owns it.
          !spanContains(openValueSpans, openerStart)
        ) {
          inComment = true;
          commentStart = openerStart;
        }
      } else if (
        /^(?: {4,}|\t)\S/.test(line) &&
        (inIndentedCode || previousBlank) &&
        !lines.isData[lineIndex] &&
        // A list item's lazy continuation is indented below its content column
        // + 4, which makes it a paragraph rather than an indented code block.
        (listContentIndent < 0 ||
          /^\t/.test(line) ||
          indent >= listContentIndent + 4)
      ) {
        spans.push([lineStart, lineStart + line.length]);
        inIndentedCode = true;
      } else if (!blank) {
        inIndentedCode = false;
      }
    }
    previousBlank = blank;
  }
  if (inComment) spans.push([commentStart, text.length]);
  return spans;
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

// A parameter open tag the strict grammar can validate, matched at a fixed
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

// A call open or close tag. The closer's dialect is captured so a closer can
// only pair with an opener of its own dialect.
const CALL_TAG_PATTERN =
  /<invoke\s+name=["'][^"']+["']>|<function=[^\s<>]+>|<\/(invoke|function)>/g;

// A parameter open or close tag. Quoted runs are admitted whole so a `>`
// inside an attribute value does not end the tag early.
const PARAMETER_TAG_PATTERN =
  /<\/?parameter(?=[\s=>])(?:[^>"']|"[^"]*"|'[^']*')*>/g;

const EXAMPLE_TAG_PATTERN =
  /<\/?example(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/g;
const EXAMPLE_OPEN_TAG_PATTERN =
  /<example(?=[\s>])(?:[^>"']|"[^"]*"|'[^']*')*(?<!\/)>/g;
const EXAMPLE_CLOSE_TAG_PATTERN = /<\/example(?=[\s/>])/g;

function hasBalancedQuotedCalls(value: string): boolean {
  const stack: string[] = [];
  let hasCall = false;
  let tag: RegExpExecArray | null;
  CALL_TAG_PATTERN.lastIndex = 0;
  while ((tag = CALL_TAG_PATTERN.exec(value)) !== null) {
    if (tag[1]) {
      if (stack.pop() !== tag[1]) return false;
      hasCall = true;
    } else {
      stack.push(tag[0].startsWith('<invoke') ? 'invoke' : 'function');
    }
  }
  return hasCall && stack.length === 0;
}

type ElementTag =
  | { kind: 'call-open'; index: number; end: number; dialect: string }
  | { kind: 'call-close'; index: number; end: number; dialect: string }
  | { kind: 'param-open'; index: number; end: number }
  | { kind: 'param-close'; index: number; end: number };

function collectElementTags(text: string): ElementTag[] {
  const calls: ElementTag[] = [];
  const parameters: ElementTag[] = [];
  let match: RegExpExecArray | null;
  CALL_TAG_PATTERN.lastIndex = 0;
  while ((match = CALL_TAG_PATTERN.exec(text)) !== null) {
    const end = match.index + match[0].length;
    if (match[1]) {
      calls.push({
        kind: 'call-close',
        index: match.index,
        end,
        dialect: match[1],
      });
    } else {
      calls.push({
        kind: 'call-open',
        index: match.index,
        end,
        dialect: match[0].startsWith('<invoke') ? 'invoke' : 'function',
      });
    }
  }
  PARAMETER_TAG_PATTERN.lastIndex = 0;
  while ((match = PARAMETER_TAG_PATTERN.exec(text)) !== null) {
    parameters.push({
      kind: match[0].startsWith('</') ? 'param-close' : 'param-open',
      index: match.index,
      end: match.index + match[0].length,
    });
  }
  const merged: ElementTag[] = [];
  let callIndex = 0;
  let parameterIndex = 0;
  while (callIndex < calls.length || parameterIndex < parameters.length) {
    if (
      parameterIndex >= parameters.length ||
      (callIndex < calls.length &&
        calls[callIndex].index < parameters[parameterIndex].index)
    ) {
      merged.push(calls[callIndex++]);
    } else {
      merged.push(parameters[parameterIndex++]);
    }
  }
  return merged;
}

interface CallFrame {
  dialect: string;
  /** No prose has appeared at this call's own body level since its open tag. */
  clean: boolean;
  /** Parameter elements open at this depth belong directly to this call. */
  paramDepth: number;
  /** Offset just past the closer that ends this call, when the stream wrote one. */
  close: number | null;
}

interface ParameterPairing {
  /** Parameter elements the stream closed, in text order, nesting included. */
  closed: Span[];
  /** Parameter elements the stream never closed, with the call body that owns them. */
  unclosed: Array<{ start: number; owner: CallFrame | null; owned: boolean }>;
  /** Offsets of the call closers, in text order. */
  callClosers: number[];
}

/**
 * Pairs call and parameter elements by depth in one ordered walk.
 *
 * The flat `PARAMETER_PATTERN` cannot answer either question the guards need:
 * it is lazy, so an element nested inside a value consumes that value's own
 * terminator, and a prose mention of the tag shape pairs with the next closer
 * anywhere in the turn — turning prose into parameter data and blinding every
 * documentation guard behind it. Depth pairing gives each element the extent
 * it actually owns, leaves the prose mention unclosed and therefore inert,
 * and gives a call opener the closer of its own dialect.
 *
 * A parameter a call body never closed is still value data, but only when it
 * is the call's direct child: prose between the call's open tag and the
 * element means the "value" is a mention, not a truncated stream.
 */
function pairElements(text: string): ParameterPairing {
  const tags = collectElementTags(text);
  const closed: Span[] = [];
  const callClosers: number[] = [];
  const calls: CallFrame[] = [];
  const parameters: Array<{
    start: number;
    owner: CallFrame | null;
    ownerClean: boolean;
  }> = [];
  let lastTagEnd = 0;
  for (const tag of tags) {
    const top = calls[calls.length - 1];
    if (top && parameters.length === top.paramDepth) {
      if (text.slice(lastTagEnd, tag.index).trim() !== '') top.clean = false;
    }
    lastTagEnd = tag.end;
    if (tag.kind === 'call-open') {
      calls.push({
        dialect: tag.dialect,
        clean: true,
        paramDepth: parameters.length,
        close: null,
      });
    } else if (tag.kind === 'call-close') {
      callClosers.push(tag.index);
      const frame = calls[calls.length - 1];
      if (frame && frame.dialect === tag.dialect) {
        frame.close = tag.end;
        calls.pop();
      }
    } else if (tag.kind === 'param-open') {
      const owner = calls[calls.length - 1] ?? null;
      parameters.push({
        start: tag.index,
        owner,
        ownerClean: owner?.clean ?? false,
      });
    } else {
      const open = parameters.pop();
      if (open) closed.push([open.start, tag.end]);
    }
  }
  return {
    closed,
    unclosed: parameters.map(({ start, owner, ownerClean }) => ({
      start,
      owner,
      owned: owner !== null && ownerClean,
    })),
    callClosers,
  };
}

/**
 * Returns tag positions of `<example>` wrappers that the markdown lexer reads
 * as HTML rather than as inline text, or null when the lexer cannot be
 * consulted safely.
 */
function exampleTagPositions(
  text: string,
  dataSpans: Span[],
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
  // Parameter data is replaced by spaces, keeping offsets and line breaks so
  // the tag positions map back onto the unmasked text.
  const proseParts: string[] = [];
  let cursor = 0;
  for (const [start, end] of dataSpans) {
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

/**
 * Derives the `<example>` documentation regions once.
 *
 * A value inside a documentation region may itself carry example tags. When
 * the value quotes a complete call its tags are data, but whether the region's
 * own closer is one of them cannot be decided from the tag alone. Each opener
 * such a value leaves unclosed therefore keeps the region open through one
 * more closer, and no further, so a stray closer later in the turn cannot
 * swallow the calls that follow the documentation. The count is accumulated
 * during the single tag walk rather than by rescanning the region once per
 * ambiguity.
 */
function computeExampleSpans(
  text: string,
  tagPositions: Set<number> | null,
  dataSpans: Span[],
  documentationSpans: Span[],
  quotedValueSpans: Span[],
  fences: FenceTable,
): Span[] {
  const spans: Span[] = [];
  let open: { start: number; count: number; lastCloserEnd: number } | null =
    null;
  let valueIndex = 0;
  let match: RegExpExecArray | null;
  EXAMPLE_TAG_PATTERN.lastIndex = 0;
  while ((match = EXAMPLE_TAG_PATTERN.exec(text)) !== null) {
    const position = match.index;
    while (
      valueIndex < quotedValueSpans.length &&
      quotedValueSpans[valueIndex][0] < position
    ) {
      const [start, end] = quotedValueSpans[valueIndex++];
      if (open === null || start < open.start) continue;
      const value = text.slice(start, end);
      const unclosed =
        (value.match(EXAMPLE_OPEN_TAG_PATTERN)?.length ?? 0) -
        (value.match(EXAMPLE_CLOSE_TAG_PATTERN)?.length ?? 0);
      open.count += Math.max(0, unclosed);
    }
    if (
      spanContains(dataSpans, position) ||
      (tagPositions !== null && !tagPositions.has(position)) ||
      fences.insideFence(position) ||
      spanContains(documentationSpans, position) ||
      /\/\s*>$/.test(match[0])
    ) {
      continue;
    }
    if (match[0].startsWith('</')) {
      if (open === null) continue;
      open.lastCloserEnd = position + match[0].length;
      open.count -= 1;
      if (open.count <= 0) {
        spans.push([open.start, open.lastCloserEnd]);
        open = null;
      }
    } else if (open === null) {
      open = { start: position, count: 1, lastCloserEnd: -1 };
    } else {
      open.count += 1;
    }
  }
  if (open !== null) {
    spans.push([
      open.start,
      open.lastCloserEnd === -1 ? text.length : open.lastCloserEnd,
    ]);
  }
  return spans;
}

interface TurnAnatomy {
  /** Values the strict grammar delimits, so a block reads its arguments from the span. */
  ownedValueSpans: Span[];
  /** Values quoting a complete call: a flat match ending inside one extends past it. */
  quotedValueSpans: Span[];
  /** Spans a block may not start inside: markup a value quotes, not a call. */
  blockSkipSpans: Span[];
  documentationSpans: Span[];
  exampleSpans: Span[];
  fences: FenceTable;
}

/**
 * Derives every structural fact about the turn once, in dependency order:
 * element pairing, then the spans parameter data owns, then fence state, then
 * the documentation regions that depend on both, then the lexer's view of the
 * remaining prose, then the example regions. Every guard downstream reads this
 * object; none of them re-derives a mask or rescans the text for itself.
 */
function deriveTurnAnatomy(text: string): TurnAnatomy {
  const pairing = pairElements(text);
  const valueSpans: Span[] = [];
  let valueEnd = 0;
  for (const span of [...pairing.closed].sort(
    ([startA], [startB]) => startA - startB,
  )) {
    if (span[0] < valueEnd) continue;
    valueEnd = span[1];
    valueSpans.push(span);
  }

  const ownedValueSpans: Span[] = [];
  const quotedValueSpans: Span[] = [];
  for (const [start, end] of valueSpans) {
    const value = parameterValue(text.slice(start, end));
    if (value === null) continue;
    ownedValueSpans.push([start, end]);
    if (hasBalancedQuotedCalls(value)) quotedValueSpans.push([start, end]);
  }

  // A value the stream closed is data everywhere. A value it never closed is
  // data for the comment scan — its interior still marks value data, so a
  // terminator there cannot end the comment, and an unterminated comment that
  // opens inside it must not veto the rest of the turn — but it must not hide
  // the documentation markers themselves: a marker after a truncated stream
  // would then silently stop protecting everything behind it, which is the
  // fail-open this module exists to prevent. A block is only quoted markup
  // when the value it starts inside ends before the turn does (see #13492's
  // truncated-stream cases).
  const openValueSpans: Span[] = [];
  const blockSkipSpans: Span[] = [...valueSpans];
  let closerIndex = 0;
  for (const { start, owner, owned } of pairing.unclosed) {
    if (!owned || owner === null) continue;
    while (
      closerIndex < pairing.callClosers.length &&
      pairing.callClosers[closerIndex] < start
    ) {
      closerIndex++;
    }
    const nextCloser =
      closerIndex < pairing.callClosers.length
        ? pairing.callClosers[closerIndex]
        : text.length;
    openValueSpans.push([
      start,
      Math.min(owner.close ?? text.length, nextCloser),
    ]);
    if (owner.close !== null) blockSkipSpans.push([start, owner.close]);
  }
  const dataSpans = mergeSpans(valueSpans);
  const lines = buildLineIndex(text, dataSpans);
  const fences = buildFenceTable(lines);
  const documentationSpans = mergeSpans(
    computeDocumentationSpans(text, lines, dataSpans, openValueSpans, fences),
  );
  return {
    ownedValueSpans,
    quotedValueSpans,
    blockSkipSpans: mergeSpans(blockSkipSpans),
    documentationSpans,
    exampleSpans: computeExampleSpans(
      text,
      exampleTagPositions(text, dataSpans),
      dataSpans,
      documentationSpans,
      quotedValueSpans,
      fences,
    ),
    fences,
  };
}

/**
 * Extracts XML-style tool calls from plain text content.
 * Tool-call blocks inside fences, explicit example wrappers, HTML comments or
 * indented code blocks are skipped: they document the format rather than
 * emitting a tool call. See #8003.
 * Returns an array of extracted tool calls, or an empty array if none found.
 */
function recoverableToolCallBlocks(text: string): ToolCallBlock[] {
  const {
    ownedValueSpans,
    quotedValueSpans,
    blockSkipSpans,
    documentationSpans,
    exampleSpans,
    fences,
  } = deriveTurnAnatomy(text);
  const blocks: ToolCallBlock[] = [];
  TOOL_CALL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_CALL_PATTERN.exec(text)) !== null) {
    const matchStart = match.index;
    if (spanContains(blockSkipSpans, matchStart)) {
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
      // attribute. Reject the block without costing the turn, and resume at
      // the flat match end: any offset inside the block comes from the same
      // quote-pairing walk just distrusted and can re-enter its body.
      TOOL_CALL_PATTERN.lastIndex = match.index + match[0].length;
      continue;
    }
    // A value the block quotes a call in owns the flat close that landed
    // inside it; the block's own closer is the first one past that value. The
    // spans are sorted and disjoint and `closeStart` only moves forward.
    for (const [start, end] of quotedValueSpans) {
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
      const owned = ownedValueSpans.find(
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

  return blocks.filter(
    ({ start, end, parameterSpans }) =>
      // Both ends, like the fence and example guards below: a comment opener
      // inside the block's own body masks its tail, so probing only `start`
      // dispatches a call the module just classified as documentation.
      !spanContains(documentationSpans, start) &&
      !spanContains(documentationSpans, end - 1) &&
      !fences.insideFence(start) &&
      !fences.insideFence(end - 1) &&
      !exampleSpans.some(
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
