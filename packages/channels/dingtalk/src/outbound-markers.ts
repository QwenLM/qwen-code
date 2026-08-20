export interface OutboundMediaMarker {
  start: number;
  end: number;
  path: string;
}

const MEDIA_MARKER_PREFIXES = ['IMAGE:', 'FILE:'];
const MARKER_NAME_GROUP = `(?:${MEDIA_MARKER_PREFIXES.join('|')})`;

/**
 * Whether the `[` at `open` opens a marker: its full name follows directly,
 * or after spaces, on the SAME line. A bare name prefix (`[i`, `[im`) is
 * prose, while a spaced opening (`[ FILE: /path]`) matches no delivery
 * grammar and can only ever ship its path as literal text.
 *
 * R5-2/R5-3: recognition folds case through `toUpperCase`, the way
 * {@link stripPartialOutboundMediaMarker} does, rather than through an
 * `iu`-flagged regex. The two disagree wherever uppercasing is not a simple
 * fold — `'ı'.toUpperCase()` is `'I'` and `'ﬁ'.toUpperCase()` is `'FI'`,
 * while `/I/iu.test('ı')` is `false`. A regex gate therefore rejected
 * `[FıLE: …]` / `[ﬁle: …]` openings that the stripper does strip, and the
 * truncation guard fell back to the raw cut: that drops the opening `[` and
 * leaves a bracket-less absolute path which `stripPartialOutboundMediaMarker`
 * — it walks backward from a `[` — can never recognise, so the path ships to
 * the card as literal text. One shared recogniser keeps the guard's R2-7
 * invariant (advance exactly as far as the stripper strips) true by
 * construction.
 */
function opensMediaMarker(text: string, open: number): boolean {
  const rest = text.slice(open + 1);
  const eol = rest.search(/[\r\n]/u);
  const line = (eol === -1 ? rest : rest.slice(0, eol)).toUpperCase();
  const trimmed = line.replace(/^[^\S\r\n]+/u, '');
  return MEDIA_MARKER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * What follows the marker name on `line`, with the separating spaces removed,
 * or `undefined` when `line` does not open with a marker name.
 *
 * R6-2: the same `toUpperCase` fold {@link opensMediaMarker} recognises with,
 * carried down to the offset in the ORIGINAL line. Uppercasing is not a
 * length-preserving map — `'ﬁ'.toUpperCase()` is `'FI'` — so the name cannot
 * be measured on an uppercased copy and sliced off the raw one; fold one
 * source character at a time and cut where the accumulated uppercase
 * completes a name. An `iu`-flagged regex is not a substitute: it rejects
 * `'ı'` for `'I'` and `'ﬁ'` for `'FI'`, which is exactly the divergence
 * R5-2/R5-3 closed for the truncation guard's gates.
 */
function afterMediaMarkerName(line: string): string | undefined {
  const leading = /^[^\S\r\n]*/u.exec(line)![0].length;
  let upper = '';
  for (let index = leading; index < line.length; index++) {
    upper += line[index]!.toUpperCase();
    if (MEDIA_MARKER_PREFIXES.includes(upper)) {
      return line.slice(index + 1).replace(/^[^\S\r\n]*/u, '');
    }
    if (!MEDIA_MARKER_PREFIXES.some((prefix) => prefix.startsWith(upper))) {
      return undefined;
    }
  }
  return undefined;
}

/**
 * A well-formed marker as the finder's delivery grammar accepts it: full
 * name immediately after the `[` (no leading space), a bracket-free
 * same-line path, closed by the first `]`.
 */
const COMPLETED_MARKER_PATTERN = new RegExp(
  `^\\[${MARKER_NAME_GROUP}[^\\S\\r\\n]*[^\\[\\]\\r\\n]+\\]$`,
  'iu',
);

function withoutQuotePrefix(line: string): string {
  let offset = 0;
  while (offset < line.length) {
    let spaces = 0;
    while (spaces < 4 && line[offset + spaces] === ' ') spaces++;
    if (spaces > 3 || line[offset + spaces] !== '>') break;
    offset += spaces + 1;
    if (line[offset] === ' ') offset++;
  }
  return line.slice(offset);
}

function maskCode(text: string): string {
  const masked = text.split('');
  const blank = (start: number, end: number) => {
    for (let i = start; i < end; i++) {
      if (masked[i] !== '\n') masked[i] = ' ';
    }
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
 * The end of the residue of an unclosed or ill-formed marker opening at
 * `open` whose text after the `[` is `rest`.
 *
 * The residue always covers the marker's own line. It reaches a close on a
 * LATER line only for the shape the same-line grammar cannot see — the path
 * sitting alone on the next line — and only when the marker's own line
 * carries no deliverable path: a path already present there means the later
 * `]` belongs to prose, so the prose must survive (the bracket-free trailing
 * segment is the path, never prose between marker and close). A bracketed
 * own-line fragment cannot be a path, so it still allows the extension.
 * With no usable close at all, the strip additionally covers a bracket-free
 * FOLLOWING line — a cutoff between `[NAME:` and its path must not ship the
 * bare path line — but never reaches past that line into prose.
 */
function partialMarkerResidueEnd(
  text: string,
  open: number,
  rest: string,
): number {
  const eol = rest.search(/[\r\n]/u);
  if (eol === -1) return text.length;
  const ownLine = rest.slice(0, eol);
  // R3-4: what remains after the marker name. Empty (the path starts on the
  // next line) or bracketed (never a deliverable path) both let the strip
  // continue past the marker's own line; a real same-line path stops it.
  // R6-2: fold case exactly as the recognition gates do. An `iu` regex left
  // the name in `pathPart` for `[FıLE:` / `[ﬁLE:` — openings `toUpperCase`
  // recognition accepts — so `pathCouldContinue` was false and the residue
  // stopped at the marker's own line, stranding the bare path line below it
  // with no leading `[` for any backward walk to find.
  const pathPart = afterMediaMarkerName(ownLine);
  const pathCouldContinue =
    pathPart !== undefined && (pathPart === '' || pathPart.includes('['));
  // Step past the whole line break: `eol` sits on the `\r` of a CRLF pair.
  const nextStart =
    rest[eol] === '\r' && rest[eol + 1] === '\n' ? eol + 2 : eol + 1;
  const close = rest.indexOf(']');
  if ((close === -1 || close > eol) && pathCouldContinue) {
    if (close !== -1) {
      // R2-9/R2-8: only a close belonging to the marker's own path may end
      // the strip — a bracket-free segment on the very next line, vetoed by
      // any `[` of its own, run against the ORIGINAL text because masking
      // blanks brackets and may only make stripping LESS aggressive.
      const trailing = rest.slice(nextStart, close);
      if (trailing.length > 0 && !/[\r\n[]/u.test(trailing)) {
        return open + 1 + close + 1;
      }
    }
    // R2-6: no close belonging to the path. The path can still sit alone on
    // the next line (a cutoff before its close), so cover that line when it
    // carries no bracket — and nothing after it.
    const nextBreak = rest.slice(nextStart).search(/[\r\n]/u);
    const nextLine =
      nextBreak === -1
        ? rest.slice(nextStart)
        : rest.slice(nextStart, nextStart + nextBreak);
    if (nextLine.trim() !== '' && !/[[\]]/u.test(nextLine)) {
      return open + 1 + nextStart + nextLine.length;
    }
  }
  // Splice only to end-of-line so the lines after an abandoned marker survive;
  // a marker on the final line still takes the rest of the text.
  return open + 1 + eol;
}

/**
 * The bracket-balanced end of the span opening at `open`, confined to the
 * span's line. An unbalanced span falls back to end-of-line.
 */
function balancedMarkerEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (char === '\n' || char === '\r') break;
    if (char === '[') depth++;
    else if (char === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  const eol = text.slice(open).search(/[\r\n]/u);
  return eol === -1 ? text.length : open + eol;
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
  // R4-5/R4-6: examine EVERY bracket still unclosed at the cut, rightmost
  // first — not just the brackets after the last `]` before it. A nested `]`
  // anywhere before the cut used to stop the walk (the `open > lastClose`
  // gate), and a walk that hit a non-marker span used to settle for the raw
  // cut — both left the cut inside an enclosing bracketed marker, retaining
  // a bracket-less path fragment no sanitizer recognises. Only brackets still
  // OPEN at the cut can contain it, so pair brackets forward and walk the
  // survivors; a genuine prose bracket contributes nothing and the walk
  // simply passes it, so the bare-`[` collapse the old `return start` guarded
  // against cannot reappear.
  const unclosed: number[] = [];
  for (let i = 0; i < start; i++) {
    const char = text[i];
    if (char === '[') unclosed.push(i);
    else if (char === ']' && unclosed.length > 0) unclosed.pop();
  }
  while (unclosed.length > 0) {
    const open = unclosed.pop()!;
    const candidate = before.slice(open + 1);
    const candidateNewline = candidate.search(/[\r\n]/u);
    if (candidateNewline === -1) {
      // Trim leading whitespace: a spaced opening (`[ FILE: …`) is still
      // marker-shaped, and a cut inside its name must not leave a
      // bracket-less ` FILE: /abs/path]` tail no sanitizer recognises.
      const normalized = candidate.toUpperCase().replace(/^[^\S\r\n]+/u, '');
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
          //
          // Only for a span that really opens a marker, though. An empty
          // candidate (the cut landing right after a `[`) prefix-matches
          // every marker name vacuously, so a prose bracket would take this
          // branch too and discard the whole retained window — the bare-`[`
          // collapse that turned a 28k answer into the truncation marker
          // alone. A span that is not marker-shaped keeps the walk moving
          // left instead (R4-6).
          //
          // R2-7: advance exactly as far as the display stripper strips —
          // including a path line on the next line — so a cross-line marker
          // never deposits a bare path at the head of the retained tail.
          if (!opensMediaMarker(text, open)) continue;
          return partialMarkerResidueEnd(text, open, text.slice(open + 1));
        }
        // R1-11: only skip when the span really completes a marker. A prose
        // bracket like `[IMAGE [FILE: /p]` prefix-matches too, and jumping to
        // the next `]` swallowed an intact marker that was fully inside the
        // retained window — the file then silently never shipped. A spaced
        // opening completes for this purpose even though the finder never
        // delivers it: keeping the raw cut can leave ` FILE: /abs/path]` —
        // no leading bracket for any sanitizer to recognise.
        const completed = `[${candidate}${text.slice(start, close)}]`;
        if (!COMPLETED_MARKER_PATTERN.test(completed)) {
          // R2-12: a bracketed path (`[FILE: /etc/passwd [b] c]`) fails the
          // strict completed regex above, yet it still genuinely opens a
          // marker. Returning the raw cut here dropped the opening bracket
          // and retained a bracket-less `FILE: /abs/path …` fragment that no
          // downstream sanitizer recognises. A span that is not marker-shaped
          // keeps the walk moving left instead (R4-6).
          if (!opensMediaMarker(text, open)) continue;
          // R3-8: advance past the span's balanced bracket extent so the
          // content after a bracketed marker survives. R4-4 — unless the
          // residue continues past that extent on the same line: for shapes
          // like `[FILE: /a [b]] /secret/c.pdf]` the balanced close is the
          // EARLY close of a nested extent, and everything after it up to
          // end-of-line is the bracket-less path fragment the display
          // stripper removes. A dangling `]` there is the tell — with one,
          // advance exactly as far as the stripper strips (R2-7); without
          // one, the tail is bracket-free prose the stripper also keeps.
          const balanced = balancedMarkerEnd(text, open);
          const restAfter = text.slice(balanced);
          const lineBreak = restAfter.search(/[\r\n]/u);
          const sameLineTail =
            lineBreak === -1 ? restAfter : restAfter.slice(0, lineBreak);
          if (sameLineTail.includes(']')) {
            return partialMarkerResidueEnd(text, open, text.slice(open + 1));
          }
          return balanced;
        }
        return close + 1;
      }
    } else {
      // R2-7: the cut sits on a later line of a marker whose first line never
      // closed (`[FILE:\n/path…`). The stripper consumes that shape through
      // the path line; mirror it, or a bare path fragment starts the tail.
      const firstLine = candidate.slice(0, candidateNewline).toUpperCase();
      const trimmedFirst = firstLine.replace(/^[^\S\r\n]+/u, '');
      if (
        MEDIA_MARKER_PREFIXES.some((prefix) => trimmedFirst.startsWith(prefix))
      ) {
        const end = partialMarkerResidueEnd(text, open, text.slice(open + 1));
        // The residue can stop at the marker's own line, which precedes a cut
        // already past it; the prose tail from `start` is safe, and moving
        // backwards would break the `<= limit` guarantee.
        return Math.max(start, end);
      }
    }
  }
  return start;
}

/**
 * The fence delimiter open at `offset`, or undefined outside a fenced block.
 *
 * A retained tail that begins inside a fenced code block has inverted fence
 * parity: {@link maskCode} reads the block's CLOSING fence as an opening one
 * and stops masking real code while unmasking real prose, so a genuine
 * `[FILE: /abs/path]` outside any block survives sanitisation as literal
 * text.
 *
 * R1-2: fence delimiters are matched on the QUOTE-STRIPPED line body, exactly
 * as {@link maskCode} sees them. Matching the raw line made a blockquoted
 * fence invisible here while maskCode masked it, so a cut inside the quoted
 * block emitted no re-opener and the tail's quoted CLOSING fence read as an
 * opening one downstream — the parity inversion this function exists to
 * prevent.
 */
function openFenceAt(text: string, offset: number): string | undefined {
  let fence: { character: '`' | '~'; length: number } | undefined;
  let lineStart = 0;
  while (lineStart < offset) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/u, '');
    const body = withoutQuotePrefix(line);
    if (fence) {
      const closing = body.match(/^ {0,3}(`+|~+)[\t ]*$/u)?.[1];
      if (closing?.[0] === fence.character && closing.length >= fence.length) {
        fence = undefined;
      }
    } else {
      const opening = body.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
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

/**
 * The retained tail always starts a fresh line — the truncation marker ends
 * with a newline — so when the cut drops the prose prefix of a mid-line
 * backtick/tilde run, the run becomes a line-start fence OPENER that was
 * never one in the source text. Every downstream sanitizer then masks the
 * tail to end-of-text and the genuine markers it exists to protect ship as
 * literal text. Returns the position just past the created run when the cut
 * created such an opener, otherwise `start` unchanged.
 *
 * R4-7: the advance covers the created run itself (indent plus delimiter),
 * not the rest of its line. Jumping to the next newline discarded the entire
 * rest of a long or newline-free line, collapsing the retained window to the
 * bare truncation marker. Starting the tail at the run's info text opens no
 * fence — the run's parity is gone with the dropped prefix — and keeps the
 * line.
 */
function advancePastCreatedFenceOpener(text: string, start: number): number {
  if (start === 0 || start >= text.length) return start;
  const tailMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(text.slice(start));
  if (!tailMatch) return start;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const dropped = text.slice(lineStart, start);
  const tailIndent = tailMatch[0].length - tailMatch[1].length;
  // An all-space dropped prefix that keeps the run within the three-space
  // fence indent means the run opened a fence in the ORIGINAL text too — the
  // tail's parity is the document's own, so keep it.
  if (/^ {0,3}$/u.test(dropped) && dropped.length + tailIndent <= 3) {
    return start;
  }
  return start + tailMatch[0].length;
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
  let reopen: string | undefined;
  // R1-3: the re-opener has to be RESERVED, not prepended on top of a tail
  // already sized to the whole budget — that returned up to
  // `limit + fence.length + 1` characters and broke the `<= limit` guarantee
  // `withSenderPrefix`'s budget arithmetic depends on. Re-cut with the prefix
  // paid for, then re-check the fence at the moved start (it can change, and a
  // longer delimiter must not reintroduce the overrun).
  for (let pass = 0; pass < 8; pass++) {
    const advanced = advancePastCreatedFenceOpener(text, start);
    if (advanced !== start) {
      start = markerSafeTruncationStart(text, advanced);
      // The fence state at the moved start is unknown; a stale re-opener
      // would ride the prefix UNRESERVED if the loop exhausted its passes.
      reopen = undefined;
      continue;
    }
    reopen = openFenceAt(text, start);
    if (!reopen) break;
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

export function stripPartialOutboundMediaMarker(
  text: string,
  markerName: 'IMAGE' | 'FILE',
  pendingText: string,
): string {
  const prefix = `${markerName}:`;
  const completedPattern = new RegExp(
    `^${prefix}[^\\S\\r\\n]*[^\\[\\]\\r\\n]+\\]$`,
    'iu',
  );
  // Walk the RAW text, not maskCode(text). Masking exists to keep the finder
  // from delivering files quoted in code; it must not also hide strippable
  // residue from the display sanitizer. An abandoned marker inside a fence or
  // inline span still ships its absolute path to the card, so it is stripped
  // here. A COMPLETE well-formed marker keeps its `]`, which this pass never
  // removes, so the pinned "a marker quoted in code is left alone" behaviour
  // survives.
  //
  // R6-6: completeness, however, is the finder's question, and the finder
  // decides deliverability on `maskCode(text)`. A marker whose body is
  // visible prose but whose closing `]` sits inside an inline code span is
  // deliverable to neither layer — the finder matches nothing, so nothing
  // ever replaces it, while the raw `completedPattern` rated it complete and
  // left the absolute path in the text. Mixed visibility is residue. The
  // pinned trade covers the marker quoted in code WHOLE, which is recognised
  // here by its opening `[` being masked too.
  const maskedText = maskCode(text);
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
    // R3-9: residue opens only with the FULL marker name. Bare name prefixes
    // (`[i`, `[im`) are prose — substituting them minted `[Image pending]`
    // claims the delivery path can never honour.
    const normalized = candidate.toUpperCase();
    const immediate = normalized.startsWith(prefix);
    // R3-1: a spaced opening (`[ FILE: /path]`) matches no delivery grammar —
    // well-formed or not it can never be delivered, so it can only ship its
    // path as literal text. Strip it as residue; a well-formed marker with an
    // immediate opening keeps the pinned leave-alone behaviour.
    const spaced =
      !immediate && normalized.replace(/^[^\S\r\n]+/u, '').startsWith(prefix);
    if (immediate || spaced) {
      const closeIdx = candidate.indexOf(']');
      // The whole marker is quoted only when its own `[` is masked; a masked
      // `]` under a visible `[` is the mixed shape the finder drops.
      const quotedWhole = maskedText[open] !== '[';
      const closeDeliverable =
        closeIdx !== -1 &&
        (quotedWhole || maskedText[open + 1 + closeIdx] === ']');
      const complete =
        immediate &&
        closeDeliverable &&
        completedPattern.test(candidate.slice(0, closeIdx + 1));
      if (!complete) {
        // R1-4: a marker whose close sits on a LATER line is matched by no
        // layer — the same-line grammar misses it and the finder never sees
        // it — so it shipped as literal text with the absolute path. R3-1:
        // the same holds for a same-line `]` that does not complete the
        // marker (a bracketed path) — after the replace pass every
        // well-formed marker is gone, so such an opening is ill-formed
        // residue regardless of inner brackets; prose brackets like `[note]`
        // never prefix-match a marker name.
        spans.push({
          start: open,
          end: partialMarkerResidueEnd(text, open, rest),
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
