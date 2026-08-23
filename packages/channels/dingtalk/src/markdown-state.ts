/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { marked, type Token } from 'marked';

/**
 * Markdown state for the outbound marker machinery, derived from a real
 * CommonMark parser instead of hand-rolled line scanning.
 *
 * Two questions are asked of a message before it is streamed to a card:
 *
 * - which byte ranges are code, so a `[FILE: …]` written inside a fence or a
 *   codespan is shown rather than delivered ({@link maskCode}); and
 * - whether a truncation point sits inside an unclosed fence, so the retained
 *   tail can re-open it and keep fence parity ({@link openFenceAt}).
 *
 * Both used to be answered by re-deriving fence pairing, indented-code
 * eligibility, blockquote prefixes and codespan runs by hand. Each rule was
 * a separate approximation of CommonMark, each drifted from the renderer that
 * ultimately displays the text, and every drift leaked an absolute path or
 * swallowed a real marker. `marked` already implements the grammar and is
 * already a dependency of `@qwen-code/core`, so these ask it instead.
 */

/** A parser-normalised copy of the source plus a map back to source offsets. */
interface NormalisedText {
  text: string;
  /**
   * `toSource[i]` is the source offset the normalised character at `i` came
   * from. `toSource[text.length]` is the source length, so a normalised range
   * end maps to a source range end.
   */
  toSource: number[];
}

/**
 * `marked` rewrites `\r\n` and lone `\r` to `\n` before lexing, so token
 * offsets accumulated from `raw` are normalised offsets, not source ones.
 * Recording where each normalised character came from keeps every range this
 * module returns expressed in source coordinates.
 */
function normalise(source: string): NormalisedText {
  const out: string[] = [];
  const toSource: number[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (char === '\r') {
      out.push('\n');
      toSource.push(i);
      i += source[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    out.push(char);
    toSource.push(i);
    i++;
  }
  toSource.push(source.length);
  return { text: out.join(''), toSource };
}

/**
 * R14-1: `marked.lexer` recurses per blockquote-nesting level, and a deep
 * `> > > …` run throws `RangeError: Maximum call stack size exceeded` from
 * a few thousand characters of ordinary (or prompt-injected) model output —
 * well inside CONTENT_LIMIT. Callers fail in the documented safe direction
 * on `undefined` instead of letting the throw take down the card flush or
 * the final-answer preparation.
 */
function lex(text: string): Token[] | undefined {
  try {
    return marked.lexer(text) as Token[];
  } catch {
    return undefined;
  }
}

/** Line starts and bodies (newline excluded) of `text`. */
function lines(text: string): Array<{ start: number; length: number }> {
  const out: Array<{ start: number; length: number }> = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    out.push({ start, length: end - start });
    if (newline === -1) break;
    start = newline + 1;
  }
  return out;
}

/** Maps an offset inside a token list onto an absolute normalised offset. */
type OffsetMap = (offset: number) => number;

/**
 * A blockquote's children are lexed from the quote-stripped body, and a list
 * item's children from the bullet- and indent-stripped body, so their offsets
 * are not a shift of the parent's. The strip removes only a per-line prefix
 * and preserves the line count, so child line `i` is a suffix of parent line
 * `i` — enough to map every child offset back exactly.
 */
function suffixMap(
  parentRaw: string,
  parentStart: number,
  childRaw: string,
): OffsetMap {
  const parentLines = lines(parentRaw);
  const childLines = lines(childRaw);
  return (offset) => {
    let index = 0;
    while (
      index + 1 < childLines.length &&
      childLines[index + 1].start <= offset
    ) {
      index++;
    }
    const child = childLines[index];
    const parent = parentLines[index];
    if (!child || !parent) return parentStart + parentRaw.length;
    const indent = Math.max(0, parent.length - child.length);
    return parentStart + parent.start + indent + (offset - child.start);
  };
}

function childRawOf(token: Token): string {
  const children = (token as { tokens?: Token[] }).tokens ?? [];
  return children.map((child) => child.raw ?? '').join('');
}

/**
 * Marks every normalised offset covered by a fenced block, an indented block
 * or an inline codespan. Fence and codespan delimiters are marked with the
 * body they enclose, matching what the delimiters hide from a reader.
 *
 * R19-x (R6-3 closure): the descent follows marked v15's REAL token shapes —
 * list items live on `.items`, table cells on `.header`/`.rows`, and inline
 * children of headings/emphasis/links start AFTER the token's own prefix or
 * delimiters. A blind shift of the parent's start misplaces every mask those
 * tokens carry; each container maps its children with the exact strip the
 * lexer applied.
 */
function markCode(tokens: Token[], map: OffsetMap, codeFlags: boolean[]): void {
  let cursor = 0;
  for (const token of tokens) {
    const raw = token.raw ?? '';
    const start = cursor;
    cursor += raw.length;
    if (token.type === 'code' || token.type === 'codespan') {
      // R1-9: CommonMark lets a codespan span lines; this masker deliberately
      // does not follow it there. Masking hides a marker from the finder, and
      // a hidden marker is neither delivered NOR stripped — it ships to the
      // card as literal text, absolute path and all. A span that closes on its
      // own line is an unambiguous "show this verbatim"; one that swallows a
      // later line is far more often an unclosed backtick in prose, so the
      // fail-safe reading is to leave the marker visible to the finder.
      if (token.type === 'codespan' && raw.includes('\n')) continue;
      const from = map(start);
      const to = map(start + raw.length);
      for (let i = from; i < to; i++) codeFlags[i] = true;
      continue;
    }
    if (token.type === 'list') {
      const items = (token as { items?: Token[] }).items ?? [];
      let itemCursor = 0;
      for (const item of items) {
        const itemRaw = item.raw ?? '';
        const found = Math.max(0, raw.indexOf(itemRaw, itemCursor));
        itemCursor = found + itemRaw.length;
        const children = (item as { tokens?: Token[] }).tokens ?? [];
        if (children.length > 0) {
          markCode(
            children,
            suffixMap(itemRaw, map(start + found), childRawOf(item)),
            codeFlags,
          );
        }
      }
      continue;
    }
    if (token.type === 'table') {
      markTableCells(token, map(start), raw, codeFlags);
      continue;
    }
    const children = (token as { tokens?: Token[] }).tokens;
    if (!children?.length) continue;
    if (token.type === 'blockquote') {
      markCode(
        children,
        suffixMap(raw, map(start), childRawOf(token)),
        codeFlags,
      );
      continue;
    }
    // Inline children are lexed from the token's own content — after a
    // heading's `#…` prefix, an emphasis delimiter, a link's `[`. Locate that
    // content inside the raw instead of assuming it starts at offset 0.
    const joined = children.map((child) => child.raw ?? '').join('');
    const contentStart = Math.max(0, raw.indexOf(joined));
    markCode(
      children,
      (offset) => map(start + contentStart + offset),
      codeFlags,
    );
  }
}

/**
 * Table cells are lexed from their pipe-stripped text, so a cell's offsets
 * map into the table raw at the cell's own position. Cells appear in reading
 * order (header left-to-right, then rows), so each cell's joined content is
 * found at or after the previous cell's end.
 */
function markTableCells(
  token: Token,
  tableStart: number,
  tableRaw: string,
  codeFlags: boolean[],
): void {
  const table = token as {
    header?: Array<{ tokens?: Token[] }>;
    rows?: Array<Array<{ tokens?: Token[] }>>;
  };
  const cells = [...(table.header ?? []), ...(table.rows ?? []).flat()];
  let cursor = 0;
  for (const cell of cells) {
    const children = cell.tokens ?? [];
    if (children.length === 0) continue;
    const joined = children.map((child) => child.raw ?? '').join('');
    const found = tableRaw.indexOf(joined, cursor);
    if (found === -1) return;
    cursor = found + joined.length;
    markCode(
      children as Token[],
      (offset) => tableStart + found + offset,
      codeFlags,
    );
  }
}

/**
 * `text` with every code region replaced by spaces, preserving length and
 * newlines so offsets found in the result index the source directly.
 */
export function maskCode(text: string): string {
  if (!text) return text;
  const { text: normalised, toSource } = normalise(text);
  const tokens = lex(normalised);
  // R14-1: on lexer overflow return the text UNCHANGED — markers stay
  // visible to the finder, the R1-9 fail-safe direction (a quoted file may
  // be delivered, but no path ships as literal text and the flush survives).
  if (!tokens) return text;
  const flags = new Array<boolean>(normalised.length).fill(false);
  markCode(tokens, (offset) => offset, flags);

  const masked = text.split('');
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i]) continue;
    const from = toSource[i];
    const to = toSource[i + 1];
    for (let j = from; j < to; j++) {
      if (masked[j] !== '\n') masked[j] = ' ';
    }
  }
  return masked.join('');
}

/**
 * marked v15's closing-fence rule, mirrored exactly: same delimiter character
 * as the opener, at least as long, and nothing but spaces after it — a
 * trailing tab or any other text keeps the fence OPEN (probed against
 * `marked.lexer` directly). The previous closer accepted tabs, so a fence the
 * renderer keeps open read as closed here and every code region after it lost
 * its masking.
 */
const FENCE_OPENER = /^ {0,3}(`{3,}|~{3,})/u;
const FENCE_CLOSER = /^ {0,3}(`+|~+) *$/u;

/** The delimiter of a fenced token that never closed, else undefined. */
function unclosedFenceDelimiter(raw: string): string | undefined {
  const opener = FENCE_OPENER.exec(raw)?.[1];
  if (!opener) return undefined;
  const body = lines(raw).slice(1);
  for (const line of body) {
    const closer = FENCE_CLOSER.exec(
      raw.slice(line.start, line.start + line.length),
    )?.[1];
    if (closer && closer[0] === opener[0] && closer.length >= opener.length) {
      return undefined;
    }
  }
  return opener;
}

/** A fence left open by a cut, and how deep it sits inside blockquotes. */
export interface OpenFence {
  delimiter: string;
  /** Number of enclosing blockquote levels (0 = unquoted). */
  quoteDepth: number;
}

function trailingOpenFence(
  tokens: Token[],
  quoteDepth: number,
): OpenFence | undefined {
  const last = tokens[tokens.length - 1];
  if (!last) return undefined;
  if (last.type === 'code') {
    const delimiter = unclosedFenceDelimiter(last.raw ?? '');
    return delimiter ? { delimiter, quoteDepth } : undefined;
  }
  if (last.type === 'blockquote') {
    const children = (last as { tokens?: Token[] }).tokens ?? [];
    return trailingOpenFence(children, quoteDepth + 1);
  }
  return undefined;
}

/**
 * The fence delimiter open at `offset`, or undefined outside a fenced block.
 *
 * A retained tail that begins inside a fenced block has inverted fence parity:
 * the block's CLOSING fence reads as an opening one, so real code stops being
 * masked while real prose starts being masked and a genuine `[FILE: /abs]`
 * outside any block survives sanitisation as literal text. The question is
 * asked of the PREFIX, which is exactly what the parser is handed.
 */
export function openFenceAt(
  text: string,
  offset: number,
): OpenFence | undefined {
  if (offset <= 0) return undefined;
  const prefix = text.slice(0, offset);
  const { text: normalised } = normalise(prefix);
  // R14-1: on lexer overflow fall back to the pre-diff raw cut — no
  // re-opener — instead of throwing.
  const tokens = lex(normalised);
  if (!tokens) return undefined;
  return trailingOpenFence(tokens, 0);
}
