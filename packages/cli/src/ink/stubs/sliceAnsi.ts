/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

// ANSI-aware string slice that preserves active ANSI styles.
// Slices a string by visible character positions while maintaining
// ANSI escape code context — active styles at the slice start point
// are prepended so the sliced text renders identically to the
// corresponding region of the original.

const ESC = 0x1b;
const ANSI_RE = /\x1b\[[0-9;]*m/y;

export default function sliceAnsi(
  str: string,
  start: number,
  end?: number,
): string {
  // Single pass: collect visible-char positions and ANSI codes.
  const visibleToRaw: number[] = [];
  // ANSI codes encountered, grouped by the visible-char index they precede.
  const ansiBeforeVisible: Array<{
    code: string;
    visibleIndex: number;
  }> = [];
  let visible = 0;
  let i = 0;
  while (i < str.length) {
    if (str.charCodeAt(i) === ESC) {
      ANSI_RE.lastIndex = i;
      const match = ANSI_RE.exec(str);
      if (match) {
        ansiBeforeVisible.push({
          code: match[0],
          visibleIndex: visible,
        });
        i += match[0].length;
        continue;
      }
    }
    visibleToRaw.push(i);
    visible++;
    i++;
  }

  const actualEnd = end === undefined ? visible : Math.min(end, visible);
  const actualStart = Math.max(0, start);

  if (actualStart >= actualEnd || actualStart >= visible) return '';

  // Determine which ANSI styles are active at the slice start.
  // Replay all codes whose visibleIndex <= actualStart to compute
  // the cumulative SGR state.  We track: endCode → most-recent startCode.
  const activeStyles = new Map<string, string>();

  for (const entry of ansiBeforeVisible) {
    if (entry.visibleIndex > actualStart) break;
    applyCode(entry.code, activeStyles);
  }

  // Extract the raw substring for the visible range.
  const rawStart = visibleToRaw[actualStart] ?? 0;
  const rawEnd =
    actualEnd >= visible ? str.length : (visibleToRaw[actualEnd] ?? str.length);

  const slice = str.slice(rawStart, rawEnd);

  if (activeStyles.size === 0) return slice;

  // Prepend the active styles so the slice renders correctly.
  let prefix = '';
  for (const [, startCode] of activeStyles) {
    prefix += startCode;
  }

  return prefix + slice;
}

/** Apply a single SGR code to the active-styles map. */
function applyCode(code: string, active: Map<string, string>): void {
  // Full reset: \x1b[0m or \x1b[m
  if (code === '\x1b[0m' || code === '\x1b[m') {
    active.clear();
    return;
  }

  const endCode = sgrEndCode(code);
  if (endCode === null) return;

  if (endCode === code) {
    // The code IS a reset — remove the style it closes.
    active.delete(code);
  } else {
    active.set(endCode, code);
  }
}

/**
 * Return the SGR reset code that turns off `code`, or `code` itself if
 * `code` is already a reset.  Returns null for unrecognised codes.
 */
function sgrEndCode(code: string): string | null {
  const match = code.match(/^\x1b\[([0-9;]*)m$/);
  if (!match) return null;
  const params = match[1]!;

  // 24-bit / 256-colour foreground: \x1b[38;2;R;G;Bm / \x1b[38;5;Nm
  if (params.startsWith('38;') || params === '38') return '\x1b[39m';
  // 24-bit / 256-colour background
  if (params.startsWith('48;') || params === '48') return '\x1b[49m';

  const n = parseInt(params, 10);
  if (isNaN(n)) return null;

  // prettier-ignore
  switch (n) {
    // ── style toggles ────────────────────────────────────
    case  1: return '\x1b[22m'  // bold
    case  2: return '\x1b[22m'  // dim
    case  3: return '\x1b[23m'  // italic
    case  4: return '\x1b[24m'  // underline
    case  7: return '\x1b[27m'  // inverse
    case  8: return '\x1b[28m'  // hidden
    case  9: return '\x1b[29m'  // strikethrough
    case 53: return '\x1b[55m'  // overline

    // ── 3/4-bit foreground ───────────────────────────────
    case 30: case 31: case 32: case 33:
    case 34: case 35: case 36: case 37:
    case 90: case 91: case 92: case 93:
    case 94: case 95: case 96: case 97:
      return '\x1b[39m'

    // ── 3/4-bit background ───────────────────────────────
    case 40: case 41: case 42: case 43:
    case 44: case 45: case 46: case 47:
    case 100: case 101: case 102: case 103:
    case 104: case 105: case 106: case 107:
      return '\x1b[49m'

    // ── reset codes (the code IS its own end) ────────────
    case  0: return '\x1b[0m'
    case 22: return '\x1b[22m'
    case 23: return '\x1b[23m'
    case 24: return '\x1b[24m'
    case 27: return '\x1b[27m'
    case 28: return '\x1b[28m'
    case 29: return '\x1b[29m'
    case 39: return '\x1b[39m'
    case 49: return '\x1b[49m'
    case 55: return '\x1b[55m'

    default: return null
  }
}
