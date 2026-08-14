export interface OutboundMediaMarker {
  start: number;
  end: number;
  path: string;
}

function maskCode(text: string): string {
  const masked = text.split('');
  const blank = (start: number, end: number) => {
    for (let i = start; i < end; i++) {
      if (masked[i] !== '\n') masked[i] = ' ';
    }
  };

  const withoutQuotePrefix = (line: string): string => {
    let offset = 0;
    while (offset < line.length) {
      let spaces = 0;
      while (spaces < 4 && line[offset + spaces] === ' ') spaces++;
      if (spaces > 3 || line[offset + spaces] !== '>') break;
      offset += spaces + 1;
      if (line[offset] === ' ') offset++;
    }
    return line.slice(offset);
  };

  let fence: { character: '`' | '~'; length: number } | undefined;
  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/u, '');
    const body = withoutQuotePrefix(line);
    if (fence) {
      blank(lineStart, lineEnd);
      const closing = body.match(/^ {0,3}(`+|~+)[\t ]*$/u)?.[1];
      if (closing?.[0] === fence.character && closing.length >= fence.length) {
        fence = undefined;
      }
    } else {
      const opening = body.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
      const delimiter = opening?.[1];
      const info = opening?.[2] ?? '';
      if (delimiter && (delimiter[0] !== '`' || !info.includes('`'))) {
        fence = {
          character: delimiter[0] as '`' | '~',
          length: delimiter.length,
        };
        blank(lineStart, lineEnd);
      } else if (/^(?: {4}|\t)/u.test(body)) {
        blank(lineStart, lineEnd);
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }

  let offset = 0;
  while (offset < text.length) {
    if (masked[offset] === '`') {
      let runLength = 1;
      while (masked[offset + runLength] === '`') runLength++;
      let closing = offset + runLength;
      while (closing < text.length) {
        while (closing < text.length && masked[closing] !== '`') closing++;
        let closingLength = 0;
        while (masked[closing + closingLength] === '`') closingLength++;
        if (closingLength === runLength) break;
        closing += Math.max(1, closingLength);
      }
      const newline = text.indexOf('\n', offset + runLength);
      const end =
        closing < text.length
          ? closing + runLength
          : newline === -1
            ? text.length
            : newline;
      blank(offset, end);
      offset = end;
      continue;
    }
    offset++;
  }

  return masked.join('');
}

const MEDIA_MARKER_PREFIXES = ['IMAGE:', 'FILE:'];

function markerSafeTruncationStart(text: string, start: number): number {
  const before = text.slice(0, start);
  const lastClose = before.lastIndexOf(']');
  let open = before.lastIndexOf('[');
  while (open > lastClose) {
    const candidate = before.slice(open + 1);
    if (!/[\r\n]/u.test(candidate)) {
      const normalized = candidate.toUpperCase();
      if (
        normalized &&
        MEDIA_MARKER_PREFIXES.some(
          (prefix) =>
            prefix.startsWith(normalized) || normalized.startsWith(prefix),
        )
      ) {
        const close = text.indexOf(']', start);
        const newline = text
          .slice(start, close === -1 ? undefined : close)
          .search(/[\r\n]/u);
        if (close === -1 || newline !== -1) return text.length;
        return close + 1;
      }
    }
    open = before.lastIndexOf('[', open - 1);
  }
  return start;
}

export function truncateOutboundMediaText(
  text: string,
  limit: number,
  truncationMarker: string,
): string {
  if (text.length <= limit) return text;
  if (limit === 0) return '';
  if (limit <= truncationMarker.length) {
    return text.slice(markerSafeTruncationStart(text, text.length - limit));
  }
  const start = markerSafeTruncationStart(
    text,
    text.length - (limit - truncationMarker.length),
  );
  return `${truncationMarker}${text.slice(start)}`;
}

export function findOutboundMediaMarkers(
  text: string,
  markerName: 'IMAGE' | 'FILE',
): OutboundMediaMarker[] {
  const visibleText = maskCode(text);
  const markerPattern = new RegExp(
    `\\[${markerName}:\\s*([^\\]\\r\\n]+)\\]`,
    'gi',
  );
  const markers: OutboundMediaMarker[] = [];

  for (const match of visibleText.matchAll(markerPattern)) {
    const path = match[1]?.trim();
    if (!path || match.index === undefined) continue;
    markers.push({
      start: match.index,
      end: match.index + match[0].length,
      path,
    });
  }

  return markers;
}

export function replaceOutboundMediaMarkers(
  text: string,
  markers: readonly OutboundMediaMarker[],
  replacements: readonly string[],
): string {
  if (markers.length !== replacements.length) {
    throw new Error('Media marker replacement count mismatch');
  }

  let result = text;
  for (let i = markers.length - 1; i >= 0; i--) {
    const marker = markers[i]!;
    result =
      result.slice(0, marker.start) +
      replacements[i]! +
      result.slice(marker.end);
  }
  return result;
}

export function stripPartialOutboundMediaMarker(
  text: string,
  markerName: 'IMAGE' | 'FILE',
  pendingText: string,
): string {
  const visibleText = maskCode(text);
  const prefix = `${markerName}:`;
  let open = visibleText.lastIndexOf('[');
  while (open !== -1) {
    const candidate = visibleText.slice(open + 1);
    if (/[\r\n]/u.test(candidate)) return text;
    if (candidate.includes(']')) {
      open = visibleText.lastIndexOf('[', open - 1);
      continue;
    }
    const normalizedCandidate = candidate.toUpperCase();
    if (
      normalizedCandidate &&
      (prefix.startsWith(normalizedCandidate) ||
        normalizedCandidate.startsWith(prefix))
    ) {
      return `${text.slice(0, open)}${pendingText}`;
    }
    open = visibleText.lastIndexOf('[', open - 1);
  }
  return text;
}
