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
 * eligibility, blockquote prefixes and codespan runs by hand. Each rule was a
 * separate approximation of CommonMark, each drifted from the renderer that
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

function lex(text: string): Token[] {
  return marked.lexer(text) as Token[];
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
 * A blockquote's children are lexed from the quote-stripped body, so their
 * offsets are not a shift of the parent's. The strip removes only a per-line
 * prefix and preserves the line count, so child line `i` is a suffix of parent
 * line `i` — enough to map every child offset back exactly.
 */
function blockquoteMap(
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
    const children = (token as { tokens?: Token[] }).tokens;
    if (!children?.length) continue;
    if (token.type === 'blockquote') {
      markCode(
        children,
        blockquoteMap(raw, map(start), childRawOf(token)),
        codeFlags,
      );
      continue;
    }
    markCode(children, (offset) => map(start + offset), codeFlags);
  }
}

/**
 * `text` with every code region replaced by spaces, preserving length and
 * newlines so offsets found in the result index the source directly.
 */
export function maskCode(text: string): string {
  if (!text) return text;
  const { text: normalised, toSource } = normalise(text);
  const flags = new Array<boolean>(normalised.length).fill(false);
  markCode(lex(normalised), (offset) => offset, flags);

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

const FENCE_OPENER = /^ {0,3}(`{3,}|~{3,})/u;
const FENCE_CLOSER = /^ {0,3}(`+|~+)[\t ]*$/u;

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

/** A fence left open by a cut, and whether it sits inside a blockquote. */
export interface OpenFence {
  delimiter: string;
  quoted: boolean;
}

function trailingOpenFence(
  tokens: Token[],
  quoted: boolean,
): OpenFence | undefined {
  const last = tokens[tokens.length - 1];
  if (!last) return undefined;
  if (last.type === 'code') {
    const delimiter = unclosedFenceDelimiter(last.raw ?? '');
    return delimiter ? { delimiter, quoted } : undefined;
  }
  if (last.type === 'blockquote') {
    const children = (last as { tokens?: Token[] }).tokens ?? [];
    return trailingOpenFence(children, true);
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
  return trailingOpenFence(lex(normalised), false);
}
