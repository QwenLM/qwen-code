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
 * tail always renders as markdown; when streaming settles the raw text is
 * rendered as-is (the message on disk is the truth).
 */
import remend from 'remend';

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
): { marker: string; length: number; rest: string; quoteDepth: number } | null {
  const { quoteDepth, rest } = containerOf(line);
  let body = rest;
  if (allowListMarker) {
    const list = LIST_MARKER_PREFIX_REGEX.exec(body);
    if (list) body = body.slice(list[0].length);
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
  };
}

function fenceAtLineStart(line: string): Fence | null {
  const parts = fenceParts(line, true);
  return parts
    ? { char: parts.marker, length: parts.length, quoteDepth: parts.quoteDepth }
    : null;
}

function isFenceClose(line: string, fence: Fence): boolean {
  const parts = fenceParts(line, false);
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
  const list = LIST_MARKER_PREFIX_REGEX.exec(rest);
  const marker = list ? list[0] : '';
  const body = list ? rest.slice(marker.length) : rest;
  const match = /^( {0,3})(#{1,6})[ \t]+(.*?)(?:[ \t]+#+[ \t]*)?$/.exec(body);
  if (!match) return line;
  return `${prefix}${marker}${match[1]}${match[3]}`;
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
  let from = 0;
  const inCodeSpan = (index: number) =>
    codeSpans.some(([start, end]) => index >= start && index < end);
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
      let depth = 0;
      for (let i = start; i < line.length; i++) {
        if (line[i] === '(') {
          depth += 1;
        } else if (line[i] === ')') {
          if (depth === 0) {
            end = i;
            break;
          }
          depth -= 1;
        }
      }
    }
    if (end === -1) {
      // No `)` remains on this line: no later `](` can close either, so stop
      // instead of rescanning the tail for every unmatched pair.
      if (line.indexOf(')', start) === -1) break;
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
// the surrounding markup is not swallowed.
const URL_END_REGEX = /[\s<>"'`)\]},;*~_。，、；：！？）】」』》]/;

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
      const close = line.indexOf(']', i + 1);
      if (close !== -1) {
        const after = line[close + 1] ?? '';
        const label = line.slice(i + 1, close);
        // A full reference link (`[text][label]`, including C-style
        // `arr[i][j]`) is concealed to its visible label by the settled
        // renderer, so streaming drops both bracket pairs too.
        if (after === '[') {
          const secondClose = line.indexOf(']', close + 2);
          if (secondClose !== -1 && !label.startsWith('^')) {
            // The settled renderer conceals both bracket pairs of a
            // reference link (and C-style `arr[i][j]`); keep only the
            // visible label while streaming.
            out += maskAutolinksInProse(label).text;
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
          out += maskAutolinksInProse(label).text;
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
      let end = i + scheme[1].length + 3;
      while (end < line.length && !URL_END_REGEX.test(line[end])) end++;
      const url = line.slice(i, end);
      const inAngle = line[i - 1] === '<' || line[end] === '>';
      const nearBacktick =
        line[i - 1] === '`' || line[end] === '`' || url.includes('`');
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
  return { text: out, carry: null };
}

function maskStreamingText(text: string): string {
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
    if (!blank) {
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
  return /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?$/.test(trimmed);
}

/**
 * CommonMark line endings are CRLF and lone CR, but the settled render path
 * strips bare CR before rendering (`sanitizeTerminalText`); dropping it here
 * too keeps the streaming frame from showing a row that disappears at settle.
 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '');
}

export function healStreamingMarkdown(text: string): string {
  // Keep C++ templates: remend's htmlTags handler strips `<int, ...`
  // while the angle bracket is still streaming.
  const healed = remend(normalizeLineEndings(text), {
    linkMode: 'text-only',
    htmlTags: false,
  });
  return maskStreamingText(healed);
}

/**
 * Render content for a streaming message: while streaming, heal the raw text
 * (unclosed markers render as styled text instead of flipping between
 * literal markers and rendered styles frame to frame; the tail's bare
 * autolinks and ATX markers are masked so OpenTUI's preview and highlight
 * agree); once settled, the message on disk is the truth and the raw text
 * renders as-is, apart from rendering-only line-ending normalization that
 * keeps both frames identical.
 */
export function streamingMarkdownForRender(
  text: string,
  streaming: boolean,
): string {
  const normalized = normalizeLineEndings(text);
  return streaming ? healStreamingMarkdown(normalized) : normalized;
}
