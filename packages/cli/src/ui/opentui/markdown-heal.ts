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
 * TODO: remove this mask when @opentui/core is upgraded to 0.8.4 or newer.
 * 0.5.10's streaming preview expands a GFM autolink into `label (href)`;
 * for a bare URL the label *is* the URL, so the tail doubles in width until
 * the tree-sitter pass replaces the preview. 0.8.4 suppresses the suffix
 * when the label equals the href. Breaking the autolink with a zero-width
 * space keeps both passes rendering identical characters; once streaming
 * settles the raw text (no mask) renders the real link.
 */
const ZERO_WIDTH_SPACE = '\u200B';
// Container prefixes (blockquotes) and continuation indentation can push a
// fence past column 3; treating it as a fence is safer than masking code.
const FENCE_PREFIX_REGEX = /^(?:[ \t]*>[ \t]?)*[ \t]*/;
const FENCE_MARKER_REGEX = /^(`{3,}|~{3,})(.*)$/;

interface Fence {
  char: string;
  length: number;
}

function fenceParts(line: string): { marker: string; rest: string } | null {
  const prefix = FENCE_PREFIX_REGEX.exec(line)?.[0] ?? '';
  const match = FENCE_MARKER_REGEX.exec(line.slice(prefix.length));
  return match ? { marker: match[1], rest: match[2] } : null;
}

function fenceAtLineStart(line: string): Fence | null {
  const parts = fenceParts(line);
  if (!parts) return null;
  return { char: parts.marker[0], length: parts.marker.length };
}

function isFenceClose(line: string, fence: Fence): boolean {
  const parts = fenceParts(line);
  return (
    parts !== null &&
    parts.marker[0] === fence.char &&
    parts.marker.length >= fence.length &&
    parts.rest.trim() === ''
  );
}

/**
 * Offset where the trailing blocks that still need the mask start. OpenTUI
 * re-parses the last two top-level tokens (spaces included), so a block that
 * just stopped streaming can still be re-rendered with its raw text once;
 * keeping the mask across the last three blocks avoids that one-frame flash.
 * Earlier blocks are stable and keep their real markup.
 */
const MASKED_TRAILING_BLOCKS = 3;

function trailingBlocksStart(text: string): number {
  const lines = text.split('\n');
  const starts = [0];
  let offset = 0;
  let fence: Fence | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const following = lines[index + 1];
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
    } else {
      const next = fenceAtLineStart(line);
      if (next) {
        fence = next;
      } else if (
        line.trim() === '' &&
        following !== undefined &&
        following.trim() !== ''
      ) {
        const nextStart = offset + line.length + 1;
        if (nextStart > starts[starts.length - 1]) starts.push(nextStart);
      }
    }
    offset += line.length + 1;
  }
  return starts[Math.max(0, starts.length - MASKED_TRAILING_BLOCKS)];
}

/** Character ranges covered by inline code spans on one line. */
function codeSpanRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let from = 0;
  while (from < line.length) {
    if (line[from] !== '`') {
      from++;
      continue;
    }
    let end = from;
    while (end < line.length && line[end] === '`') end++;
    const close = closingBackticks(line, end, end - from);
    if (close === null) {
      from = end;
      continue;
    }
    ranges.push([from, close]);
    from = close;
  }
  return ranges;
}

/**
 * Character ranges inside `](…)` on one line. Nothing in a link destination
 * is autolinked text, so the mask must not touch it. A `](` inside an inline
 * code span is literal text, not a destination opener.
 */
function linkDestinationRanges(line: string): Array<[number, number]> {
  const codeSpans = codeSpanRanges(line);
  const ranges: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const open = line.indexOf('](', from);
    if (open === -1) break;
    if (codeSpans.some(([start, end]) => open >= start && open < end)) {
      from = open + 2;
      continue;
    }
    let start = open + 2;
    if (line[start] === '<') start++;
    const close = line.indexOf(')', start);
    const end = close === -1 ? line.length : close;
    ranges.push([start, end]);
    from = end + 1;
  }
  return ranges;
}

/** Index just past a matching backtick run, or null when the span is unclosed. */
function closingBackticks(line: string, from: number, length: number) {
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

const SCHEME_AT_INDEX_REGEX = /(https?):\/\//y;
const WWW_AT_INDEX_REGEX = /www\./y;
const EMAIL_AT_INDEX_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/y;

function matchAt(regex: RegExp, line: string, index: number) {
  regex.lastIndex = index;
  return regex.exec(line);
}

function maskAutolinksInProse(line: string): string {
  const destinations = linkDestinationRanges(line);
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '`') {
      let end = i;
      while (end < line.length && line[end] === '`') end++;
      const runLength = end - i;
      const close = closingBackticks(line, end, runLength);
      if (close === null) {
        out += line.slice(i, end);
        i = end;
      } else {
        out += line.slice(i, close);
        i = close;
      }
      continue;
    }

    const inLinkDestination = destinations.some(
      ([start, end]) => i >= start && i < end,
    );
    if (!inLinkDestination) {
      // `<std::string>` is C++ here, but the preview lexer reads it as an
      // autolink and expands it to `std::string (std::string)`, shifting the
      // rest of the line until the tree-sitter pass replaces it.
      if (
        line[i] === '<' &&
        line[i - 1] !== '\\' &&
        /[A-Za-z_:]/.test(line[i + 1] ?? '') &&
        !line.startsWith('http://', i + 1) &&
        !line.startsWith('https://', i + 1)
      ) {
        const close = line.indexOf('>', i + 1);
        if (close !== -1) {
          out += `<${ZERO_WIDTH_SPACE}`;
          i++;
          continue;
        }
      }
      // `[expr.add]` is a C++ spec reference, but the settled renderer
      // conceals the brackets as a shortcut link while the preview shows
      // them — a two-column shift for every later word. Strip them while
      // streaming; the raw text returns at settle. Skip array indexing
      // (`a[0]`) by requiring a boundary before the bracket.
      if (line[i] === '[' && (i === 0 || /[\s(,;:]/.test(line[i - 1]))) {
        const close = line.indexOf(']', i + 1);
        const after = close === -1 ? '' : line[close + 1];
        const label = close === -1 ? '' : line.slice(i + 1, close);
        const atLineStart = line.slice(0, i).trim() === '';
        if (
          after !== '(' &&
          after !== '[' &&
          !(after === ':' && atLineStart) &&
          label.length > 0 &&
          label.length < 80 &&
          !label.startsWith('^') &&
          /^[A-Za-z0-9_.:/+\- ]+$/.test(label)
        ) {
          out += label;
          i = close + 1;
          continue;
        }
      }
      const scheme = matchAt(SCHEME_AT_INDEX_REGEX, line, i);
      if (scheme) {
        out += `${scheme[1]}${ZERO_WIDTH_SPACE}://`;
        i += scheme[1].length + 3;
        continue;
      }
      const www = matchAt(WWW_AT_INDEX_REGEX, line, i);
      if (www && line.slice(i - 3, i) !== '://') {
        out += `www${ZERO_WIDTH_SPACE}.`;
        i += 4;
        continue;
      }
      const email = matchAt(EMAIL_AT_INDEX_REGEX, line, i);
      if (email) {
        const at = email[0].indexOf('@');
        out += `${email[0].slice(0, at)}${ZERO_WIDTH_SPACE}${email[0].slice(at)}`;
        i += email[0].length;
        continue;
      }
    }

    out += line[i];
    i++;
  }
  return out;
}

function maskTrailingAutolinks(text: string): string {
  const tailStart = trailingBlocksStart(text);
  const lines = text.slice(tailStart).split('\n');
  let fence: Fence | null = null;
  const masked = lines.map((line) => {
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
      return line;
    }
    const next = fenceAtLineStart(line);
    if (next) {
      fence = next;
      return line;
    }
    return maskAutolinksInProse(line);
  });
  return text.slice(0, tailStart) + masked.join('\n');
}

export function healStreamingMarkdown(text: string): string {
  // CommonMark accepts CRLF and lone CR; normalize once so the fence and
  // offset arithmetic below can assume one-character separators.
  const normalized = text.replace(/\r\n?/g, '\n');
  // Keep C++ templates: remend's htmlTags handler strips `<int, ...`
  // while the angle bracket is still streaming.
  const healed = remend(normalized, {
    linkMode: 'text-only',
    htmlTags: false,
  });
  return maskTrailingAutolinks(healed);
}

/**
 * Split streaming markdown into top-level blocks on blank lines, keeping
 * fenced code intact. Rendering each completed block as its own markdown
 * keeps an append from re-rasterizing everything above the tail.
 */
export function splitMarkdownBlocks(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: Fence | null = null;
  const flush = () => {
    while (current.length > 0 && current[current.length - 1].trim() === '') {
      current.pop();
    }
    if (current.length > 0) blocks.push(current.join('\n'));
    current = [];
  };
  for (const line of normalized.split('\n')) {
    if (fence) {
      current.push(line);
      if (isFenceClose(line, fence)) fence = null;
      continue;
    }
    const next = fenceAtLineStart(line);
    if (next) {
      fence = next;
      current.push(line);
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

/**
 * Render content for a streaming message: while streaming, heal the raw text
 * (unclosed markers render as styled text instead of flipping between
 * literal markers and rendered styles frame to frame; the tail's bare
 * autolinks are masked so OpenTUI's preview and highlight agree); once
 * settled, the message on disk is the truth and the raw text renders as-is.
 */
export function streamingMarkdownForRender(
  text: string,
  streaming: boolean,
): string {
  return streaming ? healStreamingMarkdown(text) : text;
}
