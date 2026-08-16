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

function markerOpenings(
  text: string,
  includeEscaped = false,
): RegExpMatchArray[] {
  return [...text.matchAll(MEDIA_MARKER_PATTERN)].filter(
    (opening) =>
      opening.index !== undefined &&
      (includeEscaped || !isEscaped(text, opening.index)),
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
  return markerOpeningsInCode(text, openings);
}

function unclosedBacktickStart(
  text: string,
  before: number,
): number | undefined {
  let delimiterLength = 0;
  let delimiterStart = -1;
  for (const match of text.slice(0, before).matchAll(/`+/gu)) {
    let runStart = match.index!;
    let runLength = match[0].length;
    if (isEscaped(text, runStart)) {
      runStart++;
      runLength--;
    }
    if (runLength === 0) continue;
    if (delimiterLength === 0) {
      delimiterLength = runLength;
      delimiterStart = runStart;
    } else if (delimiterLength === runLength) {
      delimiterLength = 0;
      delimiterStart = -1;
    }
  }
  return delimiterStart === -1 ? undefined : delimiterStart;
}

function previousOpenBracket(text: string, open: number): number {
  return open === 0 ? -1 : text.lastIndexOf('[', open - 1);
}

function isLikelyMarkerPathContinuation(suffix: string): boolean {
  return /^(?:\.[^\s[\]]+|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)$/u.test(suffix);
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
  for (let index = 0; index < closes.length - 1; index++) {
    const candidate = closes[index]!;
    const next = closes[index + 1]!;
    if (!isLikelyMarkerPathContinuation(text.slice(candidate + 1, next))) {
      return candidate;
    }
  }
  if (
    lastClose !== -1 &&
    isLikelyMarkerPathContinuation(text.slice(lastClose + 1, boundary))
  ) {
    return -1;
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
  for (const wrapper of fileMarkersAroundImages(text)) {
    if (wrapper.start < start && wrapper.end >= start) return wrapper.end;
  }
  for (const markerName of ['IMAGE', 'FILE'] as const) {
    for (const marker of findOutboundMediaMarkers(
      text,
      markerName,
      true,
      true,
    )) {
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
      if (close === -1 && boundary >= start) {
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
  const lastCandidate = marker.candidates?.at(-1);
  if (
    marker.path.includes('[') &&
    lastCandidate &&
    lastCandidate.end > marker.end &&
    /^\s+(?:[~./\\]|[A-Za-z]:[\\/])[^\r\n]*$/u.test(
      text.slice(marker.end, lastCandidate.end - 1),
    )
  ) {
    return lastCandidate.end;
  }
  return marker.end;
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
  includeEscaped = false,
): OutboundMediaMarker[] {
  const openings = markerOpenings(text, includeEscaped);
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
  includeEscaped = false,
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
    if (!includeEscaped && isEscaped(text, open)) {
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
      if (lineEnd !== text.length) {
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
      const nextMarkerOpen =
        nextMarkerOffset === -1 ? undefined : pathStart + nextMarkerOffset;
      const boundary = markerBoundary(text, pathStart, nextMarkerOpen);
      if (
        nextMarkerOpen === boundary &&
        ((!includeEscaped && isEscaped(text, nextMarkerOpen)) ||
          codeOpenings.has(nextMarkerOpen))
      ) {
        searchFrom = open + 1;
        continue;
      }
      if (findMarkerClose(text, pathStart, boundary) !== -1) {
        searchFrom = open + 1;
        continue;
      }
      end = Math.min(boundary, lineEnd);
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
    const markers = findOutboundMediaMarkers(
      result,
      markerName,
      true,
      true,
    ).map((marker) => ({
      ...marker,
      end: markerSanitizationEnd(result, marker),
    }));
    const next = stripPartialOutboundMediaMarker(
      replaceOutboundMediaMarkers(
        result,
        markers,
        markers.map(() => replacement),
      ),
      markerName,
      replacement,
      true,
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
  const wrappers = fileMarkersAroundImages(text);
  let pending: TrailingPartialOutboundMediaMarker | undefined;
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
    if (lineEnd === text.length && candidate === '') {
      pending = { start: open };
      open = previousOpenBracket(text, open);
      continue;
    }
    for (const markerName of ['IMAGE', 'FILE'] as const) {
      const prefix = `${markerName}:`;
      if (
        lineEnd === text.length &&
        candidate &&
        prefix.toLowerCase().startsWith(candidate.toLowerCase())
      ) {
        pending = { start: open, markerName };
        continue;
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
      const wrapper = wrappers.find((candidate) => candidate.start === open);
      const uncertainCodeStart = unclosedBacktickStart(text, text.length);
      if (
        uncertainCodeStart !== undefined &&
        uncertainCodeStart < open &&
        lineEnd === text.length
      ) {
        if (close !== -1) {
          pending = {
            start: uncertainCodeStart,
            markerName,
            complete: true,
          };
        } else {
          pending = { start: uncertainCodeStart };
        }
        continue;
      }
      if (
        wrapper &&
        !wrapper.complete &&
        wrapper.end === lineEnd &&
        lineEnd === text.length
      ) {
        pending = { start: open, markerName };
        continue;
      }
      const ambiguousBracketedPath =
        close === text.length - 1 &&
        text.slice(pathStart, close).includes('[') &&
        text.indexOf(']', pathStart) === close;
      const trailingBracketedPath =
        close !== -1 &&
        text.slice(pathStart, close).includes('[') &&
        isLikelyMarkerPathContinuation(text.slice(close + 1, boundary));
      if (
        boundary === text.length &&
        (close === -1 || ambiguousBracketedPath || trailingBracketedPath)
      ) {
        pending = {
          start: open,
          markerName,
          ...(ambiguousBracketedPath ? { complete: true } : {}),
        };
      }
    }
    open = previousOpenBracket(text, open);
  }
  const trailingBackslashes = text.match(/\\+$/u);
  if (
    trailingBackslashes?.index !== undefined &&
    (!pending || trailingBackslashes.index < pending.start)
  ) {
    pending = { start: trailingBackslashes.index };
  }
  return pending;
}

interface FileMarkerAroundImages {
  start: number;
  end: number;
  replacement: string;
  complete: boolean;
}

function isWrapperPathSuffix(suffix: string): boolean {
  if (!suffix) return true;
  if (/^(?:[~/\\]|\.{1,2}[\\/]|[A-Za-z]:[\\/])/u.test(suffix)) return true;
  return /^(?:[^\s[\]]+[\\/])+[^\s[\]]+$|^.+\.[A-Za-z0-9]{1,16}$/u.test(suffix);
}

function fileMarkersAroundImages(text: string): FileMarkerAroundImages[] {
  const images = findOutboundMediaMarkers(text, 'IMAGE', true, true);
  const openings = markerOpenings(text, true).filter(
    (opening) =>
      opening.index !== undefined &&
      !isEscaped(text, opening.index) &&
      opening[1]?.toLowerCase() === 'file',
  );
  return openings.flatMap((opening) => {
    const start = opening.index!;
    const pathStart = start + opening[0].length;
    const lineBreak = text.slice(pathStart).search(/[\r\n]/u);
    const lineEnd = lineBreak === -1 ? text.length : pathStart + lineBreak;
    let nested = images.filter(
      (image) => image.start >= pathStart && image.end <= lineEnd,
    );
    if (
      nested.length === 0 ||
      text.slice(pathStart, nested[0]!.start).includes(']')
    ) {
      return [];
    }
    const wrapperCloseGap = nested.findIndex(
      (image, index) =>
        index > 0 &&
        text.slice(nested[index - 1]!.end, image.start).includes(']'),
    );
    if (wrapperCloseGap !== -1) nested = nested.slice(0, wrapperCloseGap);
    const lastImage = nested.at(-1)!;
    const nextClose = text.indexOf(']', lastImage.end);
    const closedSuffix =
      nextClose !== -1 && nextClose < lineEnd
        ? text.slice(lastImage.end, nextClose).trim()
        : undefined;
    const complete =
      nextClose !== -1 &&
      nextClose < lineEnd &&
      !(closedSuffix ?? '').includes('[');
    const trailingSuffix = text.slice(lastImage.end, lineEnd).trim();
    const hidesTrailingSuffix = complete
      ? isWrapperPathSuffix(closedSuffix ?? '')
      : !/[\s[\]]/u.test(trailingSuffix);
    const replacement = nested
      .map((image) => text.slice(image.start, image.end))
      .join(' ');
    return [
      {
        start,
        end: complete
          ? nextClose + 1
          : hidesTrailingSuffix
            ? lineEnd
            : nested[0]!.start,
        replacement: complete
          ? `${replacement}${
              hidesTrailingSuffix ? '' : text.slice(lastImage.end, nextClose)
            }`
          : hidesTrailingSuffix
            ? replacement
            : '',
        complete,
      },
    ];
  });
}

export function unwrapFileMarkersAroundImages(text: string): string {
  const wrappers = fileMarkersAroundImages(text);
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
