import MarkdownIt from 'markdown-it';

export interface OutboundMediaMarkerCandidate {
  end: number;
  path: string;
}

export interface OutboundMediaMarker {
  start: number;
  end: number;
  path: string;
  candidates?: OutboundMediaMarkerCandidate[];
}

const MEDIA_MARKER_PATTERN = /\[(IMAGE|FILE):\s*/giu;
const PARTIAL_MEDIA_MARKER_OPENING_PATTERN =
  /\[(?:(?:IMAGE|FILE):\s*|(?:I(?:M(?:A(?:G(?:E)?)?)?)?|F(?:I(?:L(?:E)?)?)?)?(?=[\r\n]|$))/giu;
const CODE_TOKEN_TYPES = new Set(['code_block', 'code_inline', 'fence']);
const markdown = new MarkdownIt();
type MarkdownToken = ReturnType<typeof markdown.parse>[number];

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function markerOpenings(text: string): RegExpMatchArray[] {
  return [...text.matchAll(MEDIA_MARKER_PATTERN)].filter(
    (opening) => opening.index !== undefined && !isEscaped(text, opening.index),
  );
}

function markerOpeningsInCode(
  text: string,
  openings: readonly RegExpMatchArray[],
): Set<number> {
  const sentinels = openings.map((_, index) => {
    let sentinel = `\u{e000}QWEN_MEDIA_MARKER_${index}\u{e001}`;
    while (text.includes(sentinel)) sentinel += '\u{e002}';
    return sentinel;
  });
  let instrumented = text;
  for (let index = openings.length - 1; index >= 0; index--) {
    const opening = openings[index]!;
    const markerPrefixLength = opening[0].trimEnd().length;
    instrumented =
      instrumented.slice(0, opening.index) +
      sentinels[index] +
      instrumented.slice(opening.index! + markerPrefixLength);
  }

  const codeOpenings = new Set<number>();
  const visit = (tokens: readonly MarkdownToken[]) => {
    for (const token of tokens) {
      if (CODE_TOKEN_TYPES.has(token.type)) {
        for (const [index, sentinel] of sentinels.entries()) {
          if (
            token.content.includes(sentinel) ||
            token.info.includes(sentinel)
          ) {
            codeOpenings.add(openings[index]!.index!);
          }
        }
      }
      if (token.children) visit(token.children);
    }
  };
  visit(markdown.parse(instrumented, {}));
  return codeOpenings;
}

function bracketOpeningsInCode(text: string): Set<number> {
  const openings = [
    ...text.matchAll(PARTIAL_MEDIA_MARKER_OPENING_PATTERN),
  ].filter(
    (opening) => opening.index !== undefined && !isEscaped(text, opening.index),
  );
  const codeOpenings = markerOpeningsInCode(text, openings);
  for (const opening of openings) {
    const lineStart = text.lastIndexOf('\n', opening.index! - 1) + 1;
    const prefix = text.slice(lineStart, opening.index);
    let delimiter = 0;
    for (const match of prefix.matchAll(/`+/gu)) {
      let escapes = 0;
      for (let index = match.index! - 1; index >= 0; index--) {
        if (prefix[index] !== '\\') break;
        escapes++;
      }
      if (escapes % 2 === 1) continue;
      if (delimiter === 0) delimiter = match[0].length;
      else if (delimiter === match[0].length) delimiter = 0;
    }
    if (delimiter !== 0) codeOpenings.add(opening.index!);
  }
  return codeOpenings;
}

function previousOpenBracket(text: string, open: number): number {
  return open === 0 ? -1 : text.lastIndexOf('[', open - 1);
}

function isMarkerCloseBoundary(
  text: string,
  close: number,
  boundary: number,
): boolean {
  let cursor = close + 1;
  if (
    cursor >= boundary ||
    /[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
      text[cursor]!,
    )
  ) {
    return true;
  }
  while (
    cursor < boundary &&
    /[.,;:!?)}\]，。；：！？）】]/u.test(text[cursor]!)
  ) {
    cursor++;
  }
  return (
    cursor > close + 1 &&
    (cursor >= boundary ||
      /[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
        text[cursor]!,
      ))
  );
}

function findMarkerClose(
  text: string,
  pathStart: number,
  boundary: number,
): number {
  let close = text.indexOf(']', pathStart);
  let lastClose = -1;
  const closes: number[] = [];
  while (close !== -1 && close < boundary) {
    lastClose = close;
    closes.push(close);
    close = text.indexOf(']', close + 1);
  }
  for (const candidate of closes) {
    if (isMarkerCloseBoundary(text, candidate, boundary)) return candidate;
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
  for (const markerName of ['IMAGE', 'FILE'] as const) {
    for (const marker of findOutboundMediaMarkers(text, markerName, true)) {
      const end = markerSanitizationEnd(text, marker);
      if (marker.start < start && end >= start) return end;
    }
  }
  const before = text.slice(0, start);
  let open = before.lastIndexOf('[');
  while (open !== -1) {
    const opening = text.slice(open).match(/^\[(IMAGE|FILE):\s*/iu);
    if (opening) {
      const pathStart = open + opening[0].length;
      const nextOpeningOffset = text
        .slice(pathStart)
        .search(MEDIA_MARKER_PATTERN);
      const boundary = markerBoundary(
        text,
        pathStart,
        nextOpeningOffset === -1 ? undefined : pathStart + nextOpeningOffset,
      );
      const close = findMarkerClose(text, pathStart, boundary);
      if (close >= start) return close + 1;
      if (close === -1 && boundary >= start && boundary < text.length) {
        return boundary;
      }
    }
    open = previousOpenBracket(before, open);
  }
  return start;
}

function markerSanitizationEnd(
  text: string,
  marker: OutboundMediaMarker,
): number {
  if (/\[IMAGE$/iu.test(text.slice(0, marker.start))) return marker.end;
  const opening = text.slice(marker.start).match(/^\[(IMAGE|FILE):\s*/iu);
  if (!opening) return marker.end;
  const pathStart = marker.start + opening[0].length;
  const nextOpeningOffset = text.slice(pathStart).search(MEDIA_MARKER_PATTERN);
  const boundary = markerBoundary(
    text,
    pathStart,
    nextOpeningOffset === -1 ? undefined : pathStart + nextOpeningOffset,
  );
  const primaryPath = text.slice(pathStart, marker.end - 1);
  const end = primaryPath.includes('[')
    ? (marker.candidates?.at(-1)?.end ?? marker.end)
    : marker.end;
  if (isMarkerCloseBoundary(text, end - 1, boundary)) return end;
  return primaryPath.includes('[') ? boundary : end;
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
  includeCode = false,
): OutboundMediaMarker[] {
  const openings = markerOpenings(text);
  const codeOpenings = includeCode
    ? new Set<number>()
    : markerOpeningsInCode(text, openings);
  const markers: OutboundMediaMarker[] = [];

  for (let i = 0; i < openings.length; i++) {
    const match = openings[i]!;
    if (
      match.index === undefined ||
      match[1]?.toLowerCase() !== markerName.toLowerCase() ||
      codeOpenings.has(match.index)
    ) {
      continue;
    }
    const pathStart = match.index + match[0].length;
    const boundary = markerBoundary(text, pathStart, openings[i + 1]?.index);
    const close = findMarkerClose(text, pathStart, boundary);
    if (close === -1) continue;
    const path = text.slice(pathStart, close).trim();
    if (!path) continue;
    const candidates: OutboundMediaMarkerCandidate[] = [];
    let candidateClose = text.indexOf(']', pathStart);
    while (candidateClose !== -1 && candidateClose < boundary) {
      const candidatePath = text.slice(pathStart, candidateClose).trim();
      if (candidatePath) {
        candidates.push({ end: candidateClose + 1, path: candidatePath });
      }
      candidateClose = text.indexOf(']', candidateClose + 1);
    }
    markers.push({
      start: match.index,
      end: close + 1,
      path,
      ...(candidates.length > 1 ? { candidates } : {}),
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
  includeCode = false,
): string {
  const prefix = `${markerName.toLowerCase()}:`;
  const codeOpenings = includeCode
    ? new Set<number>()
    : bracketOpeningsInCode(text);
  let cursor = 0;
  let searchFrom = 0;
  let result = '';
  while (searchFrom < text.length) {
    const open = text.indexOf('[', searchFrom);
    if (open === -1) break;
    if (isEscaped(text, open)) {
      searchFrom = open + 1;
      continue;
    }
    if (codeOpenings.has(open)) {
      searchFrom = open + 1;
      continue;
    }
    const lineEndMatch = text.slice(open + 1).search(/[\r\n]/u);
    const lineEnd = lineEndMatch === -1 ? text.length : open + 1 + lineEndMatch;
    const candidate = text.slice(open + 1, lineEnd);
    const normalizedCandidate = candidate.toLowerCase();
    if (!normalizedCandidate) {
      searchFrom = open + 1;
      continue;
    }
    let end = lineEnd;
    if (!normalizedCandidate.startsWith(prefix)) {
      if (!prefix.startsWith(normalizedCandidate)) {
        searchFrom = open + 1;
        continue;
      }
    } else {
      const opening = text.slice(open).match(/^\[(IMAGE|FILE):\s*/iu);
      if (!opening) {
        searchFrom = open + 1;
        continue;
      }
      const pathStart = open + opening[0].length;
      const nextMarkerOffset = text
        .slice(pathStart)
        .search(MEDIA_MARKER_PATTERN);
      const boundary = markerBoundary(
        text,
        pathStart,
        nextMarkerOffset === -1 ? undefined : pathStart + nextMarkerOffset,
      );
      if (findMarkerClose(text, pathStart, boundary) !== -1) {
        searchFrom = open + 1;
        continue;
      }
      end = boundary;
    }
    const nextMarker = text.slice(end).match(/^\[(IMAGE|FILE):\s*/iu);
    const replacement =
      nextMarker?.[1]?.toLowerCase() === markerName.toLowerCase()
        ? ''
        : pendingText;
    result += `${text.slice(cursor, open)}${replacement}`;
    cursor = end;
    searchFrom = end;
  }
  return cursor === 0 ? text : result + text.slice(cursor);
}

export function sanitizeOutboundMediaMarkers(
  text: string,
  markerName: 'IMAGE' | 'FILE',
  replacement: string,
): string {
  let result = text;
  while (true) {
    const markers = findOutboundMediaMarkers(result, markerName, true).map(
      (marker) => ({
        ...marker,
        end: markerSanitizationEnd(result, marker),
      }),
    );
    const next = stripPartialOutboundMediaMarker(
      replaceOutboundMediaMarkers(
        result,
        markers,
        markers.map(() => replacement),
      ),
      markerName,
      replacement,
      true,
    );
    if (next === result) return result;
    result = next;
  }
}

export interface TrailingPartialOutboundMediaMarker {
  start: number;
  markerName?: 'IMAGE' | 'FILE';
  complete?: boolean;
}

export function findTrailingPartialOutboundMediaMarker(
  text: string,
): TrailingPartialOutboundMediaMarker | undefined {
  const codeOpenings = bracketOpeningsInCode(text);
  let open = text.lastIndexOf('[');
  while (open !== -1) {
    if (isEscaped(text, open)) {
      open = previousOpenBracket(text, open);
      continue;
    }
    if (codeOpenings.has(open)) {
      open = previousOpenBracket(text, open);
      continue;
    }
    const lineBreak = text.slice(open + 1).search(/[\r\n]/u);
    const lineEnd = lineBreak === -1 ? text.length : open + 1 + lineBreak;
    const candidate = text.slice(open + 1, lineEnd);
    if (lineEnd === text.length && candidate === '') return { start: open };
    for (const markerName of ['IMAGE', 'FILE'] as const) {
      const prefix = `${markerName}:`;
      if (
        lineEnd === text.length &&
        candidate &&
        prefix.toLowerCase().startsWith(candidate.toLowerCase())
      ) {
        return { start: open, markerName };
      }
      const opening = text.slice(open).match(/^\[(IMAGE|FILE):\s*/iu);
      if (opening?.[1]?.toLowerCase() !== markerName.toLowerCase()) continue;
      const pathStart = open + opening[0].length;
      const nextMarkerOffset = text
        .slice(pathStart)
        .search(MEDIA_MARKER_PATTERN);
      const boundary = markerBoundary(
        text,
        pathStart,
        nextMarkerOffset === -1 ? undefined : pathStart + nextMarkerOffset,
      );
      const close = findMarkerClose(text, pathStart, boundary);
      const ambiguousBracketedPath =
        close === text.length - 1 &&
        text.slice(pathStart, close).includes('[') &&
        text.indexOf(']', pathStart) === close;
      const trailingBracketedPath =
        close !== -1 &&
        text.slice(pathStart, close).includes('[') &&
        !isMarkerCloseBoundary(text, close, boundary);
      if (
        boundary === text.length &&
        (close === -1 || ambiguousBracketedPath || trailingBracketedPath)
      ) {
        return {
          start: open,
          markerName,
          ...(ambiguousBracketedPath ? { complete: true } : {}),
        };
      }
    }
    open = previousOpenBracket(text, open);
  }
  return undefined;
}

export function unwrapFileMarkersAroundImages(text: string): string {
  const images = findOutboundMediaMarkers(text, 'IMAGE', true);
  const openings = markerOpenings(text).filter(
    (opening) => opening[1]?.toLowerCase() === 'file',
  );
  const wrappers = openings.flatMap((opening) => {
    const start = opening.index!;
    const pathStart = start + opening[0].length;
    const lineBreak = text.slice(pathStart).search(/[\r\n]/u);
    const lineEnd = lineBreak === -1 ? text.length : pathStart + lineBreak;
    const nested = images.filter(
      (image) => image.start >= pathStart && image.end <= lineEnd,
    );
    if (
      nested.length === 0 ||
      text.slice(pathStart, nested[0]!.start).includes(']')
    ) {
      return [];
    }
    const lastImage = nested.at(-1)!;
    let wrapperClose = lastImage.end;
    if (text[wrapperClose] !== ']') {
      const nextClose = text.indexOf(']', wrapperClose);
      const suffix = text.slice(wrapperClose, nextClose).trim();
      wrapperClose =
        nextClose < lineEnd && /^(?:[~/\\]|[A-Za-z]:[\\/])/u.test(suffix)
          ? nextClose
          : -1;
    }
    if (wrapperClose === -1 || wrapperClose >= lineEnd) {
      return [{ start, end: nested[0]!.start, replacement: '' }];
    }
    return [
      {
        start,
        end: wrapperClose + 1,
        replacement: nested
          .map((image) => text.slice(image.start, image.end))
          .join(' '),
      },
    ];
  });
  const nonOverlapping = wrappers
    .sort((left, right) => left.start - right.start)
    .filter(
      (wrapper, index, sorted) =>
        index === 0 || wrapper.start >= sorted[index - 1]!.end,
    );
  let result = text;
  for (const wrapper of nonOverlapping.reverse()) {
    result =
      result.slice(0, wrapper.start) +
      wrapper.replacement +
      result.slice(wrapper.end);
  }
  return result;
}
