import MarkdownIt from 'markdown-it';

export interface OutboundMediaMarker {
  start: number;
  end: number;
  path: string;
}

const MEDIA_MARKER_PATTERN = /\[(IMAGE|FILE):\s*/giu;
const PARTIAL_MEDIA_MARKER_OPENING_PATTERN =
  /\[(?:(?:IMAGE|FILE):\s*|(?:I(?:M(?:A(?:G(?:E)?)?)?)?|F(?:I(?:L(?:E)?)?)?)?(?=[\r\n]|$))/giu;
const CODE_TOKEN_TYPES = new Set(['code_block', 'code_inline', 'fence']);
const markdown = new MarkdownIt();
type MarkdownToken = ReturnType<typeof markdown.parse>[number];

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
  const openings = [...text.matchAll(PARTIAL_MEDIA_MARKER_OPENING_PATTERN)];
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
  const openings = [...text.matchAll(MEDIA_MARKER_PATTERN)];
  const codeOpenings = includeCode
    ? new Set<number>()
    : markerOpeningsInCode(text, openings);
  const markers: OutboundMediaMarker[] = [];

  for (let i = 0; i < openings.length; i++) {
    const match = openings[i]!;
    if (
      match.index === undefined ||
      match[1]?.toUpperCase() !== markerName ||
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
  const prefix = `${markerName}:`;
  const codeOpenings = bracketOpeningsInCode(text);
  let cursor = 0;
  let searchFrom = 0;
  let result = '';
  while (searchFrom < text.length) {
    const open = text.indexOf('[', searchFrom);
    if (open === -1) break;
    if (codeOpenings.has(open)) {
      searchFrom = open + 1;
      continue;
    }
    const lineEndMatch = text.slice(open + 1).search(/[\r\n]/u);
    const lineEnd = lineEndMatch === -1 ? text.length : open + 1 + lineEndMatch;
    const candidate = text.slice(open + 1, lineEnd);
    const normalizedCandidate = candidate.toUpperCase();
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
      nextMarker?.[1]?.toUpperCase() === markerName ? '' : pendingText;
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
    const markers = findOutboundMediaMarkers(result, markerName, true);
    const next = stripPartialOutboundMediaMarker(
      replaceOutboundMediaMarkers(
        result,
        markers,
        markers.map(() => replacement),
      ),
      markerName,
      replacement,
    );
    if (next === result) return result;
    result = next;
  }
}

export interface TrailingPartialOutboundMediaMarker {
  start: number;
  markerName?: 'IMAGE' | 'FILE';
}

export function findTrailingPartialOutboundMediaMarker(
  text: string,
): TrailingPartialOutboundMediaMarker | undefined {
  const codeOpenings = bracketOpeningsInCode(text);
  let open = text.lastIndexOf('[');
  while (open !== -1) {
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
      if (opening?.[1]?.toUpperCase() !== markerName) continue;
      const pathStart = open + opening[0].length;
      const nextMarkerOffset = text
        .slice(pathStart)
        .search(MEDIA_MARKER_PATTERN);
      const boundary = markerBoundary(
        text,
        pathStart,
        nextMarkerOffset === -1 ? undefined : pathStart + nextMarkerOffset,
      );
      if (
        boundary === text.length &&
        findMarkerClose(text, pathStart, boundary) === -1
      ) {
        return { start: open, markerName };
      }
    }
    open = previousOpenBracket(text, open);
  }
  return undefined;
}
