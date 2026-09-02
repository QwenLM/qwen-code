const ANSI_COLORS: Record<number, string> = {
  30: '#4a4a4a',
  31: '#fc8181',
  32: '#48bb78',
  33: '#ecc94b',
  34: '#4a9eff',
  35: '#b794f4',
  36: '#76e4f7',
  37: '#e0e6f0',
  90: '#5a6a8a',
  91: '#feb2b2',
  92: '#9ae6b4',
  93: '#fefcbf',
  94: '#90cdf4',
  95: '#d6bcfa',
  96: '#b2f5ea',
  97: '#ffffff',
};

/** The six channel levels of the xterm 6x6x6 color cube (indices 16-231). */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

interface Segment {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

// The channel and index parameters are read straight out of the escape
// sequence, so a truncated one yields `undefined` — the types say so rather
// than asserting the value away, and the guards below are what reject it.
function toHex(
  r: number | undefined,
  g: number | undefined,
  b: number | undefined,
): string | undefined {
  let hex = '#';
  for (const v of [r, g, b]) {
    if (v === undefined || !Number.isInteger(v) || v < 0 || v > 255) {
      return undefined;
    }
    hex += v.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Resolve an xterm 256-color index to a hex string. */
function xterm256(index: number | undefined): string | undefined {
  if (index === undefined || !Number.isInteger(index)) return undefined;
  if (index < 0 || index > 255) return undefined;
  // 0-15 stay on the palette above, so a tool emitting `38;5;2` and one
  // emitting `32` render as the same green.
  if (index < 8) return ANSI_COLORS[30 + index];
  if (index < 16) return ANSI_COLORS[90 + (index - 8)];
  if (index < 232) {
    const v = index - 16;
    return toHex(
      CUBE_LEVELS[Math.floor(v / 36)],
      CUBE_LEVELS[Math.floor(v / 6) % 6],
      CUBE_LEVELS[v % 6],
    );
  }
  const level = 8 + (index - 232) * 10;
  return toHex(level, level, level);
}

export function parseAnsi(input: string): Segment[] {
  const segments: Segment[] = [];
  let color: string | undefined;
  let bold = false;
  let dim = false;
  let pos = 0;

  const re = new RegExp(String.raw`\x1b\[([0-9;]*)m`, 'g');
  let match: RegExpExecArray | null;

  while ((match = re.exec(input)) !== null) {
    if (match.index > pos) {
      segments.push({ text: input.slice(pos, match.index), color, bold, dim });
    }
    pos = match.index + match[0].length;

    const codes = match[1].split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      // 38/48/58 (foreground/background/underline color) never stand alone:
      // each is followed by `5;<index>` or `2;<r>;<g>;<b>`. Those arguments
      // have to be consumed here, or the loop reads them as codes in their own
      // right — `38;5;2` would take the color index for "dim", and a truecolor
      // value with a zero channel would hit the reset below and drop the
      // color, bold and dim state that was already correct.
      if (code === 38 || code === 48 || code === 58) {
        const mode = codes[i + 1];
        let value: string | undefined;
        if (mode === 5) {
          value = xterm256(codes[i + 2]);
          i += 2;
        } else if (mode === 2) {
          value = toHex(codes[i + 2], codes[i + 3], codes[i + 4]);
          i += 4;
        } else {
          // An unrecognized form has an unknown argument count, so there is no
          // safe place to resume; drop the rest of this sequence rather than
          // guess where the color ends.
          break;
        }
        // Only the foreground maps onto a Segment. Background and underline
        // color are still parsed so their arguments cannot leak into the loop.
        // A malformed value leaves the current color alone: an unreadable
        // sequence is ignored, not treated as a reset.
        if (code === 38 && value !== undefined) color = value;
      } else if (code === 0) {
        color = undefined;
        bold = false;
        dim = false;
      } else if (code === 1) {
        bold = true;
      } else if (code === 2) {
        dim = true;
      } else if (code === 22) {
        bold = false;
        dim = false;
      } else if (code >= 30 && code <= 37) {
        color = ANSI_COLORS[code];
      } else if (code >= 90 && code <= 97) {
        color = ANSI_COLORS[code];
      } else if (code === 39) {
        color = undefined;
      }
    }
  }

  if (pos < input.length) {
    segments.push({ text: input.slice(pos), color, bold, dim });
  }

  return segments;
}

export function hasAnsi(input: string): boolean {
  return new RegExp(String.raw`\x1b\[`).test(input);
}
