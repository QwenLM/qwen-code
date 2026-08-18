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
  let previousBlank = true; // start of document opens an indented block
  let inIndentedCode = false;
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/u, '');
    const body = withoutQuotePrefix(line);
    const blankLine = body.trim() === '';
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
      } else if (
        /^(?: {4}|\t)/u.test(body) &&
        (previousBlank || inIndentedCode)
      ) {
        // R1-8: an indented line is a CommonMark indented code block only when
        // it does not continue a paragraph or a list item — the block cannot
        // interrupt one. Blanking every indented line hid genuine markers on
        // list-continuation lines from every layer, so the absolute path
        // shipped as literal text and the file was never delivered. Requiring
        // a blank line to open the block (and letting consecutive indented
        // lines continue it) keeps real indented code masked.
        blank(lineStart, lineEnd);
        inIndentedCode = true;
      } else if (body.trim() !== '') {
        inIndentedCode = false;
      }
    }
    previousBlank = blankLine;
    if (newline === -1) break;
    lineStart = newline + 1;
  }

  let offset = 0;
  while (offset < text.length) {
    if (masked[offset] === '`') {
      let runLength = 1;
      while (masked[offset + runLength] === '`') runLength++;
      const newline = text.indexOf('\n', offset + runLength);
      // R1-9: a run of one or two backticks must find its closing run before
      // the next newline. Without that bound a cross-line span masks whatever
      // it covers — including a genuine same-line media marker — which every
      // sanitizer then misses, so the absolute path ships as literal text and
      // the media is never delivered. Longer runs keep spanning lines.
      const searchLimit =
        runLength < 3 && newline !== -1 ? newline : text.length;
      let closing = offset + runLength;
      while (closing < searchLimit) {
        while (closing < searchLimit && masked[closing] !== '`') closing++;
        let closingLength = 0;
        while (masked[closing + closingLength] === '`') closingLength++;
        if (closingLength === runLength) break;
        closing += Math.max(1, closingLength);
      }
      if (closing >= searchLimit) closing = text.length;
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
        if (close === -1 || newline !== -1) {
          // R1-7: no same-line close, so the cut sits inside an UNCLOSED
          // marker. Returning raw `start` dropped the opening `[` and left a
          // bare `FILE: /abs/path` fragment that no sanitizer recognises —
          // truncation defeating the stripper and leaking the full path.
          // Advance past the span's same-line extent instead: exactly what
          // `stripPartialOutboundMediaMarker` would delete.
          //
          // Only for a span that really opens a marker, though. An empty
          // candidate (the cut landing right after a `[`) prefix-matches every
          // marker name vacuously, so a prose bracket would take this branch
          // too and discard the whole retained window — the bare-`[` collapse
          // that turned a 28k answer into the truncation marker alone.
          const opensMarker = new RegExp(
            `^\\[(?:${MEDIA_MARKER_PREFIXES.join('|')})`,
            'iu',
          ).test(text.slice(open));
          if (!opensMarker) return start;
          const eol = text.slice(start).search(/[\r\n]/u);
          return eol === -1 ? text.length : start + eol;
        }
        // R1-11: only skip when the span really completes a marker. A prose
        // bracket like `[IMAGE [FILE: /p]` prefix-matches too, and jumping to
        // the next `]` swallowed an intact marker that was fully inside the
        // retained window — the file then silently never shipped.
        const completed = `[${candidate}${text.slice(start, close)}]`;
        if (
          !new RegExp(
            `^\\[(?:${MEDIA_MARKER_PREFIXES.join('|')})[^\\S\\r\\n]*[^\\[\\]\\r\\n]+\\]$`,
            'iu',
          ).test(completed)
        ) {
          // R2-12: a bracketed path (`[FILE: /etc/passwd [b] c]`) fails the
          // strict completed regex above, yet it still genuinely opens a
          // marker. Returning the raw cut here dropped the opening bracket and
          // retained a bracket-less `FILE: /abs/path …` fragment that no
          // downstream sanitizer recognises. Advance past the span's same-line
          // extent, exactly as the unclosed branch above does. Only a prose
          // bracket that merely prefix-matches (`[FILE-x`) keeps the raw cut.
          const opensMarker = new RegExp(
            `^\\[(?:${MEDIA_MARKER_PREFIXES.join('|')})`,
            'iu',
          ).test(text.slice(open));
          if (!opensMarker) return start;
          const eol = text.slice(start).search(/[\r\n]/u);
          return eol === -1 ? text.length : start + eol;
        }
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
  let start = markerSafeTruncationStart(
    text,
    text.length - (limit - truncationMarker.length),
  );
  // Re-open a fence the cut landed inside, so the tail keeps the parity every
  // downstream consumer assumes: the code masker, and DingTalk's own renderer.
  let reopen = openFenceAt(text, start);
  // R1-3: the re-opener has to be RESERVED, not prepended on top of a tail
  // already sized to the whole budget — that returned up to
  // `limit + fence.length + 1` characters and broke the `<= limit` guarantee
  // `withSenderPrefix`'s budget arithmetic depends on. Re-cut with the prefix
  // paid for, then re-check the fence at the moved start (it can change, and a
  // longer delimiter must not reintroduce the overrun).
  for (let pass = 0; pass < 4 && reopen; pass++) {
    const budget = limit - truncationMarker.length - reopen.length - 1;
    if (budget <= 0) {
      // R2-4: breaking with `reopen` still set prepended an UNRESERVED
      // re-opener on top of a tail already sized to the whole budget, running
      // the result over `limit`. Fence parity is cosmetic; the `<= limit`
      // guarantee is load-bearing, so drop the re-opener instead.
      reopen = undefined;
      break;
    }
    const movedStart = markerSafeTruncationStart(text, text.length - budget);
    if (movedStart === start) break;
    start = movedStart;
    const nextReopen = openFenceAt(text, start);
    if (nextReopen === reopen) break;
    reopen = nextReopen;
  }
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
  // R1-10: `[` is excluded from the path class as well as `]`. With it
  // admitted, `[FILE: [FILE: /a]/secret/key.pdf]` matched at the OUTER
  // bracket and consumed the inner marker's closing `]`, leaving a
  // bracket-less `/secret/key.pdf]` that `stripPartialOutboundMediaMarker`
  // (which only ever walks back from a `[`) could not recognise — an absolute
  // path surviving every sanitizer on under-limit text. Excluding it makes the
  // INNER marker match first, so the fixed-point sweep unwinds the nesting.
  const markerPattern = new RegExp(
    `\\[${markerName}:[^\\S\\r\\n]*([^\\[\\]\\r\\n]+)\\]`,
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

/**
 * The end of the strippable residue of an unclosed marker opening whose text
 * after the `[` is `rest` and whose first newline sits at `eol` (-1 for none).
 *
 * The residue always covers the marker's own line. It extends past a close on
 * a LATER line only for the shape the same-line grammar cannot see — the path
 * sitting alone on the next line — and never through prose: the segment after
 * the newline must be a single whitespace-free token, and no other `[` may
 * precede the close, so an unrelated later bracket is never swallowed.
 */
function partialMarkerResidueEnd(
  text: string,
  open: number,
  rest: string,
  eol: number,
): number {
  if (eol === -1) return text.length;
  const close = rest.indexOf(']');
  if (close > eol) {
    const trailing = rest.slice(eol + 1, close);
    // R2-9: the extension may only reach a close that belongs to the marker's
    // own path — a single whitespace-free token on the next line. Otherwise a
    // bare `]` in later prose ("Analysis complete ]") would delete everything
    // in between. R2-8: the bracket veto runs on the ORIGINAL text, because
    // masking blanks a `[` inside an inline span, which would let the
    // extension swallow user content up to a later `]`. Masking may only make
    // stripping LESS aggressive, never more.
    if (/^\S+$/u.test(trailing) && !rest.slice(0, close).includes('[')) {
      return open + 1 + close + 1;
    }
  }
  // Splice only to end-of-line so the lines after an abandoned marker survive;
  // a marker on the final line still takes the rest of the text.
  return open + 1 + eol;
}

export function stripPartialOutboundMediaMarker(
  text: string,
  markerName: 'IMAGE' | 'FILE',
  pendingText: string,
): string {
  const prefix = `${markerName}:`;
  // Walk the RAW text, not maskCode(text). Masking exists to keep the finder
  // from delivering files quoted in code; it must not also hide strippable
  // residue from the display sanitizer. An abandoned marker inside a fence or
  // inline span still ships its absolute path to the card, so it is stripped
  // here. A COMPLETE marker keeps its `]`, which this pass never removes, so
  // the pinned "a marker quoted in code is left alone" behaviour survives.
  const spans: Array<{ start: number; end: number }> = [];
  let open = text.lastIndexOf('[');
  while (open !== -1) {
    // R1-5: confine the candidate to its OWN line instead of breaking the walk
    // at the first newline. Breaking meant only a marker on the final line
    // could ever be stripped, so an abandoned `[FILE: /abs/path` followed by
    // more output survived every sanitizer — contradicting this function's own
    // documented intent and leaking the path onto the card.
    const rest = text.slice(open + 1);
    const eol = rest.search(/[\r\n]/u);
    const candidate = eol === -1 ? rest : rest.slice(0, eol);
    // R1-4: a marker whose close sits on a LATER line is matched by no layer —
    // the same-line grammar misses it and the finder never sees it — so it
    // shipped as literal text with the absolute path. Treat it as strippable
    // residue here, which is where unclosed markers are already handled.
    if (!candidate.includes(']')) {
      const normalizedCandidate = candidate.toUpperCase();
      if (
        normalizedCandidate &&
        (prefix.startsWith(normalizedCandidate) ||
          normalizedCandidate.startsWith(prefix))
      ) {
        spans.push({
          start: open,
          end: partialMarkerResidueEnd(text, open, rest, eol),
        });
      }
    }
    open = previousOpen(text, open);
  }
  if (spans.length === 0) return text;
  // Strip EVERY unclosed marker, not just the earliest one found walking
  // backwards. The IMAGE display callers invoke this exactly once, so leaving
  // any later unclosed marker in place shipped its absolute path. Spans were
  // collected right-to-left; sort them and merge overlaps, since an earlier
  // marker's residue can run past a later marker's opening `[`.
  spans.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      if (span.end > last.end) last.end = span.end;
    } else {
      merged.push({ start: span.start, end: span.end });
    }
  }
  let result = `${text.slice(0, merged[0]!.start)}${pendingText}`;
  let previousEnd = merged[0]!.end;
  for (let i = 1; i < merged.length; i++) {
    const span = merged[i]!;
    result += text.slice(previousEnd, span.start);
    previousEnd = span.end;
  }
  return `${result}${text.slice(previousEnd)}`;
}
