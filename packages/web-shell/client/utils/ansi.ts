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

interface Segment {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
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
    for (const code of codes) {
      if (code === 0) {
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
