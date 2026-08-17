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

/**
 * Step the backward `[` walk one bracket to the left.
 *
 * `String.prototype.lastIndexOf` clamps a negative `fromIndex` to 0, so the
 * naive `lastIndexOf('[', open - 1)` returns 0 forever once `open` reaches a
 * `[` at index 0 — a synchronous infinite loop on any text starting with `[`
 * (`[OK] done`, the adapter's own `[File delivery failed: …]` notice).
 */
function previousOpen(text: string, open: number): number {
  return open === 0 ? -1 : text.lastIndexOf('[', open - 1);
}

/**
 * Marker openings are recognised only when the whole marker fits on one line,
 * matching {@link mediaMarkerPattern}. An empty candidate (the cut landing
 * between `[` and `FILE:`) is a valid prefix of every marker name and must
 * advance the cut too, otherwise the retained tail starts with a bare
 * `FILE: /abs/path]` fragment that no downstream sanitizer can recognise.
 */
function markerSafeTruncationStart(text: string, start: number): number {
  const before = text.slice(0, start);
  const lastClose = before.lastIndexOf(']');
  let open = before.lastIndexOf('[');
  while (open > lastClose) {
    const candidate = before.slice(open + 1);
    if (!/[\r\n]/u.test(candidate)) {
      const normalized = candidate.toUpperCase();
      if (
        MEDIA_MARKER_PREFIXES.some(
          (prefix) =>
            prefix.startsWith(normalized) || normalized.startsWith(prefix),
        )
      ) {
        const close = text.indexOf(']', start);
        const newline = text
          .slice(start, close === -1 ? undefined : close)
          .search(/[\r\n]/u);
        // No same-line close: not a marker at all, so the tail is ordinary
        // prose and nothing needs skipping. Returning `text.length` here would
        // discard the entire retained window — a bare `[` at the cut collapsed
        // a 28k answer to the truncation marker alone.
        if (close === -1 || newline !== -1) return start;
        return close + 1;
      }
    }
    open = previousOpen(before, open);
  }
  return start;
}

/**
 * The fence delimiter open at `offset`, or undefined outside a fenced block.
 *
 * A retained tail that begins inside a fenced code block has inverted fence
 * parity: {@link maskCode} reads the block's CLOSING fence as an opening one
 * and stops masking real code while unmasking real prose, so a genuine
 * `[FILE: /abs/path]` outside any block survives sanitisation as literal text.
 */
function openFenceAt(text: string, offset: number): string | undefined {
  let fence: { character: '`' | '~'; length: number } | undefined;
  let lineStart = 0;
  while (lineStart < offset) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/u, '');
    if (fence) {
      const closing = line.match(/^ {0,3}(`+|~+)[\t ]*$/u)?.[1];
      if (closing?.[0] === fence.character && closing.length >= fence.length) {
        fence = undefined;
      }
    } else {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
      const delimiter = opening?.[1];
      if (
        delimiter &&
        (delimiter[0] !== '`' || !(opening?.[2] ?? '').includes('`'))
      ) {
        fence = {
          character: delimiter[0] as '`' | '~',
          length: delimiter.length,
        };
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return fence ? fence.character.repeat(fence.length) : undefined;
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
  // Re-open a fence the cut landed inside, so the tail keeps the parity every
  // downstream consumer assumes: the code masker, and DingTalk's own renderer.
  const reopen = openFenceAt(text, start);
  const prefix = reopen ? `${truncationMarker}${reopen}\n` : truncationMarker;
  return `${prefix}${text.slice(start)}`;
}

export function findOutboundMediaMarkers(
  text: string,
  markerName: 'IMAGE' | 'FILE',
): OutboundMediaMarker[] {
  const visibleText = maskCode(text);
  // `[^\S\r\n]*`, not `\s*`: a marker must fit on one line. With `\s*` the
  // opening could swallow a newline, so `[FILE:` at a line end and its path on
  // the next line parsed as one marker — a shape the truncation guard (which
  // only ever looks for a same-line close) could not model, leaving the two
  // disagreeing about where a marker ends.
  const markerPattern = new RegExp(
    `\\[${markerName}:[^\\S\\r\\n]*([^\\]\\r\\n]+)\\]`,
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
  // Strip at the EARLIEST unclosed marker, not the first one found walking
  // backwards. Two unclosed markers (a max-tokens cutoff mid-second-marker)
  // would otherwise leave the earlier one — absolute path and all — as literal
  // text in the delivered card.
  let stripAt = -1;
  while (open !== -1) {
    const candidate = visibleText.slice(open + 1);
    if (/[\r\n]/u.test(candidate)) break;
    if (candidate.includes(']')) {
      open = previousOpen(visibleText, open);
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
    open = previousOpen(visibleText, open);
  }
  if (stripAt === -1) return text;
  return `${text.slice(0, stripAt)}${pendingText}`;
}
