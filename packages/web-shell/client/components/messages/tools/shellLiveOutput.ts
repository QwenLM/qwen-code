import type { CSSProperties } from 'react';

interface ShellSegment {
  text: string;
  style?: CSSProperties;
}

export interface ShellLiveOutput {
  segments?: ShellSegment[];
  timeoutMs?: number;
  totalLines?: number;
  totalBytes?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseShellLiveOutput(value: unknown): ShellLiveOutput | null {
  if (!record(value)) return null;
  if (
    Object.keys(value).some(
      (key) =>
        !['ansiOutput', 'timeoutMs', 'totalLines', 'totalBytes'].includes(key),
    )
  )
    return null;
  const number = (key: string) =>
    typeof value[key] === 'number' &&
    Number.isFinite(value[key]) &&
    value[key] >= 0
      ? value[key]
      : undefined;
  const progress: ShellLiveOutput = {
    timeoutMs: number('timeoutMs'),
    totalLines: number('totalLines'),
    totalBytes: number('totalBytes'),
  };
  if (!Array.isArray(value.ansiOutput)) return null;
  const segments: ShellSegment[] = [];
  for (const [index, line] of value.ansiOutput.entries()) {
    if (!Array.isArray(line)) return null;
    if (index > 0) segments.push({ text: '\n' });
    for (const token of line) {
      if (!record(token) || typeof token.text !== 'string') return null;
      const color = (v: unknown) =>
        typeof v === 'string' && /^#[\da-f]{6}$/i.test(v) ? v : undefined;
      const fg = color(token.fg),
        bg = color(token.bg);
      segments.push({
        text: token.text,
        style: {
          color: token.inverse === true ? (bg ?? 'var(--background)') : fg,
          backgroundColor:
            token.inverse === true ? (fg ?? 'var(--foreground)') : bg,
          fontWeight: token.bold === true ? 'bold' : undefined,
          fontStyle: token.italic === true ? 'italic' : undefined,
          textDecoration: token.underline === true ? 'underline' : undefined,
          opacity: token.dim === true ? 0.6 : undefined,
        },
      });
    }
  }
  return { ...progress, segments };
}
