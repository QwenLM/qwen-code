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

const MEDIA_MARKER_PATTERN = /\[(IMAGE|FILE):\s*/giu;

function previousOpenBracket(text: string, open: number): number {
  return open === 0 ? -1 : text.lastIndexOf('[', open - 1);
}

function isMarkerCloseBoundary(
  text: string,
  close: number,
  boundary: number,
): boolean {
  let cursor = close + 1;
  if (cursor >= boundary || /\s/u.test(text[cursor]!)) return true;
  while (
    cursor < boundary &&
    /[.,;:!?)}\]，。；：！？）】]/u.test(text[cursor]!)
  ) {
    cursor++;
  }
  return (
    cursor > close + 1 && (cursor >= boundary || /\s/u.test(text[cursor]!))
  );
}

function findMarkerClose(
  text: string,
  pathStart: number,
  boundary: number,
): number {
  let close = text.indexOf(']', pathStart);
  let lastClose = -1;
  while (close !== -1 && close < boundary) {
    lastClose = close;
    if (isMarkerCloseBoundary(text, close, boundary)) return close;
    close = text.indexOf(']', close + 1);
  }
  return lastClose;
}

function markerBoundary(
  visibleText: string,
  pathStart: number,
  nextOpening: number | undefined,
): number {
  let boundary = nextOpening ?? visibleText.length;
  const lineBreak = visibleText.slice(pathStart, boundary).search(/[\r\n]/u);
  if (lineBreak !== -1) boundary = pathStart + lineBreak;
  return boundary;
}

function markerSafeTruncationStart(text: string, start: number): number {
  const visibleText = maskCode(text);
  const before = visibleText.slice(0, start);
  let open = before.lastIndexOf('[');
  while (open !== -1) {
    const opening = visibleText.slice(open).match(/^\[(IMAGE|FILE):\s*/iu);
    if (opening) {
      const pathStart = open + opening[0].length;
      const nextOpeningOffset = visibleText
        .slice(pathStart)
        .search(MEDIA_MARKER_PATTERN);
      const boundary = markerBoundary(
        visibleText,
        pathStart,
        nextOpeningOffset === -1 ? undefined : pathStart + nextOpeningOffset,
      );
      const close = findMarkerClose(visibleText, pathStart, boundary);
      if (close >= start) return close + 1;
      if (close === -1 && boundary >= start) return boundary;
    }
    open = previousOpenBracket(before, open);
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
  const openings = [...visibleText.matchAll(MEDIA_MARKER_PATTERN)];
  const markers: OutboundMediaMarker[] = [];

  for (let i = 0; i < openings.length; i++) {
    const match = openings[i]!;
    if (match.index === undefined || match[1]?.toUpperCase() !== markerName) {
      continue;
    }
    const pathStart = match.index + match[0].length;
    const boundary = markerBoundary(
      visibleText,
      pathStart,
      openings[i + 1]?.index,
    );
    const close = findMarkerClose(visibleText, pathStart, boundary);
    if (close === -1) continue;
    const path = text.slice(pathStart, close).trim();
    if (!path) continue;
    markers.push({
      start: match.index,
      end: close + 1,
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
  let stripAt: number | undefined;
  while (open !== -1) {
    const candidate = visibleText.slice(open + 1);
    if (/[\r\n]/u.test(candidate)) break;
    const nextOpen = visibleText.indexOf('[', open + 1);
    const ownSegment =
      nextOpen === -1 ? candidate : candidate.slice(0, nextOpen - open - 1);
    if (ownSegment.includes(']')) {
      open = previousOpenBracket(visibleText, open);
      continue;
    }
    const normalizedCandidate = candidate.toUpperCase();
    if (
      normalizedCandidate &&
      (prefix.startsWith(normalizedCandidate) ||
        normalizedCandidate.startsWith(prefix))
    ) {
      stripAt = open;
    }
    open = previousOpenBracket(visibleText, open);
  }
  return stripAt === undefined
    ? text
    : `${text.slice(0, stripAt)}${pendingText}`;
}
