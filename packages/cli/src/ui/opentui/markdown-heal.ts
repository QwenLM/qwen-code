/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Streaming markdown heal (opencode parity): while an assistant message is
 * still streaming, the incremental markdown parser re-parses the trailing
 * blocks on every delta, and unclosed syntax (`1. **聚合` before the closing
 * `**` arrives) flips the tail between literal-marker text and rendered
 * styles frame to frame — the "left-right flicker" on dense Chinese
 * documents. Healing closes the unterminated markers before rendering so the
 * tail always renders as markdown. When streaming settles the message on disk
 * remains the source of truth, but both states apply width-preserving render
 * masks: lone `~` becomes U+223C, unpaired backticks become U+02CB, and
 * thinking-only literal asterisks become U+2217.
 */
import remend from 'remend';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

interface MarkdownNode {
  type: string;
  position?: {
    start: { line: number; offset: number };
    end: { line: number; offset: number };
  };
  children?: MarkdownNode[];
}

interface MarkdownAnalysis {
  protectedRows: Set<number>;
  inlineCodeRanges: Array<[number, number]>;
  emphasisRanges: Array<[number, number]>;
}

const INLINE_CONTAINERS = new Set(['paragraph', 'heading', 'tableCell']);

/**
 * Block-level lines the mask must not touch, plus the exact inline-code
 * ranges the parser recognized. The real parser decides what is
 * code/HTML/table, so list-indented fences, one-column tables and HTML
 * comments no longer depend on hand-rolled approximations. A parse failure
 * leaves both empty and the mask falls back to its line scanner.
 */
function analyzeMarkdown(text: string): MarkdownAnalysis {
  const protectedRows = new Set<number>();
  const inlineCodeRanges: Array<[number, number]> = [];
  const emphasisRanges: Array<[number, number]> = [];
  try {
    const tree = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .parse(text) as MarkdownNode;
    const visit = (node: MarkdownNode, inlineContainer = false): void => {
      if (node.position && node.type === 'inlineCode') {
        inlineCodeRanges.push([
          node.position.start.offset,
          node.position.end.offset,
        ]);
      }
      if (
        node.position &&
        (node.type === 'strong' || node.type === 'emphasis')
      ) {
        emphasisRanges.push([
          node.position.start.offset,
          node.position.end.offset,
        ]);
      }
      if (
        node.position &&
        (node.type === 'code' ||
          node.type === 'table' ||
          (node.type === 'html' && !inlineContainer))
      ) {
        for (
          let line = node.position.start.line;
          line <= node.position.end.line;
          line += 1
        ) {
          protectedRows.add(line - 1);
        }
      }
      const childInInlineContainer =
        inlineContainer || INLINE_CONTAINERS.has(node.type);
      for (const child of node.children ?? []) {
        visit(child, childInInlineContainer);
      }
    };
    visit(tree);
  } catch {
    // Streaming markdown may be briefly unparseable; leave it unmasked.
  }
  return { protectedRows, inlineCodeRanges, emphasisRanges };
}

/**
 * A backtick the parser did not pair into an inline-code span is literal text
 * (a lone key name, or a fence example quoted in prose). OpenTUI's streaming
 * preview and settled tree-sitter pass disagree on how to pair such runs, so
 * both states replace only the unpaired ones with a look-alike grave accent.
 */
const LITERAL_BACKTICK = '\u02CB';
const BACKSLASH_ESCAPABLE = '\\*_{}[]()#+-.!|<>"\'';

function maskProsePunctuation(
  text: string,
  protectedRows: Set<number>,
): string {
  const lines = text.split('\n');
  return lines
    .map((line, index) => {
      if (protectedRows.has(index)) return line;
      let out = '';
      for (let column = 0; column < line.length; column += 1) {
        const char = line[column];
        if (
          char === '\\' &&
          !isEscaped(line, column) &&
          BACKSLASH_ESCAPABLE.includes(line[column + 1] ?? '')
        ) {
          out += line[column + 1];
          column += 1;
          continue;
        }
        if (
          char === '*' &&
          !isEscaped(line, column) &&
          line[column - 1] !== '*' &&
          line[column + 1] !== '*' &&
          /[A-Za-z0-9]/.test(line[column - 1] ?? '') &&
          /[A-Za-z0-9]/.test(line[column + 1] ?? '')
        ) {
          out += ASTERISK_OPERATOR;
          continue;
        }
        out += char;
      }
      return out;
    })
    .join('\n');
}

/**
 * Thinking text often quotes markdown syntax literally (`**bold, *italic`).
 * The preview parser treats those unmatched runs as real emphasis, while the
 * settled pass does not, so thinking masks every asterisk the parser did not
 * recognize as emphasis or inline code. Assistant output keeps the healer.
 */
export function maskThinkingEmphasis(text: string): string {
  if (!text.includes('*')) return text;
  const analysis = analyzeMarkdown(text);
  const ranges = [
    ...analysis.inlineCodeRanges,
    ...analysis.emphasisRanges,
  ].sort((a, b) => a[0] - b[0]);
  let rangeIndex = 0;
  let offset = 0;
  const lines = text.split('\n');
  let out = '';
  for (const [index, line] of lines.entries()) {
    if (analysis.protectedRows.has(index)) {
      out += line;
    } else {
      for (let column = 0; column < line.length; column += 1) {
        while (
          rangeIndex < ranges.length &&
          offset + column >= ranges[rangeIndex][1]
        ) {
          rangeIndex += 1;
        }
        const inEmphasis =
          rangeIndex < ranges.length &&
          offset + column >= ranges[rangeIndex][0] &&
          offset + column < ranges[rangeIndex][1];
        out +=
          line[column] === '*' && !inEmphasis
            ? ASTERISK_OPERATOR
            : line[column];
      }
    }
    if (index < lines.length - 1) out += '\n';
    offset += line.length + 1;
  }
  return out;
}

function maskLiteralBackticks(
  text: string,
  analysis: MarkdownAnalysis,
): string {
  if (!text.includes('`')) return text;
  const { protectedRows, inlineCodeRanges } = analysis;
  const ranges = [...inlineCodeRanges].sort((a, b) => a[0] - b[0]);
  const lines = text.split('\n');
  let rangeIndex = 0;
  let offset = 0;
  let out = '';
  for (const [index, line] of lines.entries()) {
    while (rangeIndex < ranges.length && offset >= ranges[rangeIndex][1]) {
      rangeIndex += 1;
    }
    if (protectedRows.has(index)) {
      out += line;
      if (index < lines.length - 1) out += '\n';
      offset += line.length + 1;
      continue;
    }

    let maskAll = false;
    let run = 0;
    const literal = new Set<number>();
    const escaped = new Set<number>();
    for (let column = 0; column <= line.length; column += 1) {
      if (
        line[column] === '\\' &&
        line[column + 1] === '`' &&
        !isEscaped(line, column)
      ) {
        escaped.add(column + 1);
        run = 0;
        continue;
      }
      while (
        rangeIndex < ranges.length &&
        offset + column >= ranges[rangeIndex][1]
      ) {
        rangeIndex += 1;
      }
      const inInlineCode =
        rangeIndex < ranges.length &&
        offset + column >= ranges[rangeIndex][0] &&
        offset + column < ranges[rangeIndex][1];
      if (line[column] === '`' && !escaped.has(column)) {
        run += 1;
        if (run > 1) maskAll = true;
        if (!inInlineCode) {
          literal.add(column);
          maskAll = true;
        }
      } else {
        run = 0;
      }
    }

    for (let column = 0; column < line.length; column += 1) {
      if (escaped.has(column + 1) && line[column] === '\\') continue;
      if (
        maskAll &&
        line[column] === '\\' &&
        line[column + 1] === '~' &&
        !isEscaped(line, column)
      ) {
        continue;
      }
      if (escaped.has(column)) {
        out += LITERAL_BACKTICK;
      } else if (maskAll && line[column] === '~') {
        out += TILDE_OPERATOR;
      } else {
        out +=
          line[column] === '`' && (maskAll || literal.has(column))
            ? LITERAL_BACKTICK
            : line[column];
      }
    }
    if (index < lines.length - 1) out += '\n';
    offset += line.length + 1;
  }
  return out;
}

/**
 * TODO: remove the bare-URL/email half of this mask when @opentui/core is
 * upgraded to 0.8.4 or newer. 0.5.10's streaming preview expands a GFM
 * autolink into `label (href)`; for a bare URL the label *is* the URL, so the
 * text doubles in width until the tree-sitter pass replaces the preview.
 * 0.8.4 suppresses the suffix when the label equals the href. The preview
 * linkifier ignores U+200B inside the URL, so an `https://` token is wrapped
 * in an inline code span while streaming (same characters, code styling
 * until settle); `www.`/email tokens break with a zero-width space. Once
 * streaming settles the raw text (no mask) renders the real link. The
 * shortcut-label strip below is independent of the upgrade: the settled
 * renderer conceals `[expr.add]` brackets while the preview shows them, and
 * 0.8.4 does not change that.
 */
const ZERO_WIDTH_SPACE = '\u200B';
// A fence may sit in a blockquote and may share its first line with a list
// marker, but CommonMark only allows up to three columns of indentation: a
// four-space line is an indented code block, not a fence.
const BLOCKQUOTE_PREFIX_REGEX = /^(?: {0,3}>[ \t]?)*/;
const LIST_MARKER_PREFIX_REGEX = /^(?:[-+*]|\d{1,9}[.)])[ \t]+/;
const FENCE_MARKER_REGEX = /^( {0,3})(`{3,}|~{3,})(.*)$/;

interface Fence {
  char: string;
  length: number;
  quoteDepth: number;
  /** List content column stripped before matching this fence. */
  indent: number;
}

interface ContainerLine {
  quoteDepth: number;
  rest: string;
}

function containerOf(line: string): ContainerLine {
  let rest = line;
  let quoteDepth = 0;
  for (;;) {
    const match = /^( {0,3})>[ \t]?/.exec(rest);
    if (!match) break;
    quoteDepth += 1;
    rest = rest.slice(match[0].length);
  }
  return { quoteDepth, rest };
}

function fenceParts(
  line: string,
  allowListMarker: boolean,
  indent = 0,
): {
  marker: string;
  length: number;
  rest: string;
  quoteDepth: number;
  indent: number;
} | null {
  const { quoteDepth, rest } = containerOf(line);
  let body = rest;
  if (allowListMarker) {
    const list = LIST_MARKER_PREFIX_REGEX.exec(body);
    if (list) body = body.slice(list[0].length);
  }
  if (indent > 0) {
    let stripped = 0;
    while (stripped < indent && body[stripped] === ' ') stripped += 1;
    body = body.slice(stripped);
  }
  const match = FENCE_MARKER_REGEX.exec(body);
  if (!match) return null;
  // A backtick fence's info string may not contain a backtick (CommonMark);
  // accepting one opens a fence that no line can close.
  if (match[2][0] === '`' && match[3].includes('`')) return null;
  return {
    marker: match[2][0],
    length: match[2].length,
    rest: match[3],
    quoteDepth,
    indent,
  };
}

function fenceAtLineStart(line: string, indent = 0): Fence | null {
  const parts = fenceParts(line, true, indent);
  return parts
    ? {
        char: parts.marker,
        length: parts.length,
        quoteDepth: parts.quoteDepth,
        indent,
      }
    : null;
}

function isFenceClose(line: string, fence: Fence): boolean {
  const parts = fenceParts(line, false, fence.indent);
  return (
    parts !== null &&
    parts.marker === fence.char &&
    parts.length >= fence.length &&
    parts.rest.trim() === '' &&
    parts.quoteDepth === fence.quoteDepth
  );
}

/**
 * How a line ends the open fence: `close` when it is the matching marker
 * (including the same marker at a shallower blockquote depth, which ends the
 * quote), `null` while the line is still fence content, and `implicit` when a
 * non-blank line leaves the blockquote without a marker, so the caller must
 * process that line as prose again.
 */
function fenceCloseKind(
  line: string,
  fence: Fence,
): 'close' | 'implicit' | null {
  if (isFenceClose(line, fence)) return 'close';
  const { quoteDepth } = containerOf(line);
  if (quoteDepth >= fence.quoteDepth) return null;
  const parts = fenceParts(line, false);
  if (
    parts !== null &&
    parts.marker === fence.char &&
    parts.length >= fence.length &&
    parts.rest.trim() === ''
  ) {
    return 'close';
  }
  return 'implicit';
}

/** Indentation width of the line body after any blockquote container. */
function indentationWidth(rest: string): number {
  let width = 0;
  for (const char of rest) {
    if (char === ' ') {
      width += 1;
    } else if (char === '\t') {
      width += 4 - (width % 4);
    } else {
      break;
    }
  }
  return width;
}

/**
 * ATX heading markers are concealed by the settled renderer but shown by the
 * coalesced streaming preview; dropping them from the streaming text keeps
 * the visible text stable while the heading renders as plain text until it
 * settles.
 */
function stripHeadingMarkers(line: string): string {
  const { rest } = containerOf(line);
  const prefix = line.slice(0, line.length - rest.length);
  const list = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)/.exec(rest);
  const marker = list ? list[0] : '';
  const body = list ? rest.slice(marker.length) : rest;
  const match = /^( {0,3})(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(
    body,
  );
  if (!match) return line;
  return `${prefix}${marker}${match[1]}${match[3] ?? ''}`;
}

/** Whether the backtick at `index` is escaped by an odd backslash run. */
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/** Index just past a matching backtick run, or null when the span is unclosed. */
function closingBackticks(
  line: string,
  from: number,
  length: number,
): number | null {
  for (let i = from; i < line.length; ) {
    if (line[i] !== '`') {
      i++;
      continue;
    }
    let end = i;
    while (end < line.length && line[end] === '`') end++;
    if (end - i === length) return end;
    i = end;
  }
  return null;
}

/**
 * Character ranges covered by inline code spans on one line. An unclosed span
 * protects the rest of the line: the mask must not rewrite it.
 */
function codeSpanRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let from = 0;
  while (from < line.length) {
    if (line[from] !== '`' || isEscaped(line, from)) {
      from++;
      continue;
    }
    let end = from;
    while (end < line.length && line[end] === '`') end++;
    const close = closingBackticks(line, end, end - from);
    if (close === null) {
      ranges.push([from, line.length]);
      break;
    }
    ranges.push([from, close]);
    from = close;
  }
  return ranges;
}

/**
 * Character ranges inside `](…)` on one line. Nothing in a link destination
 * is autolinked text, so the mask must not touch it; the `<…>` destination
 * form includes its angle brackets. A `](` with no closing `)` is literal
 * text and must not swallow the rest of the line.
 */
function linkDestinationRanges(line: string): Array<[number, number]> {
  const codeSpans = codeSpanRanges(line);
  const ranges: Array<[number, number]> = [];
  const closeParen = new Map<number, number>();
  const openParens: number[] = [];
  const isCodeChar = (index: number) =>
    codeSpans.some(([start, end]) => index >= start && index < end);
  for (let index = 0; index < line.length; index += 1) {
    if (isCodeChar(index)) continue;
    if (line[index] === '(' && !isEscaped(line, index)) {
      openParens.push(index);
    } else if (line[index] === ')' && !isEscaped(line, index)) {
      const open = openParens.pop();
      if (open !== undefined) closeParen.set(open, index);
    }
  }
  let from = 0;
  const inCodeSpan = isCodeChar;
  for (;;) {
    const open = line.indexOf('](', from);
    if (open === -1) break;
    if (inCodeSpan(open)) {
      from = open + 2;
      continue;
    }
    const start = open + 2;
    let end = -1;
    if (line[start] === '<') {
      const angleEnd = line.indexOf('>', start + 1);
      if (angleEnd !== -1 && line[angleEnd + 1] === ')') end = angleEnd + 1;
    }
    if (end === -1) {
      end = closeParen.get(open + 1) ?? -1;
    }
    if (end === -1) {
      from = open + 2;
      continue;
    }
    ranges.push([start, end]);
    from = end + 1;
  }
  return ranges;
}

const SCHEME_AT_INDEX_REGEX = /(https?|ftp):\/\//iy;
const WWW_AT_INDEX_REGEX = /www\./y;
const EMAIL_AT_INDEX_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/y;
const EMAIL_LOCAL_CHAR_REGEX = /[A-Za-z0-9._%+-]/;
// ASCII sentence punctuation stays inside the span (the existing URL tests
// pin it), but emphasis delimiters, underscores and CJK punctuation end it so
// the surrounding markup is not swallowed. Tildes are handled by findUrlEnd:
// a single one is a URL character, a `~~` run is a delimiter.
const URL_END_REGEX = /[\s<>"'`)\]},;*_。，、；：！？）】」』》]/;

function findUrlEnd(line: string, start: number): number {
  let end = start;
  while (end < line.length) {
    // A run of two tildes is a strikethrough delimiter; a single tilde is a
    // legal URL character (`/~user`).
    if (line[end] === '~' && line[end + 1] === '~') break;
    if (URL_END_REGEX.test(line[end])) break;
    end += 1;
  }
  return end;
}

function matchAt(regex: RegExp, line: string, index: number) {
  regex.lastIndex = index;
  return regex.exec(line);
}

interface MaskResult {
  text: string;
  /** Backtick run opened but not closed on this line; carried to the next. */
  carry: number | null;
}

/**
 * Masks one line of prose. `carriedCodeSpan` is the backtick run length of a
 * code span opened on a previous line (CommonMark code spans may cross
 * newlines); the return value carries an unclosed run forward.
 */
function maskAutolinksInProse(
  line: string,
  carriedCodeSpan: number | null = null,
): MaskResult {
  const destinations = linkDestinationRanges(line);
  const nextCloseBracket = new Array<number>(line.length + 1).fill(-1);
  let nextClose = -1;
  for (let index = line.length - 1; index >= 0; index -= 1) {
    if (line[index] === ']') nextClose = index;
    nextCloseBracket[index] = nextClose;
  }
  let destinationIndex = 0;
  let out = '';
  let i = 0;
  let carriedLabel: number | null = null;
  let openCodeSpan = carriedCodeSpan;

  if (openCodeSpan !== null) {
    const close = closingBackticks(line, 0, openCodeSpan);
    if (close === null) return { text: line, carry: openCodeSpan };
    out += line.slice(0, close);
    i = close;
    openCodeSpan = null;
  }

  const inDestination = (index: number) => {
    while (
      destinationIndex < destinations.length &&
      destinations[destinationIndex][1] <= index
    ) {
      destinationIndex += 1;
    }
    return (
      destinationIndex < destinations.length &&
      destinations[destinationIndex][0] <= index
    );
  };

  while (i < line.length) {
    const char = line[i];

    if (char === '`' && !isEscaped(line, i)) {
      let end = i;
      while (end < line.length && line[end] === '`') end++;
      const runLength = end - i;
      const close = closingBackticks(line, end, runLength);
      if (close === null) {
        return { text: out + line.slice(i), carry: runLength };
      }
      out += line.slice(i, close);
      i = close;
      continue;
    }

    if (inDestination(i)) {
      out += char;
      i += 1;
      continue;
    }

    // HTML comments/tags own their contents: a URL inside
    // `<img src="https://…">` or `<!-- … -->` is literal markup, not prose.
    if (line.startsWith('<!--', i)) {
      const close = line.indexOf('-->', i + 4);
      if (close !== -1) {
        out += line.slice(i, close + 3);
        i = close + 3;
        continue;
      }
    }
    if (
      char === '<' &&
      /^<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>])/.test(line.slice(i))
    ) {
      const close = line.indexOf('>', i + 1);
      if (close !== -1) {
        out += line.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }

    // `<std::string>` is C++ here, but the preview lexer reads it as an
    // autolink and expands it to `std::string (std::string)`, shifting the
    // rest of the line until the tree-sitter pass replaces it. Only a
    // qualified name (`::`) is masked; real HTML tags (`<b>`, `<details>`)
    // are left to the renderer. `<https://…>` is handled by the scheme rule.
    if (char === '<' && !isEscaped(line, i)) {
      const close = line.indexOf('>', i + 1);
      if (close !== -1) {
        const inner = line.slice(i + 1, close);
        if (
          /^[A-Za-z_:]/.test(inner) &&
          inner.includes('::') &&
          !inner.startsWith('http://') &&
          !inner.startsWith('https://')
        ) {
          out += `<${ZERO_WIDTH_SPACE}`;
          i += 1;
          continue;
        }
      }
    }

    // A settled shortcut link conceals its brackets (`[expr.add]` renders as
    // `expr.add`), while the streaming preview shows them — a two-column
    // shift for every later word. Strip them while streaming; a definition
    // (`[expr.add]:`) and GFM task marker (`- [ ]`) keep theirs. The label is
    // re-scanned so `[https://x.dev]` masks the URL inside in the same pass.
    if (char === '[' && !isEscaped(line, i)) {
      const close = nextCloseBracket[i + 1] ?? -1;
      if (close !== -1) {
        const after = line[close + 1] ?? '';
        const label = line.slice(i + 1, close);
        // A full reference link (`[text][label]`, including C-style
        // `arr[i][j]`) is concealed to its visible label by the settled
        // renderer, so streaming drops both bracket pairs too.
        if (after === '[') {
          const secondClose = nextCloseBracket[close + 2] ?? -1;
          if (secondClose !== -1 && !label.startsWith('^')) {
            // The settled renderer conceals both bracket pairs of a
            // reference link (and C-style `arr[i][j]`); keep only the
            // visible label while streaming.
            const inner = maskAutolinksInProse(label);
            out += inner.text;
            if (inner.carry !== null) carriedLabel = inner.carry;
            i = secondClose + 1;
            continue;
          }
        }
        const before = line.slice(0, i).replace(BLOCKQUOTE_PREFIX_REGEX, '');
        const atLineStart =
          before.replace(LIST_MARKER_PREFIX_REGEX, '').trim() === '';
        const taskMarker =
          /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+$/.test(before) &&
          /^[ xX]$/.test(label);
        if (
          !taskMarker &&
          after !== '(' &&
          after !== '[' &&
          !(after === ':' && atLineStart) &&
          label.length > 0 &&
          label.length < 80 &&
          !label.startsWith('^') &&
          !label.includes('[') &&
          !label.includes(']')
        ) {
          const inner = maskAutolinksInProse(label);
          out += inner.text;
          if (inner.carry !== null) carriedLabel = inner.carry;
          i = close + 1;
          continue;
        }
      }
    }

    const scheme = matchAt(SCHEME_AT_INDEX_REGEX, line, i);
    if (scheme) {
      // OpenTUI 0.5.10's preview linkifier ignores U+200B inside a bare URL
      // and still appends `(href)` while the URL is the streaming tail.
      // Wrapping the URL in an inline code span keeps the preview and the
      // settled text identical (same characters, code styling until settle).
      // Angle autolinks and URLs touching a backtick keep the old break.
      const end = findUrlEnd(line, i + scheme[1].length + 3);
      const url = line.slice(i, end);
      const inAngle = line[i - 1] === '<' || line[end] === '>';
      const nearBacktick =
        line[i - 1] === '`' ||
        line[i - 1] === LITERAL_BACKTICK ||
        line[end] === '`' ||
        line[end] === LITERAL_BACKTICK ||
        url.includes('`') ||
        url.includes(LITERAL_BACKTICK);
      const inLinkLabel =
        line[i - 1] === '[' && line[end] === ']' && line[end + 1] === '(';
      if (inLinkLabel) {
        out += url;
        i = end;
      } else if (inAngle || nearBacktick) {
        out += `${scheme[1]}${ZERO_WIDTH_SPACE}://`;
        i += scheme[1].length + 3;
      } else {
        out += `\`${url}\``;
        i = end;
      }
      continue;
    }

    const www = matchAt(WWW_AT_INDEX_REGEX, line, i);
    if (
      www &&
      line.slice(Math.max(0, i - 3), i) !== '://' &&
      (i === 0 || !/[A-Za-z0-9]/.test(line[i - 1]))
    ) {
      out += `www${ZERO_WIDTH_SPACE}.`;
      i += 4;
      continue;
    }

    // Probe an email only at the start of a local-part run, and skip the
    // whole run when it cannot be an address. Running a sticky email regex
    // at every index is quadratic on long hashes/base64/data URIs.
    if (
      EMAIL_LOCAL_CHAR_REGEX.test(char) &&
      (i === 0 || !EMAIL_LOCAL_CHAR_REGEX.test(line[i - 1])) &&
      line[i - 1] !== '/'
    ) {
      const email = matchAt(EMAIL_AT_INDEX_REGEX, line, i);
      if (email) {
        const at = email[0].indexOf('@');
        out += `${email[0].slice(0, at)}${ZERO_WIDTH_SPACE}${email[0].slice(at)}`;
        i += email[0].length;
        continue;
      }
      let end = i;
      while (end < line.length && EMAIL_LOCAL_CHAR_REGEX.test(line[end])) {
        end += 1;
      }
      // `_https://…_` / `xhttps://…`: the emphasis/word character joins the
      // local-part run, but a scheme starts inside it. Find that boundary and
      // let the scheme rule mask the URL instead of skipping the run.
      if (line.slice(end, end + 3) === '://') {
        let schemeStart = -1;
        for (let position = i; position < end; position++) {
          if (matchAt(SCHEME_AT_INDEX_REGEX, line, position)) {
            schemeStart = position;
            break;
          }
        }
        if (schemeStart !== -1) {
          out += line.slice(i, schemeStart);
          i = schemeStart;
          continue;
        }
      }
      out += line.slice(i, end);
      i = end;
      continue;
    }

    out += char;
    i += 1;
  }
  return { text: out, carry: carriedLabel };
}

interface TildeResult {
  text: string;
  carry: number | null;
}

/**
 * Replaces a lone `~` in prose with U+223C TILDE OPERATOR. OpenTUI's preview
 * and settled pass pair ASCII tildes as strikethrough delimiters differently,
 * so a line with several approximations (`~1, ~2, ~3`) loses different tildes
 * in each state; the operator character has no Markdown meaning and renders
 * the same approximation glyph. `~~` is left alone, and code spans,
 * fenced/indented code, link destinations and bare URLs are copied unchanged.
 */
const TILDE_OPERATOR = '\u223C';
const ASTERISK_OPERATOR = '\u2217';

function maskTildesOnLine(
  line: string,
  carriedCodeSpan: number | null = null,
): TildeResult {
  const destinations = linkDestinationRanges(line);
  let destinationIndex = 0;
  let out = '';
  let i = 0;
  let openCodeSpan = carriedCodeSpan;

  if (openCodeSpan !== null) {
    const close = closingBackticks(line, 0, openCodeSpan);
    if (close === null) return { text: line, carry: openCodeSpan };
    out += line.slice(0, close);
    i = close;
    openCodeSpan = null;
  }

  const inDestination = (index: number) => {
    while (
      destinationIndex < destinations.length &&
      destinations[destinationIndex][1] <= index
    ) {
      destinationIndex += 1;
    }
    return (
      destinationIndex < destinations.length &&
      destinations[destinationIndex][0] <= index
    );
  };

  while (i < line.length) {
    const char = line[i];

    if (char === '`' && !isEscaped(line, i)) {
      let end = i;
      while (end < line.length && line[end] === '`') end++;
      const runLength = end - i;
      const close = closingBackticks(line, end, runLength);
      if (close === null) {
        return { text: out + line.slice(i), carry: runLength };
      }
      out += line.slice(i, close);
      i = close;
      continue;
    }

    if (inDestination(i)) {
      out += char;
      i += 1;
      continue;
    }

    const scheme = matchAt(SCHEME_AT_INDEX_REGEX, line, i);
    if (scheme) {
      const end = findUrlEnd(line, i + scheme[1].length + 3);
      out += line.slice(i, end);
      i = end;
      continue;
    }

    if (char === '\\' && line[i + 1] === '~' && !isEscaped(line, i)) {
      out += TILDE_OPERATOR;
      i += 2;
      continue;
    }

    if (
      char === '~' &&
      !isEscaped(line, i) &&
      line[i - 1] !== '~' &&
      line[i + 1] !== '~'
    ) {
      const next = line[i + 1] ?? '';
      const previous = line[i - 1] ?? '';
      const homeOrUncPath = next === '/' || next === '\\';
      const semver = /\d/.test(next) && line[i + 2] === '.';
      const urlPath = previous === '/' || previous === '\\';
      if (!homeOrUncPath && !semver && !urlPath) {
        out += TILDE_OPERATOR;
        i += 1;
        continue;
      }
    }

    out += char;
    i += 1;
  }
  return { text: out, carry: null };
}

function maskLoneTildes(text: string, protectedRows: Set<number>): string {
  if (!text.includes('~')) return text;
  const lines = text.split('\n');
  const escaped: string[] = [];
  let fence: Fence | null = null;
  let indentedCode = false;
  let previousBlank = true;
  let carriedCodeSpan: number | null = null;
  let listColumn: number | null = null;

  for (const [index, line] of lines.entries()) {
    if (protectedRows.has(index)) {
      fence = null;
      indentedCode = false;
      carriedCodeSpan = null;
      previousBlank = true;
      escaped.push(line);
      continue;
    }
    if (fence) {
      const kind = fenceCloseKind(line, fence);
      if (kind !== null) fence = null;
      escaped.push(line);
      if (kind === 'close') previousBlank = true;
      else if (kind === null) previousBlank = false;
      continue;
    }

    const rest = containerOf(line).rest;
    const blank = rest.trim() === '';
    if (blank) carriedCodeSpan = null;
    const indent = indentationWidth(rest);

    if (!blank && !indentedCode) {
      const list = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)/.exec(rest);
      if (list) {
        const markerIndent = indentationWidth(list[1]);
        const markerSpaces = Math.max(1, list[3].replace(/\t/g, '    ').length);
        listColumn = markerIndent + list[2].length + markerSpaces;
      } else if (listColumn !== null && indent < listColumn) {
        listColumn = null;
      }
    }

    const codeIndent = (listColumn ?? 0) + 4;
    if (indentedCode) {
      if (!blank && indent < codeIndent) {
        indentedCode = false;
      } else {
        previousBlank = blank;
        escaped.push(line);
        continue;
      }
    } else if (!blank && indent >= codeIndent && previousBlank) {
      indentedCode = true;
      previousBlank = false;
      escaped.push(line);
      continue;
    }

    const next = fenceAtLineStart(line);
    if (next) {
      fence = next;
      carriedCodeSpan = null;
      previousBlank = false;
      escaped.push(line);
      continue;
    }

    const result = maskTildesOnLine(line, carriedCodeSpan);
    carriedCodeSpan = result.carry;
    previousBlank = blank;
    escaped.push(result.text);
  }
  return escaped.join('\n');
}

function maskStreamingText(text: string, protectedRows: Set<number>): string {
  const lines = text.split('\n');
  const masked: string[] = [];
  let fence: Fence | null = null;
  let indentedCode = false;
  // A document starts at a block boundary, and so does the line after a
  // closing fence: indented code there must not be masked.
  let previousBlank = true;
  let carriedCodeSpan: number | null = null;
  let listColumn: number | null = null;
  let table = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (protectedRows.has(index)) {
      fence = null;
      indentedCode = false;
      table = false;
      carriedCodeSpan = null;
      previousBlank = true;
      masked.push(line);
      continue;
    }

    if (fence) {
      const kind = fenceCloseKind(line, fence);
      if (kind === 'close') {
        fence = null;
        previousBlank = true;
        masked.push(line);
        continue;
      }
      if (kind === null) {
        previousBlank = false;
        masked.push(line);
        continue;
      }
      // The blockquote ended without a marker: process this line as prose.
      fence = null;
    }

    const rest = containerOf(line).rest;
    const blank = rest.trim() === '';
    if (blank) carriedCodeSpan = null;
    const indent = indentationWidth(rest);

    if (table) {
      if (blank || !line.includes('|')) {
        table = false;
      } else {
        masked.push(line);
        previousBlank = false;
        continue;
      }
    }

    // Track a list's content column so a continuation paragraph indented by
    // four columns is prose (and masked), while code indented four columns
    // past the list content is indented code (and skipped).
    if (!blank && !indentedCode) {
      const list = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)/.exec(rest);
      if (list) {
        const markerIndent = indentationWidth(list[1]);
        const markerSpaces = Math.max(1, list[3].replace(/\t/g, '    ').length);
        listColumn = markerIndent + list[2].length + markerSpaces;
      } else if (listColumn !== null && indent < listColumn) {
        listColumn = null;
      }
    }

    const codeIndent = (listColumn ?? 0) + 4;
    if (indentedCode) {
      if (!blank && indent < codeIndent) {
        indentedCode = false;
      } else {
        previousBlank = blank;
        masked.push(line);
        continue;
      }
    } else if (!blank && indent >= codeIndent && previousBlank) {
      indentedCode = true;
      previousBlank = false;
      masked.push(line);
      continue;
    }

    const next = fenceAtLineStart(line);
    if (next) {
      fence = next;
      carriedCodeSpan = null;
      previousBlank = false;
      masked.push(line);
      continue;
    }

    // A GFM table cell is rendered through the inline renderer in BOTH the
    // streaming preview and the settled pass, so it already shows
    // `url (href)`; masking its URL would make the table shift at settle.
    // Pass the header, delimiter and rows through unchanged.
    if (line.includes('|') && isTableDelimiter(lines[index + 1] ?? '')) {
      table = true;
      masked.push(line);
      if (index + 1 < lines.length) {
        masked.push(lines[index + 1]);
        index += 1;
      }
      previousBlank = false;
      continue;
    }

    const result = maskAutolinksInProse(
      stripHeadingMarkers(line),
      carriedCodeSpan,
    );
    carriedCodeSpan = result.carry;
    previousBlank = blank;
    masked.push(result.text);
  }
  return masked.join('\n');
}

/** GFM table delimiter row (`| --- | :---: |`). */
function isTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
  return /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$/.test(trimmed);
}

/**
 * CommonMark line endings are CRLF and lone CR, but the settled render path
 * strips bare CR before rendering (`sanitizeTerminalText`); dropping it here
 * too keeps the streaming frame from showing a row that disappears at settle.
 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '');
}

/**
 * remend closes an unmatched `*` by appending one at the paragraph tail. In
 * C++ prose that `*` is a pointer (`const char*`), not emphasis, so the
 * preview grows one character the settled raw text never had. Remove only
 * that appended close; a real emphasis opener starts at a boundary and keeps
 * its healed close.
 */
function stripFalseEmphasisClose(source: string, healed: string): string {
  if (healed.endsWith('__') && !source.endsWith('__')) {
    const first = source.indexOf('__');
    if (
      first !== -1 &&
      (first === 0 || /\s/.test(source[first - 1])) &&
      source.indexOf('__', first + 2) === -1
    ) {
      return healed.slice(0, -2);
    }
  }
  for (const marker of ['*', '_']) {
    if (!healed.endsWith(marker) || healed.endsWith(marker + marker)) continue;
    if (source.endsWith(marker)) continue;
    const last = source.lastIndexOf(marker);
    if (last === -1) continue;
    if (last === 0) {
      const rest = source.slice(1);
      if (/^[A-Za-z_][A-Za-z0-9_]*\s*(?:=|;|->|\[|\))/.test(rest)) {
        return healed.slice(0, -1);
      }
      continue;
    }
    if (!/[A-Za-z0-9_>)\]:`]/.test(source[last - 1] ?? '')) continue;
    return healed.slice(0, -1);
  }
  return healed;
}

export function healStreamingMarkdown(text: string): string {
  // Keep C++ templates: remend's htmlTags handler strips `<int, ...`
  // while the angle bracket is still streaming.
  const normalized = normalizeLineEndings(text);
  const analysis = analyzeMarkdown(normalized);
  const prepared = maskLiteralBackticks(
    maskProsePunctuation(
      maskLoneTildes(normalized, analysis.protectedRows),
      analysis.protectedRows,
    ),
    analysis,
  );
  const healed = stripFalseEmphasisClose(
    prepared,
    remend(prepared, {
      linkMode: 'text-only',
      htmlTags: false,
      // OpenTUI's preview leaves unmatched backticks and strikethrough
      // markers literal instead of styling the tail; completing them would
      // hide the markers and style text the settled pass renders literally.
      inlineCode: false,
      strikethrough: false,
      singleTilde: false,
    }),
  );
  return maskStreamingText(healed, analysis.protectedRows);
}

/**
 * Render content for a streaming message: while streaming, heal the raw text
 * (unclosed markers render as styled text instead of flipping between
 * literal markers and rendered styles frame to frame; the tail's bare
 * autolinks and ATX markers are masked so OpenTUI's preview and highlight
 * agree); once settled, the message on disk is the truth and the raw text
 * renders as-is, apart from rendering-only line-ending normalization and
 * replacing a lone `~` with the non-delimiter tilde operator so the two
 * states agree on the same visible approximation marker.
 */
export function streamingMarkdownForRender(
  text: string,
  streaming: boolean,
): string {
  const normalized = normalizeLineEndings(text);
  if (!streaming) {
    if (
      !normalized.includes('`') &&
      !normalized.includes('~') &&
      !normalized.includes('\\') &&
      !normalized.includes('*')
    ) {
      return normalized;
    }
    const analysis = analyzeMarkdown(normalized);
    return maskLiteralBackticks(
      maskProsePunctuation(
        maskLoneTildes(normalized, analysis.protectedRows),
        analysis.protectedRows,
      ),
      analysis,
    );
  }
  return healStreamingMarkdown(normalized);
}
