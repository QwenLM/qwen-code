/**
 * Inline ANSI SGR code constants.
 *
 * Ported from npm ink's tokenize.js / ansiCodes.ts so we have no
 * runtime dependency on the `ansi-styles` package.
 *
 * Origin: @jrichman/ink@6.6.7  (MIT — Copyright (c) Vadym Demedes)
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

// ── Control characters ──────────────────────────────────────────────────────
export const BEL = '\u0007';
export const ESC = '\u001B';
export const ST = '\u009C'; // C1 String Terminator

// Character codes used during parsing
export const CC_BEL = BEL.charCodeAt(0);
export const CC_ESC = ESC.charCodeAt(0);
export const CC_BACKSLASH = '\\'.charCodeAt(0);
export const CC_CSI = '['.charCodeAt(0); // '[' after ESC
export const CC_OSC = ']'.charCodeAt(0); // ']' after ESC
export const CC_C1_ST = ST.charCodeAt(0);
export const CC_0 = '0'.charCodeAt(0);
export const CC_9 = '9'.charCodeAt(0);
export const CC_SEMI = ';'.charCodeAt(0);
export const CC_M = 'm'.charCodeAt(0);

/** Code points that start an escape sequence */
export const ESCAPES = new Set([CC_ESC, 0x9b]);

// ── Hyperlink OSC 8 sequences ────────────────────────────────────────────────
export const linkCodePrefix = `${ESC}]8;`;
export const linkCodePrefixCharCodes = [...linkCodePrefix].map((c) =>
  c.charCodeAt(0),
);

export const linkEndCode = `${ESC}]8;;${BEL}`;
export const linkEndCodeST = `${ESC}]8;;${ESC}\\`;
export const linkEndCodeC1ST = `${ESC}]8;;${ST}`;

// ── SGR open/close sequences ─────────────────────────────────────────────────
// These are exactly the values produced by ansi-styles@6 for the tokens we use.
export const SGR = {
  reset: { open: '\u001B[0m', close: '\u001B[0m' },
  bold: { open: '\u001B[1m', close: '\u001B[22m' },
  dim: { open: '\u001B[2m', close: '\u001B[22m' },
  italic: { open: '\u001B[3m', close: '\u001B[23m' },
  underline: { open: '\u001B[4m', close: '\u001B[24m' },
  inverse: { open: '\u001B[7m', close: '\u001B[27m' },
  hidden: { open: '\u001B[8m', close: '\u001B[28m' },
  strikethrough: { open: '\u001B[9m', close: '\u001B[29m' },
  // Color reset codes
  colorClose: '\u001B[39m',
  bgColorClose: '\u001B[49m',
} as const;

// ── Format bit-flags (must match FULL_WIDTH_MASK used in StyledLine) ─────────
export const BOLD_MASK = 1 << 0; // 0x01
export const DIM_MASK = 1 << 1; // 0x02
export const ITALIC_MASK = 1 << 2; // 0x04
export const UNDERLINE_MASK = 1 << 3; // 0x08
export const STRIKETHROUGH_MASK = 1 << 4; // 0x10
export const INVERSE_MASK = 1 << 5; // 0x20
export const HIDDEN_MASK = 1 << 6; // 0x40
export const FULL_WIDTH_MASK = 1 << 7; // 0x80

// ── SGR end-code resolution ──────────────────────────────────────────────────
// Maps open codes → close codes so getEndCode() works without ansi-styles.
const END_CODE_MAP: ReadonlyMap<string, string> = new Map([
  [SGR.bold.open, SGR.bold.close],
  [SGR.dim.open, SGR.dim.close],
  [SGR.italic.open, SGR.italic.close],
  [SGR.underline.open, SGR.underline.close],
  [SGR.inverse.open, SGR.inverse.close],
  [SGR.hidden.open, SGR.hidden.close],
  [SGR.strikethrough.open, SGR.strikethrough.close],
]);

/** True if `code` is itself a closing/reset code. */
export function isEndCode(code: string): boolean {
  return (
    code === SGR.bold.close || // \e[22m  (bold+dim share this)
    code === SGR.italic.close || // \e[23m
    code === SGR.underline.close || // \e[24m
    code === SGR.inverse.close || // \e[27m
    code === SGR.hidden.close || // \e[28m
    code === SGR.strikethrough.close // \e[29m
  );
}

/**
 * Given an SGR open code, return the matching close code.
 * Falls back to reset for unrecognised codes.
 */
export function getEndCode(code: string): string {
  if (isEndCode(code)) return code;
  const mapped = END_CODE_MAP.get(code);
  if (mapped !== undefined) return mapped;
  if (code.startsWith(linkCodePrefix)) {
    if (code.endsWith('\u001B\\')) return linkEndCodeST;
    if (code.endsWith(ST)) return linkEndCodeC1ST;
    return linkEndCode;
  }
  // Bare SGR params (after stripping \e[ ... m)
  const inner = code.slice(2); // remove \e[
  if (inner.startsWith('38')) return SGR.colorClose;
  if (inner.startsWith('48')) return SGR.bgColorClose;
  // Fallthrough: treat as reset
  return SGR.reset.open;
}
