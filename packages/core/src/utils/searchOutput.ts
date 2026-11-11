/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Decode file names without treating embedded newlines as record separators. */
export function decodeSearchPaths(lines: string[]): string[] {
  return lines
    .join('\n')
    .split('\0')
    .filter((entry) => entry !== '');
}

export function decodeSearchCounts(lines: string[]): string[] {
  const output = lines.join('\n');
  const entries: string[] = [];
  for (const match of output.matchAll(/([^\0]*)\0(\d+)(?:\r?\n|$)/g)) {
    entries.push(`${match[1]}:${match[2]}`);
  }
  return entries;
}

interface RgText {
  text?: string;
  bytes?: string;
}
interface RgEvent {
  type: string;
  data: {
    path?: RgText;
    lines?: RgText;
    line_number?: number;
    binary_offset?: number | null;
    submatches?: Array<{ match: RgText; start: number }>;
  };
}

/** Internal content records use NUL between the path and rendered line. */
export function decodeSearchContent(
  lines: string[],
  options: { context: boolean; onlyMatching: boolean },
): string[] {
  const text = (value?: RgText) =>
    value?.text ?? Buffer.from(value?.bytes ?? '', 'base64').toString('utf8');
  const clip = (value: string, kind: string) =>
    value.length > 500 ? `[Omitted long ${kind} line]` : value;
  const results: string[] = [];
  let pending: string[] = [];
  let previousPath: string | undefined;
  let previousLine = -1;
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    let event: RgEvent | null;
    try {
      event = JSON.parse(line) as RgEvent | null;
    } catch {
      // A malformed record must not discard earlier, complete search results.
      continue;
    }
    if (
      !event ||
      typeof event !== 'object' ||
      !event.data ||
      typeof event.data !== 'object'
    )
      continue;
    const data = event.data;
    if (event.type === 'begin') {
      pending = [];
      continue;
    }
    if (event.type === 'end') {
      const binary = typeof data.binary_offset === 'number';
      for (const entry of pending) {
        if (!binary || !entry.slice(entry.indexOf('\0') + 1).includes('\0'))
          results.push(entry);
      }
      if (binary && pending.length)
        results.push(
          `${text(data.path)}\0binary file matches (found "\\0" byte around offset ${data.binary_offset})`,
        );
      pending = [];
      continue;
    }
    if (event.type !== 'match' && event.type !== 'context') continue;
    const file = text(data.path);
    const number = data.line_number ?? 0;
    const content = text(data.lines).replace(/\r?\n$/, '');
    if (
      options.context &&
      previousPath !== undefined &&
      (file !== previousPath || number > previousLine + 1)
    )
      pending.push('--');
    if (event.type === 'match' && options.onlyMatching) {
      const bytes = Buffer.from(content);
      for (const match of data.submatches ?? []) {
        const startLine =
          number +
          bytes.subarray(0, match.start).toString().split('\n').length -
          1;
        text(match.match)
          .split('\n')
          .forEach((part, index) => {
            pending.push(
              `${file}\0${startLine + index}:${clip(part.replace(/\r$/, ''), 'matching')}`,
            );
            previousLine = startLine + index;
          });
      }
    } else {
      const kind = event.type === 'match' ? 'matching' : 'context';
      content
        .split('\n')
        .forEach((part, index) =>
          pending.push(
            `${file}\0${number + index}${event.type === 'match' ? ':' : '-'}${clip(part.replace(/\r$/, ''), kind)}`,
          ),
        );
      previousLine = number + content.split('\n').length - 1;
    }
    previousPath = file;
  }
  for (const entry of pending) results.push(entry);
  return results;
}
