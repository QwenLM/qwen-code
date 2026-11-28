/**
 * SGR text tokenizer — converts an ANSI-styled string into a stream of
 * character and escape-sequence tokens, then builds a StyledLine from them.
 *
 * Ported from @jrichman/ink@6.6.7 build/tokenize.js to standalone TypeScript.
 * Origin licence: MIT (Copyright (c) Vadym Demedes <vadimdemedes@hey.com>)
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 *
 * Note: This is the *render-side* tokenizer (styled text → StyledLine).
 *       It is entirely separate from packages/cli/src/ink/termio/tokenize.ts
 *       which handles *input-side* keyboard escape sequences.
 */

import { eastAsianWidth } from 'get-east-asian-width';
import {
  CC_ESC,
  CC_OSC,
  CC_CSI,
  CC_BEL,
  CC_C1_ST,
  CC_BACKSLASH,
  CC_0,
  CC_9,
  CC_SEMI,
  CC_M,
  ESCAPES,
  linkCodePrefix,
  linkCodePrefixCharCodes,
  linkEndCode,
  linkEndCodeST,
  linkEndCodeC1ST,
  getEndCode,
  SGR,
  BOLD_MASK,
  DIM_MASK,
  ITALIC_MASK,
  UNDERLINE_MASK,
  STRIKETHROUGH_MASK,
  INVERSE_MASK,
  HIDDEN_MASK,
  FULL_WIDTH_MASK,
} from './ansi-constants.js';
import { StyledLine } from './styled-line.js';

// ── Inline isFullwidthCodePoint (avoids dep on is-fullwidth-code-point pkg) ──
function isFullwidthCodePoint(codePoint: number): boolean {
  if (!Number.isInteger(codePoint)) return false;
  return eastAsianWidth(codePoint) === 2;
}

// ── Token types ───────────────────────────────────────────────────────────────

interface AnsiToken {
  type: 'ansi';
  code: string;
  endCode: string;
}

interface ControlToken {
  type: 'control';
  code: string;
}

interface CharToken {
  type: 'char';
  value: string;
  fullWidth: boolean;
}

type Token = AnsiToken | ControlToken | CharToken;

// ── OSC / SGR parsers ────────────────────────────────────────────────────────

function findOSCTerminatorIndex(string: string, startIndex: number): number {
  for (let i = startIndex; i < string.length; i++) {
    const ch = string.charCodeAt(i);
    if (ch === CC_BEL) return i;
    if (ch === CC_C1_ST) return i;
    if (
      ch === CC_ESC &&
      i + 1 < string.length &&
      string.charCodeAt(i + 1) === CC_BACKSLASH
    )
      return i + 1;
  }
  return -1;
}

function parseLinkCode(string: string, offset: number): string | undefined {
  string = string.slice(offset);
  for (let index = 1; index < linkCodePrefixCharCodes.length; index++) {
    if (string.charCodeAt(index) !== linkCodePrefixCharCodes[index])
      return undefined;
  }
  const paramsEndIndex = string.indexOf(';', linkCodePrefix.length);
  if (paramsEndIndex === -1) return undefined;
  const endIndex = findOSCTerminatorIndex(string, paramsEndIndex + 1);
  if (endIndex === -1) return undefined;
  return string.slice(0, endIndex + 1);
}

function parseOSCSequence(string: string, offset: number): string | undefined {
  string = string.slice(offset);
  const endIndex = findOSCTerminatorIndex(string, 2);
  if (endIndex === -1) return undefined;
  return string.slice(0, endIndex + 1);
}

function findSGRSequenceEndIndex(str: string): number {
  for (let index = 2; index < str.length; index++) {
    const charCode = str.charCodeAt(index);
    if (charCode === CC_M) return index;
    if (charCode === CC_SEMI) continue;
    if (charCode >= CC_0 && charCode <= CC_9) continue;
    break;
  }
  return -1;
}

function parseSGRSequence(string: string, offset: number): string | undefined {
  string = string.slice(offset);
  const endIndex = findSGRSequenceEndIndex(string);
  if (endIndex === -1) return undefined;
  return string.slice(0, endIndex + 1);
}

function splitCompoundSGRSequences(code: string): string[] {
  if (!code.includes(';')) return [code];
  const codeParts = code.slice(2, -1).split(';');
  const ret: string[] = [];
  for (let i = 0; i < codeParts.length; i++) {
    const rawCode = codeParts[i]!;
    if (rawCode === '38' || rawCode === '48') {
      if (i + 2 < codeParts.length && codeParts[i + 1] === '5') {
        ret.push(codeParts.slice(i, i + 3).join(';'));
        i += 2;
        continue;
      } else if (i + 4 < codeParts.length && codeParts[i + 1] === '2') {
        ret.push(codeParts.slice(i, i + 5).join(';'));
        i += 4;
        continue;
      }
    }
    ret.push(rawCode);
  }
  return ret.map((part) => `\u001B[${part}m`);
}

// ── Public tokenizer ──────────────────────────────────────────────────────────

/**
 * Convert a styled string into a flat array of tokens (ANSI codes + chars).
 * `endChar` limits tokenisation to the first N visible columns (default: ∞).
 */
export function tokenize(
  str: string,
  endChar = Number.POSITIVE_INFINITY,
): Token[] {
  const ret: Token[] = [];
  let visible = 0;
  let i = 0;

  while (i < str.length) {
    const codePoint = str.codePointAt(i)!;
    const charLength = codePoint > 0xff_ff ? 2 : 1;
    const charStr = str.slice(i, i + charLength);

    if (ESCAPES.has(codePoint)) {
      let code: string | undefined;
      const nextCodePoint = str.codePointAt(i + 1);
      if (nextCodePoint === CC_OSC) {
        code = parseLinkCode(str, i);
        if (code) {
          ret.push({ type: 'ansi', code, endCode: getEndCode(code) });
        } else {
          code = parseOSCSequence(str, i);
          if (code) ret.push({ type: 'control', code });
        }
      } else if (nextCodePoint === CC_CSI) {
        code = parseSGRSequence(str, i);
        if (code) {
          const codes = splitCompoundSGRSequences(code);
          for (const individualCode of codes) {
            ret.push({
              type: 'ansi',
              code: individualCode,
              endCode: getEndCode(individualCode),
            });
          }
        }
      }
      if (code) {
        i += code.length;
        continue;
      }
    }

    // Variation Selector 16 forces emoji presentation (2 cols wide)
    const isVariationSelector = charStr.includes('\uFE0F');
    // Regional indicator pairs form flag emoji (2 cols wide)
    const isRegionalIndicator =
      codePoint >= 0x1_f1_e6 && codePoint <= 0x1_f1_ff;
    const fullWidth =
      isVariationSelector ||
      isRegionalIndicator ||
      isFullwidthCodePoint(codePoint);

    ret.push({ type: 'char', value: charStr, fullWidth });
    visible += fullWidth ? 2 : 1;
    if (visible >= endChar) break;
    i += charLength;
  }

  return ret;
}

// ── StyledLine builder ────────────────────────────────────────────────────────

/**
 * Reconstruct a StyledLine from the token stream produced by `tokenize()`.
 * Tracks open SGR codes and accumulates them as span metadata.
 */
export function styledLineFromTokens(tokens: Token[]): StyledLine {
  const line = new StyledLine();
  let formatFlags = 0;
  let fgColor: string | undefined;
  let bgColor: string | undefined;
  let link: string | undefined;

  for (const token of tokens) {
    if (token.type === 'ansi') {
      const { code } = token;
      switch (code) {
        case SGR.reset.open: {
          formatFlags = 0;
          fgColor = undefined;
          bgColor = undefined;
          link = undefined;
          break;
        }
        case SGR.bold.open: {
          formatFlags |= BOLD_MASK;
          break;
        }
        case SGR.dim.open: {
          formatFlags |= DIM_MASK;
          break;
        }
        case SGR.italic.open: {
          formatFlags |= ITALIC_MASK;
          break;
        }
        case SGR.underline.open: {
          formatFlags |= UNDERLINE_MASK;
          break;
        }
        case SGR.strikethrough.open: {
          formatFlags |= STRIKETHROUGH_MASK;
          break;
        }
        case SGR.inverse.open: {
          formatFlags |= INVERSE_MASK;
          break;
        }
        case SGR.hidden.open: {
          formatFlags |= HIDDEN_MASK;
          break;
        }
        // bold.close and dim.close share \e[22m — clear both
        case SGR.bold.close: {
          formatFlags &= ~BOLD_MASK;
          formatFlags &= ~DIM_MASK;
          break;
        }
        case SGR.italic.close: {
          formatFlags &= ~ITALIC_MASK;
          break;
        }
        case SGR.underline.close: {
          formatFlags &= ~UNDERLINE_MASK;
          break;
        }
        case SGR.strikethrough.close: {
          formatFlags &= ~STRIKETHROUGH_MASK;
          break;
        }
        case SGR.inverse.close: {
          formatFlags &= ~INVERSE_MASK;
          break;
        }
        case SGR.hidden.close: {
          formatFlags &= ~HIDDEN_MASK;
          break;
        }
        default: {
          if (
            code.startsWith('\u001B[38;') ||
            (code >= '\u001B[30m' && code <= '\u001B[37m') ||
            (code >= '\u001B[90m' && code <= '\u001B[97m')
          ) {
            fgColor = code;
          } else if (
            code.startsWith('\u001B[48;') ||
            (code >= '\u001B[40m' && code <= '\u001B[47m') ||
            (code >= '\u001B[100m' && code <= '\u001B[107m')
          ) {
            bgColor = code;
          } else if (code === SGR.colorClose) {
            fgColor = undefined;
          } else if (code === SGR.bgColorClose) {
            bgColor = undefined;
          } else if (code.startsWith(linkCodePrefix)) {
            link = code;
          } else if (
            code === linkEndCode ||
            code === linkEndCodeST ||
            code === linkEndCodeC1ST
          ) {
            link = undefined;
          }
        }
      }
    } else if (token.type === 'char') {
      let finalFlags = formatFlags;
      if (token.fullWidth) finalFlags |= FULL_WIDTH_MASK;
      line.pushChar(token.value, finalFlags, fgColor, bgColor, link);
    }
  }

  return line;
}

// ── styledLineToString ────────────────────────────────────────────────────────

/**
 * Serialise a StyledLine back to an ANSI-escaped string, emitting only the
 * minimal set of open/close codes needed to represent each span transition.
 */
export function styledLineToString(line: StyledLine): string {
  let ret = '';
  let prevFormatFlags = 0;
  let prevFgColor: string | undefined;
  let prevBgColor: string | undefined;
  let prevLink: string | undefined;

  for (const { value, formatFlags, fgColor, bgColor, link } of line) {
    if (
      formatFlags === prevFormatFlags &&
      fgColor === prevFgColor &&
      bgColor === prevBgColor &&
      link === prevLink
    ) {
      ret += value;
      continue;
    }

    // Bold/dim share the same close code (\e[22m).  If either was on and is
    // now off, emit the close, then re-open any that should remain on.
    let needResetBoldDim = false;
    if (
      (prevFormatFlags & BOLD_MASK && !(formatFlags & BOLD_MASK)) ||
      (prevFormatFlags & DIM_MASK && !(formatFlags & DIM_MASK))
    ) {
      needResetBoldDim = true;
    }
    if (needResetBoldDim) ret += SGR.bold.close;

    if (
      (needResetBoldDim ||
        (formatFlags & BOLD_MASK && !(prevFormatFlags & BOLD_MASK))) &&
      formatFlags & BOLD_MASK
    )
      ret += SGR.bold.open;
    if (
      (needResetBoldDim ||
        (formatFlags & DIM_MASK && !(prevFormatFlags & DIM_MASK))) &&
      formatFlags & DIM_MASK
    )
      ret += SGR.dim.open;

    if (formatFlags & ITALIC_MASK && !(prevFormatFlags & ITALIC_MASK))
      ret += SGR.italic.open;
    if (!(formatFlags & ITALIC_MASK) && prevFormatFlags & ITALIC_MASK)
      ret += SGR.italic.close;
    if (formatFlags & UNDERLINE_MASK && !(prevFormatFlags & UNDERLINE_MASK))
      ret += SGR.underline.open;
    if (!(formatFlags & UNDERLINE_MASK) && prevFormatFlags & UNDERLINE_MASK)
      ret += SGR.underline.close;
    if (
      formatFlags & STRIKETHROUGH_MASK &&
      !(prevFormatFlags & STRIKETHROUGH_MASK)
    )
      ret += SGR.strikethrough.open;
    if (
      !(formatFlags & STRIKETHROUGH_MASK) &&
      prevFormatFlags & STRIKETHROUGH_MASK
    )
      ret += SGR.strikethrough.close;
    if (formatFlags & INVERSE_MASK && !(prevFormatFlags & INVERSE_MASK))
      ret += SGR.inverse.open;
    if (!(formatFlags & INVERSE_MASK) && prevFormatFlags & INVERSE_MASK)
      ret += SGR.inverse.close;
    if (formatFlags & HIDDEN_MASK && !(prevFormatFlags & HIDDEN_MASK))
      ret += SGR.hidden.open;
    if (!(formatFlags & HIDDEN_MASK) && prevFormatFlags & HIDDEN_MASK)
      ret += SGR.hidden.close;

    if (fgColor !== prevFgColor)
      ret += fgColor === undefined ? SGR.colorClose : fgColor;
    if (bgColor !== prevBgColor)
      ret += bgColor === undefined ? SGR.bgColorClose : bgColor;
    if (link !== prevLink) ret += link === undefined ? linkEndCode : link;

    ret += value;
    prevFormatFlags = formatFlags;
    prevFgColor = fgColor;
    prevBgColor = bgColor;
    prevLink = link;
  }

  // Reset any styles still active at end of string
  if (prevFgColor !== undefined) ret += SGR.colorClose;
  if (prevBgColor !== undefined) ret += SGR.bgColorClose;
  if (prevFormatFlags & (BOLD_MASK | DIM_MASK)) ret += SGR.bold.close;
  if (prevFormatFlags & ITALIC_MASK) ret += SGR.italic.close;
  if (prevFormatFlags & UNDERLINE_MASK) ret += SGR.underline.close;
  if (prevFormatFlags & STRIKETHROUGH_MASK) ret += SGR.strikethrough.close;
  if (prevFormatFlags & INVERSE_MASK) ret += SGR.inverse.close;
  if (prevFormatFlags & HIDDEN_MASK) ret += SGR.hidden.close;
  if (prevLink !== undefined) ret += linkEndCode;

  return ret;
}
