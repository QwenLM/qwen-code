import { maskCode, openFenceAt } from './markdown-state.js';

export interface OutboundMediaMarker {
  start: number;
  end: number;
  path: string;
}

const MEDIA_MARKER_PREFIXES = ['IMAGE:', 'FILE:'];
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
  let index = open + 1;
  while (index < text.length && /[^\S\r\n]/u.test(text[index]!)) index++;
  let upper = '';
  while (index < text.length) {
    const char = text[index]!;
    if (char === '\r' || char === '\n') return false;
    upper += char.toUpperCase();
    index++;
    if (MEDIA_MARKER_PREFIXES.includes(upper)) return true;
    if (!MEDIA_MARKER_PREFIXES.some((prefix) => prefix.startsWith(upper))) {
      return false;
    }
  }
  return false;
}

/**
 * The absolute index where the path part of a marker opening starts — after
 * the marker name and its separating spaces — or `-1` when the text between
 * `start` and `lineEnd` does not open with a marker name.
 *
 * R6-2: the same `toUpperCase` fold {@link opensMediaMarker} recognises with,
 * carried down to the offset in the ORIGINAL text. Uppercasing is not a
 * length-preserving map — `'ﬁ'.toUpperCase()` is `'FI'` — so the name cannot
 * be measured on an uppercased copy and sliced off the raw one; fold one
 * source character at a time and cut where the accumulated uppercase
 * completes a name. An `iu`-flagged regex is not a substitute: it rejects
 * `'ı'` for `'I'` and `'ﬁ'` for `'FI'`, which is exactly the divergence
 * R5-2/R5-3 closed for the truncation guard's gates.
 *
 * R3-11: walks the ORIGINAL text by index instead of copying the line — the
 * per-bracket line copies were the sweep's quadratic factor.
 */
function markerPathStart(text: string, start: number, lineEnd: number): number {
  let index = start;
  while (index < lineEnd && /[^\S\r\n]/u.test(text[index]!)) index++;
  let upper = '';
  for (; index < lineEnd; index++) {
    upper += text[index]!.toUpperCase();
    if (MEDIA_MARKER_PREFIXES.includes(upper)) {
      index++;
      while (index < lineEnd && /[^\S\r\n]/u.test(text[index]!)) index++;
      return index;
    }
    if (!MEDIA_MARKER_PREFIXES.some((prefix) => prefix.startsWith(upper))) {
      return -1;
    }
  }
  return -1;
}

/**
 * The visibility of a marker span relative to the code mask: `visible` when
 * the whole span is outside code, `quoted` when it is entirely inside code,
 * `mixed` when part of it is masked and part is not.
 *
 * R19-x (R6-3 closure): this is the ONE deliverability predicate the finder,
 * the stripper and the truncation guard share. A `mixed` span is deliverable
 * to NO layer — the finder's masked regex cannot match it whole — yet the raw
 * views used to rate it complete kept shipping or skipping it. `visible`
 * spans are delivered, `quoted` spans keep the pinned leave-alone trade (a
 * marker quoted in code whole is shown verbatim), and `mixed` spans are
 * residue: stripped fail-closed, never rated complete.
 */
type MarkerVisibility = 'visible' | 'quoted' | 'mixed';

function markerVisibility(
  text: string,
  maskedText: string,
  open: number,
  close: number,
): MarkerVisibility {
  let sawVisible = false;
  let sawMasked = false;
  for (let i = open; i <= close && i < text.length; i++) {
    const char = text[i]!;
    // Masking blanks code to spaces, so a space in the source is
    // indistinguishable from the mask and cannot rate the span — only the
    // brackets and the body's non-space characters decide.
    if (/[^\S\r\n]/u.test(char)) continue;
    if (maskedText[i] === char) sawVisible = true;
    else sawMasked = true;
    if (sawVisible && sawMasked) return 'mixed';
  }
  return sawMasked ? 'quoted' : 'visible';
}

/** The earliest line break at or after `from`, or -1 when none remains. */
function lineEndAt(text: string, from: number): number {
  const newline = text.indexOf('\n', from);
  const carriage = text.indexOf('\r', from);
  if (newline === -1) return carriage;
  if (carriage === -1) return newline;
  return Math.min(newline, carriage);
}

/** Step past a line break at `eol` (a CRLF pair counts as one break). */
function nextLineStart(text: string, eol: number): number {
  return text[eol] === '\r' && text[eol + 1] === '\n' ? eol + 2 : eol + 1;
}

interface ResidueContinuationMemo {
  exact: Map<number, Map<number, number>>;
  noCloseMinDepth: Map<number, number>;
  noCloseAnyDepth: Set<number>;
  stops: Map<number, { minDepth: number; result: number }>;
}

/**
 * The balance-aware continuation of an unclosed marker's residue over the
 * lines AFTER the marker's own line, starting at `pos` with the bracket
 * `depth` the marker line ended on. Returns the exclusive end of the
 * continuation, or -1 when the next line already ends the residue.
 *
 * The marker's own `[` still wants its close, so the walk follows bracket
 * balance instead of stopping at the first shape it cannot classify:
 * - a `]` bringing the depth to 0 closes the marker — the continuation runs
 *   through it (a path deposited alone on the next line, bracketed inner
 *   fragments on the marker line like `[FILE: [draft]\n/path]`);
 * - a bracket-free line is the path line itself — covered whole, and the
 *   walk stops;
 * - a blank line cannot carry the path — the walk continues past it;
 * - a line OPENING with brackets continues the marker's bracket structure
 *   (a decoy like `[decoy]` or a nested unclosed bracket) — the walk
 *   continues with the updated depth;
 * - any other bracket stops the walk at the bracket-free PREFIX before it —
 *   a bracketed path line keeps its bracketed prose but loses the bracket-less
 *   path fragment at its head.
 *
 * R22-4: a run of marker-shaped brackets used to re-walk the same tail once
 * per bracket — quadratic at CONTENT_LIMIT. The walk's outcome is fully
 * determined by the (line, depth) state it enters a line with, so every
 * state the walk visits shares the outcome: one walk caches the whole tail
 * for every later bracket starting inside it. Never-closing is monotone in
 * depth — a depth that reaches end-of-text without balancing leaves every
 * larger depth unbalanced too — which the no-close cache uses to answer
 * deeper repeats without walking at all.
 *
 * R25-1: the no-close caches never fire for a walk that STOPS — a nested
 * depth ladder followed by bracket-free prose enters every ladder line at a
 * depth no earlier walk used, so no (line, depth) key repeats. A stop that
 * never closed is depth-independent: a deeper entry reaches the same stop
 * line without closing anywhere on the way (line classification is
 * depth-independent and the result is monotone in depth), so the walk now
 * records those stops per visited line and consults the memo on EVERY line
 * it enters, not just the walk's first.
 */
function residueContinuationEnd(
  text: string,
  pos: number,
  depth: number,
  memo?: ResidueContinuationMemo,
): number {
  if (memo) {
    if (memo.noCloseAnyDepth.has(pos)) return -1;
    const exact = memo.exact.get(pos)?.get(depth);
    if (exact !== undefined) return exact;
    const noClose = memo.noCloseMinDepth.get(pos);
    if (noClose !== undefined && depth >= noClose) return -1;
    const stop = memo.stops.get(pos);
    if (stop !== undefined && depth >= stop.minDepth) return stop.result;
  }
  const trajectory: Array<{ line: number; depth: number }> = [];
  let lineStart = pos;
  let openDepth = depth;
  let result = -1;
  let sawClose = false;
  let closed = false;
  while (lineStart < text.length && openDepth > 0) {
    // R25-1: a line entered deep enough into a known no-close tail or a
    // recorded depth-independent stop answers without re-walking it.
    if (memo) {
      if (memo.noCloseAnyDepth.has(lineStart)) {
        result = -1;
        break;
      }
      const noClose = memo.noCloseMinDepth.get(lineStart);
      if (noClose !== undefined && openDepth >= noClose) {
        result = -1;
        break;
      }
      const stop = memo.stops.get(lineStart);
      if (stop !== undefined && openDepth >= stop.minDepth) {
        result = stop.result;
        break;
      }
    }
    trajectory.push({ line: lineStart, depth: openDepth });
    const eol = lineEndAt(text, lineStart);
    const lineEnd = eol === -1 ? text.length : eol;
    let d = openDepth;
    let firstOpen = -1;
    let closedAt = -1;
    for (let i = lineStart; i < lineEnd; i++) {
      const char = text[i];
      if (char === '[') {
        if (firstOpen === -1) firstOpen = i;
        d++;
      } else if (char === ']') {
        sawClose = true;
        d--;
        if (d === 0) {
          closedAt = i;
          break;
        }
      }
    }
    if (closedAt !== -1) {
      result = closedAt + 1;
      closed = true;
      break;
    }
    if (firstOpen === -1) {
      if (blankRange(text, lineStart, lineEnd)) {
        lineStart = nextLineStart(
          text,
          lineEnd === text.length ? lineEnd : eol,
        );
        if (lineEnd === text.length) break;
        continue;
      }
      result = lineEnd;
      break;
    }
    if (firstOpen > lineStart) {
      result = firstOpen;
      break;
    }
    openDepth = d;
    if (lineEnd === text.length) break;
    lineStart = nextLineStart(text, eol);
  }
  if (memo) {
    // A walk that reached end-of-text without ever scanning a `]` can
    // never close for ANY entry depth — line classification (prose stop,
    // blank continuation, bracket-leading continuation) is itself
    // depth-independent — so every line it visited answers deeper repeats
    // without walking at all.
    if (result === -1 && !sawClose) {
      for (const state of trajectory) {
        memo.noCloseAnyDepth.add(state.line);
      }
    } else if (closed) {
      // Where a CLOSING walk stops depends on the entry depth — record the
      // exact (line, depth) states only.
      for (const state of trajectory) {
        let atPos = memo.exact.get(state.line);
        if (!atPos) {
          atPos = new Map();
          memo.exact.set(state.line, atPos);
        }
        if (!atPos.has(state.depth)) atPos.set(state.depth, result);
      }
    } else if (result === -1) {
      for (const state of trajectory) {
        const known = memo.noCloseMinDepth.get(state.line);
        if (known === undefined || state.depth < known) {
          memo.noCloseMinDepth.set(state.line, state.depth);
        }
      }
    } else {
      // R25-1: a stop WITHOUT a close (a bracket-free path line or the
      // prefix before a mid-line bracket) stops at the same position for
      // every deeper entry depth too — a deeper walk cannot close anywhere
      // the recorded one did not, so it reaches the same stop line. Record
      // the minimum entry depth per line and replay the stop for deeper
      // repeats instead of re-walking the ladder to it.
      for (const state of trajectory) {
        const known = memo.stops.get(state.line);
        if (known === undefined || state.depth < known.minDepth) {
          memo.stops.set(state.line, { minDepth: state.depth, result });
        }
      }
    }
  }
  return result;
}

/**
 * The end of the residue of an unclosed or ill-formed marker opening at
 * `open`.
 *
 * The residue always covers the marker's own line. It reaches onto LATER
 * lines only for the shapes the same-line grammar cannot see — and only when
 * the marker's own line carries no deliverable path: a path already present
 * there means later brackets belong to prose, so the prose must survive (the
 * bracket-free trailing segment is the path, never prose between marker and
 * close). The continuation itself is balance-aware, see
 * {@link residueContinuationEnd}.
 *
 * R3-11: every probe is an index walk over the ORIGINAL text — the per-call
 * `rest` copy plus its searches and slices ran per bracket and made the
 * fixed-point sweep quadratic at CONTENT_LIMIT.
 */
function partialMarkerResidueEnd(
  text: string,
  open: number,
  memo?: ResidueContinuationMemo,
): number {
  const base = open + 1;
  const eolAbs = lineEndAt(text, base);
  if (eolAbs === -1) return text.length;
  // R3-4: what remains after the marker name. Empty (the path starts on the
  // next line) or bracketed (never a deliverable path) both let the strip
  // continue past the marker's own line; a real same-line path stops it.
  // R6-2: fold case exactly as the recognition gates do. An `iu` regex left
  // the name in the path part for `[FıLE:` / `[ﬁLE:` — openings
  // `toUpperCase` recognition accepts — so `pathCouldContinue` was false and
  // the residue stopped at the marker's own line, stranding the bare path
  // line below it with no leading `[` for any backward walk to find.
  const pathStart = markerPathStart(text, base, eolAbs);
  let pathCouldContinue = false;
  if (pathStart !== -1) {
    const bracket = text.indexOf('[', pathStart);
    pathCouldContinue =
      pathStart === eolAbs || (bracket !== -1 && bracket < eolAbs);
  }
  if (pathCouldContinue) {
    // The marker's own opening bracket plus whatever its line left
    // unclosed. A same-line close belongs to an INNER bracket unless it
    // brings this depth to 0 — a marker with an inner pair on its own line
    // stays open through it, and only depth 0 means the marker itself
    // closed on its own line.
    let depth = 1;
    for (let i = base; i < eolAbs; i++) {
      if (text[i] === '[') depth++;
      else if (text[i] === ']') depth = Math.max(0, depth - 1);
    }
    if (depth > 0) {
      const end = residueContinuationEnd(
        text,
        nextLineStart(text, eolAbs),
        depth,
        memo,
      );
      if (end !== -1) return end;
    }
  }
  // Splice only to end-of-line so the lines after an abandoned marker survive;
  // a marker on the final line still takes the rest of the text.
  return eolAbs;
}

function blankRange(text: string, start: number, end: number): boolean {
  for (let index = start; index < end; index++) {
    if (!/[^\S\r\n]/u.test(text[index]!)) return false;
  }
  return true;
}

interface BalancedEndMemo {
  byOpen: Map<number, number>;
  lines: Set<number>;
}

/**
 * The bracket-balanced end of the span opening at `open`, confined to the
 * span's line. An unbalanced span falls back to end-of-line.
 *
 * R22-4: memoized per line — one pairing pass answers every bracket on the
 * line instead of re-walking it per bracket, and the unbalanced fallback is
 * the allocation-free {@link lineEndAt} instead of a remainder copy and
 * search.
 */
function balancedMarkerEnd(
  text: string,
  open: number,
  memo: BalancedEndMemo,
): number {
  const cached = memo.byOpen.get(open);
  if (cached !== undefined) return cached;
  const lineEnd = lineEndAt(text, open);
  const end = lineEnd === -1 ? text.length : lineEnd;
  const prevBreak = Math.max(
    text.lastIndexOf('\n', open - 1),
    text.lastIndexOf('\r', open - 1),
  );
  const lineStart = prevBreak + 1;
  if (!memo.lines.has(lineStart)) {
    memo.lines.add(lineStart);
    const stack: number[] = [];
    for (let i = lineStart; i < end; i++) {
      const char = text[i];
      if (char === '[') stack.push(i);
      else if (char === ']' && stack.length > 0) {
        memo.byOpen.set(stack.pop()!, i + 1);
      }
    }
    for (const unclosed of stack) memo.byOpen.set(unclosed, end);
  }
  return memo.byOpen.get(open)!;
}

/**
 * The marker shape of the span opening at `open`, classified against the cut
 * at `start` by one capped index walk over the ORIGINAL text (R16-3): the
 * per-bracket slice/uppercase copies of the retained window were the
 * truncation guard's quadratic factor on a single-line run of unclosed
 * brackets. A `same-line-*` verdict carries no newline between the bracket
 * and the cut; `cross-line-named` means the cut sits on a later line but the
 * span's own line still starts with a full marker name; `undefined` means
 * the span is not marker-shaped. Case folds one source character at a time
 * exactly as the recognition gates do (R6-2). `cutLineStart` is the start of
 * the line containing the cut.
 *
 * R25-1: whether the cut sits on a LATER line than a completed name is one
 * comparison against `cutLineStart` — the per-bracket newline scan over the
 * whole window between name and cut was one of the guard's two remaining
 * quadratic factors on a multi-line bracket run.
 */
function markerSpanShape(
  text: string,
  open: number,
  start: number,
  cutLineStart: number,
): 'same-line-prefix' | 'same-line-named' | 'cross-line-named' | undefined {
  let index = open + 1;
  while (index < start && /[^\S\r\n]/u.test(text[index]!)) index++;
  let upper = '';
  while (index < start) {
    const char = text[index]!;
    if (char === '\r' || char === '\n') {
      return MEDIA_MARKER_PREFIXES.includes(upper)
        ? 'cross-line-named'
        : undefined;
    }
    upper += char.toUpperCase();
    index++;
    if (MEDIA_MARKER_PREFIXES.includes(upper)) {
      return cutLineStart > index ? 'cross-line-named' : 'same-line-named';
    }
    if (!MEDIA_MARKER_PREFIXES.some((prefix) => prefix.startsWith(upper))) {
      return undefined;
    }
  }
  return 'same-line-prefix';
}

/**
 * Marker openings are recognised only when the whole marker fits on one line,
 * matching {@link mediaMarkerPattern}. An empty candidate (the cut landing
 * between `[` and `FILE:`) is a valid prefix of every marker name and must
 * advance the cut too, otherwise the retained tail starts with a bare
 * `FILE: /abs/path]` fragment that no downstream sanitizer can recognise.
 *
 * R19-x (R6-3 closure): every unclosed marker-shaped bracket proposes how far
 * the cut must move, and the guard advances to the MAX of all proposals
 * instead of returning on the first (rightmost) one. A nested marker's inner
 * span used to end the walk early, leaving the outer span's path fragment in
 * the retained tail (`[FILE: [FILE: /in] /etc/shadow]` cut inside the inner
 * shipped the outer's remainder).
 *
 * R19-x (R6-3 closure): the completed-marker test shares the visibility
 * predicate. A span whose `]` or body sits inside code is complete to the RAW
 * regex but deliverable to NO layer — rating it complete moved the cut past
 * it and deposited bracket-less path fragments at the head of the tail.
 */
function markerSafeTruncationStart(
  text: string,
  maskedText: string,
  start: number,
): number {
  const unclosed: number[] = [];
  for (let i = 0; i < start; i++) {
    const char = text[i];
    if (char === '[') unclosed.push(i);
    else if (char === ']' && unclosed.length > 0) unclosed.pop();
  }
  // R16-3: hoisted out of the per-bracket walk — the first close after the
  // cut and the cut-to-close newline probe are the same for every bracket,
  // and {@link markerSpanShape} reads the ORIGINAL text by index with a
  // name-length cap instead of copying the retained window per bracket.
  // R25-1: the cut's own line start, hoisted once — markerSpanShape's
  // same-vs-cross verdict is one comparison against it instead of a
  // per-bracket newline scan over the whole anchored window.
  const cutLineStart =
    start === 0
      ? 0
      : Math.max(
          text.lastIndexOf('\n', start - 1),
          text.lastIndexOf('\r', start - 1),
        ) + 1;
  const close = text.indexOf(']', start);
  let cutToCloseCrossesLine = false;
  if (close !== -1) {
    for (let i = start; i < close; i++) {
      if (text[i] === '\r' || text[i] === '\n') {
        cutToCloseCrossesLine = true;
        break;
      }
    }
  }
  // R4-5/R4-6: examine EVERY bracket still unclosed at the cut, rightmost
  // first — not just the brackets after the last `]` before it. Only
  // brackets still OPEN at the cut can contain it, so pair brackets forward
  // and walk the survivors; a genuine prose bracket contributes nothing and
  // the walk simply passes it, so the bare-`[` collapse the old
  // `return start` guarded against cannot reappear.
  //
  // R22-4: the completed-marker test used to slice the ENTIRE retained
  // window per bracket and re-walk it for visibility and balance — the
  // guard's quadratic factor on a single-line bracket run. The visibility
  // verdict now accumulates across the nested spans (each character visited
  // once), the interior-bracket check is one `indexOf`, the balanced extent
  // shares one pairing pass per line, and the walk stops once `advanced`
  // reaches end-of-text.
  let visLeft = close + 1;
  let sawVisible = false;
  let sawMasked = false;
  const balancedMemo: BalancedEndMemo = { byOpen: new Map(), lines: new Set() };
  const continuationMemo: ResidueContinuationMemo = {
    exact: new Map(),
    noCloseMinDepth: new Map(),
    noCloseAnyDepth: new Set(),
    stops: new Map(),
  };
  let advanced = start;
  while (unclosed.length > 0) {
    const open = unclosed.pop()!;
    const shape = markerSpanShape(text, open, start, cutLineStart);
    if (shape === undefined) continue;
    if (shape === 'cross-line-named') {
      // R2-7: the cut sits on a later line of a marker whose first line
      // never closed (`[FILE:\n/path…`). The stripper consumes that shape
      // through the path line; mirror it, or a bare path fragment starts the
      // tail. The residue can stop at the marker's own line, which precedes
      // a cut already past it; `advanced` never moves backwards, keeping the
      // `<= limit` guarantee.
      advanced = Math.max(
        advanced,
        partialMarkerResidueEnd(text, open, continuationMemo),
      );
      if (advanced >= text.length) break;
      continue;
    }
    if (close === -1 || cutToCloseCrossesLine) {
      // R1-7: no same-line close, so the cut sits inside an UNCLOSED
      // marker. Returning raw `start` dropped the opening `[` and left a
      // bare `FILE: /abs/path` fragment that no sanitizer recognises —
      // truncation defeating the stripper and leaking the full path.
      //
      // Only for a span that really opens a marker, though. An empty
      // candidate (the cut landing right after a `[`) prefix-matches every
      // marker name vacuously, so a prose bracket would take this branch
      // too and discard the whole retained window — the bare-`[` collapse
      // that turned a 28k answer into the truncation marker alone. A span
      // that is not marker-shaped keeps the walk moving left instead
      // (R4-6).
      //
      // R2-7: advance exactly as far as the display stripper strips —
      // including a path line on the next line — so a cross-line marker
      // never deposits a bare path at the head of the retained tail.
      if (!opensMediaMarker(text, open)) continue;
      advanced = Math.max(
        advanced,
        partialMarkerResidueEnd(text, open, continuationMemo),
      );
      if (advanced >= text.length) break;
      continue;
    }
    // R22-4: extend the shared visibility window leftward to this span —
    // popped brackets nest around the same close, so the union of their
    // spans is scanned once, not once per bracket.
    for (let i = open; i < visLeft; i++) {
      const char = text[i]!;
      if (/[^\S\r\n]/u.test(char)) continue;
      if (maskedText[i] === char) sawVisible = true;
      else sawMasked = true;
    }
    visLeft = open;
    const visibility =
      sawVisible && sawMasked ? 'mixed' : sawMasked ? 'quoted' : 'visible';
    // R1-11: only skip when the span really completes a marker. A prose
    // bracket like `[IMAGE [FILE: /p]` prefix-matches too, and jumping to
    // the next `]` swallowed an intact marker that was fully inside the
    // retained window — the file then silently never shipped. A spaced
    // opening completes for this purpose even though the finder never
    // delivers it: keeping the raw cut can leave ` FILE: /abs/path]` — no
    // leading bracket for any sanitizer to recognise.
    //
    // R22-4: completeness without the retained-window slice. The span is
    // newline-free by shape (`same-line-*`) and the cut-to-close probe; a
    // bracket inside it fails the delivery grammar's path class, and a
    // `]` between `open` and the cut would either have popped `open` out
    // of the unclosed stack or implies an interior `[` the same probe
    // sees. What remains of the pattern is the immediate name (the same
    // `iu` verdict as before) and at least one path character after it.
    const nextOpen = text.indexOf('[', open + 1);
    let completed = false;
    if ((nextOpen === -1 || nextOpen >= close) && visibility !== 'mixed') {
      const nameMatch = /^\[(?:IMAGE:|FILE:)/iu.exec(
        `[${text.slice(open + 1, Math.min(open + 8, close))}`,
      );
      completed =
        nameMatch !== null && close - (open + nameMatch[0].length) >= 1;
    }
    if (completed) {
      advanced = Math.max(advanced, close + 1);
      continue;
    }
    // R2-12: a bracketed path (`[FILE: /etc/passwd [b] c]`) fails the
    // completed test above, yet it still genuinely opens a marker — and a
    // MIXED-visibility span is residue to every layer even when the raw
    // regex rated it complete. Returning the raw cut here dropped the
    // opening bracket and retained a bracket-less `FILE: /abs/path …`
    // fragment that no downstream sanitizer recognises. A span that is not
    // marker-shaped keeps the walk moving left instead (R4-6).
    if (!opensMediaMarker(text, open)) continue;
    // R3-8: advance past the span's balanced bracket extent so the
    // content after a bracketed marker survives. R4-4 — unless the
    // residue continues past that extent on the same line: for shapes
    // like `[FILE: /a [b]] /secret/c.pdf]` the balanced close is the
    // EARLY close of a nested extent, and everything after it up to
    // end-of-line is the bracket-less path fragment the display stripper
    // removes. A dangling `]` there is the tell — with one, advance
    // exactly as far as the stripper strips (R2-7); without one, the
    // tail is bracket-free prose the stripper also keeps.
    const balanced = balancedMarkerEnd(text, open, balancedMemo);
    const sameLineEnd = lineEndAt(text, balanced);
    const danglingClose = text.indexOf(']', balanced);
    if (
      danglingClose !== -1 &&
      (sameLineEnd === -1 || danglingClose < sameLineEnd)
    ) {
      advanced = Math.max(
        advanced,
        partialMarkerResidueEnd(text, open, continuationMemo),
      );
      if (advanced >= text.length) break;
      continue;
    }
    advanced = Math.max(advanced, balanced);
    if (advanced >= text.length) break;
  }
  return advanced;
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
  // One mask for the whole truncation: the guard's visibility checks and the
  // re-cut loop all rate the same text.
  const maskedText = maskCode(text);
  if (limit <= truncationMarker.length) {
    return text.slice(
      markerSafeTruncationStart(text, maskedText, text.length - limit),
    );
  }
  let start = markerSafeTruncationStart(
    text,
    maskedText,
    text.length - (limit - truncationMarker.length),
  );
  // Re-open a fence the cut landed inside, so the tail keeps the parity every
  // downstream consumer assumes: the code masker, and DingTalk's own renderer.
  let reopen: string | undefined;
  let snapped = false;
  // R1-3: the re-opener has to be RESERVED, not prepended on top of a tail
  // already sized to the whole budget — that returned up to
  // `limit + fence.length + 1` characters and broke the `<= limit` guarantee
  // `withSenderPrefix`'s budget arithmetic depends on. Re-cut with the prefix
  // paid for, then re-check the fence at the moved start (it can change, and a
  // longer delimiter must not reintroduce the overrun).
  for (let pass = 0; pass < 8; pass++) {
    const advanced = advancePastCreatedFenceOpener(text, start);
    if (advanced !== start) {
      start = markerSafeTruncationStart(text, maskedText, advanced);
      // The fence state at the moved start is unknown; a stale re-opener
      // would ride the prefix UNRESERVED if the loop exhausted its passes.
      reopen = undefined;
      continue;
    }
    const fence = openFenceAt(text, start);
    if (!fence) {
      reopen = undefined;
      break;
    }
    // A quoted fence closes only on a quoted line. Re-opening with a bare
    // delimiter above a tail whose first line lost its `> ` leaves the block
    // open to end of text, so the closing `> ```<` reads as content and every
    // marker after the block is masked out of the finder's reach — the exact
    // parity inversion the re-opener exists to prevent. Start the tail on a
    // whole quoted line and re-open with the prefix the block actually has.
    if (fence.quoteDepth > 0 && !snapped) {
      snapped = true;
      const lineEnd = text.indexOf('\n', start);
      if (lineEnd !== -1) {
        start = markerSafeTruncationStart(text, maskedText, lineEnd + 1);
        reopen = undefined;
        continue;
      }
    }
    // R19-x (R6-3 closure): re-open at the fence's OWN blockquote depth — a
    // depth-2 fence re-opened with one `> ` inverted every parity assumption
    // below it.
    reopen = `${'> '.repeat(fence.quoteDepth)}${fence.delimiter}`;
    const budget = limit - truncationMarker.length - reopen.length - 1;
    if (budget <= 0) {
      // R2-4: breaking with `reopen` still set prepended an UNRESERVED
      // re-opener on top of a tail already sized to the whole budget, running
      // the result over `limit`. Fence parity is cosmetic; the `<= limit`
      // guarantee is load-bearing, so drop the re-opener instead.
      reopen = undefined;
      break;
    }
    const movedStart = markerSafeTruncationStart(
      text,
      maskedText,
      text.length - budget,
    );
    if (movedStart === start) break;
    start = movedStart;
  }
  const prefix = reopen ? `${truncationMarker}${reopen}\n` : truncationMarker;
  return `${prefix}${text.slice(start)}`;
}

/**
 * The bracket balance of text[start, end): `[` adds one, `]` removes one,
 * floored at 0. A positive result means the range leaves that many bracket
 * openings unclosed.
 */
export function bracketDepth(text: string, start: number, end: number): number {
  let depth = 0;
  for (let i = start; i < end && i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']') depth = Math.max(0, depth - 1);
  }
  return depth;
}

/**
 * The residue balance obligation `text[start, end)` leaves open, counting
 * only marker-shaped openings: like {@link bracketDepth}, but a `[` adds to
 * the depth only when it opens a marker-name residue of EITHER kind
 * (immediate or spaced). A prose `[` owns no obligation — counting one
 * deleted legitimate prose from delivered messages whenever an unclosed
 * prose bracket preceded a deliverable marker, and de-protected a kept
 * marker nested in prose brackets (R24-1/R24-2).
 */
export function markerResidueDepth(
  text: string,
  start: number,
  end: number,
): number {
  let depth = 0;
  for (let i = start; i < end && i < text.length; i++) {
    if (text[i] === '[') {
      if (
        markerOpeningShape(text, i, 'FILE:') !== undefined ||
        markerOpeningShape(text, i, 'IMAGE:') !== undefined
      ) {
        depth++;
      }
    } else if (text[i] === ']') {
      depth = Math.max(0, depth - 1);
    }
  }
  return depth;
}

/**
 * When `depth` is positive the gap starts INSIDE an unclosed bracket opening
 * from the text before it — an ill-formed outer marker whose balanced extent
 * runs on past the deliverable marker the gap follows. That residue owns the
 * gap up to the balancing close; without removing it, a nested shape like
 * `[FILE: [FILE: /in] /etc/shadow]` delivers the inner marker and ships the
 * outer's bracket-less path fragment. A gap whose balance never closes is
 * residue to its end — except the line breaks survive: residue extents are
 * line-disciplined, and deleting a gap's final newline merges the NEXT kept
 * marker onto the residue's own line, where a later sweep's same-line residue
 * eats it (R24-2: a deliverable FILE marker lost to an `[IMAGE:` opening two
 * sweeps earlier). Newlines carry no path; keeping them is fail-safe.
 */
export function dropUnbalancedGapPrefix(gap: string, depth: number): string {
  if (depth <= 0) return gap;
  let d = depth;
  for (let i = 0; i < gap.length; i++) {
    const char = gap[i];
    if (char === '[') d++;
    else if (char === ']') {
      d--;
      if (d === 0) return gap.slice(i + 1);
    }
  }
  return gap.replace(/[^\r\n]/gu, '');
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
    // R19-x (R6-3 closure): the SAME visibility predicate the stripper and
    // the truncation guard use. The regex runs on the MASKED text, so a span
    // whose body only partially sits in code still matches — with the masked
    // part blanked to spaces — and delivered a mutated path (a marker body
    // dipping into a codespan shipped the unmasked remainder as the path).
    // A span the mask altered is deliverable to no layer; the stripper
    // rates it residue.
    const end = match.index + match[0].length;
    let fullyVisible = true;
    for (let i = match.index; i < end; i++) {
      if (visibleText[i] !== text[i]) {
        fullyVisible = false;
        break;
      }
    }
    if (!fullyVisible) continue;
    markers.push({ start: match.index, end, path });
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
 * Whether the `[` at `open` opens a residue of the marker named by `prefix`:
 * the full name immediately after the bracket (`immediate`) or after leading
 * horizontal spaces (`spaced`), confined to the bracket's line. Folds case
 * one source character at a time exactly as the recognition gates do (R6-2).
 * R3-11: walks the name region of the ORIGINAL text without copying the
 * line, so a text full of brackets costs a name-length probe per bracket.
 */
function markerOpeningShape(
  text: string,
  open: number,
  prefix: string,
): 'immediate' | 'spaced' | undefined {
  let upper = '';
  let sawLeadingSpace = false;
  for (let index = open + 1; index < text.length; index++) {
    const char = text[index]!;
    if (char === '\r' || char === '\n') return undefined;
    if (upper === '' && /[^\S\r\n]/u.test(char)) {
      sawLeadingSpace = true;
      continue;
    }
    upper += char.toUpperCase();
    if (upper === prefix) {
      return sawLeadingSpace ? 'spaced' : 'immediate';
    }
    if (!prefix.startsWith(upper)) return undefined;
  }
  return undefined;
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
  // R6-6 superset (R19-x / R6-3 closure): completeness is decided by the ONE
  // visibility predicate the finder and the truncation guard share. A marker
  // whose span is only PARTIALLY masked — the opening bracket inside a
  // codespan with a visible path and close, or a body that dips into code —
  // is deliverable to NO layer: the finder's masked regex cannot match it, so
  // nothing ever replaces it, while the raw pattern alone rated it complete
  // and left the absolute path in the text. Mixed visibility is residue. The
  // pinned trade covers the marker quoted in code WHOLE (`quoted`), and the
  // fully-visible complete marker (`visible`) keeps its leave-alone behaviour.
  const maskedText = maskCode(text);
  const spans: Array<{ start: number; end: number }> = [];
  const continuationMemo: ResidueContinuationMemo = {
    exact: new Map(),
    noCloseMinDepth: new Map(),
    noCloseAnyDepth: new Set(),
    stops: new Map(),
  };
  let open = text.indexOf('[');
  let skipUntil = -1;
  while (open !== -1) {
    // R3-9: residue opens only with the FULL marker name. Bare name prefixes
    // (`[i`, `[im`) are prose — substituting them minted `[Image pending]`
    // claims the delivery path can never honour. R3-1: a spaced opening
    // (`[ FILE: /path]`) matches no delivery grammar — well-formed or not it
    // can never be delivered, so it can only ship its path as literal text.
    // Strip it as residue; a well-formed marker with an immediate opening
    // keeps the pinned leave-alone behaviour. R3-11: the shape decision reads
    // only the name region of the ORIGINAL text — the per-bracket whole-line
    // copy, uppercase, and re-scan this replaced were the sweep's quadratic
    // factor at CONTENT_LIMIT.
    //
    // R22-4: the walk runs LEFT-TO-RIGHT and skips every bracket inside an
    // already-accepted residue span. An inner marker-shaped opening's residue
    // never runs past the span that subsumes it — it is on the same line, and
    // its continuation starts from the same next line with no MORE bracket
    // obligation — so the merged result is unchanged while a run of
    // marker-shaped brackets costs one residue walk instead of one per
    // bracket (the per-bracket residue/visibility probes over the REMAINING
    // text were the sweep's quadratic factor at CONTENT_LIMIT).
    if (open >= skipUntil) {
      const shape = markerOpeningShape(text, open, prefix);
      if (shape !== undefined) {
        // R1-5: confine the candidate to its OWN line instead of breaking the
        // walk at the first newline. Breaking meant only a marker on the final
        // line could ever be stripped, so an abandoned `[FILE: /abs/path`
        // followed by more output survived every sanitizer — contradicting
        // this function's own documented intent and leaking the path onto the
        // card. R22-4: index walks over the ORIGINAL text — the per-bracket
        // copy of the remaining text was quadratic on a marker-shaped run.
        const eolAbs = lineEndAt(text, open + 1);
        const closeAbs = text.indexOf(']', open + 1);
        const closeOnLine =
          closeAbs !== -1 && (eolAbs === -1 || closeAbs < eolAbs);
        const visibility = closeOnLine
          ? markerVisibility(text, maskedText, open, closeAbs)
          : 'mixed';
        const complete =
          shape === 'immediate' &&
          closeOnLine &&
          visibility !== 'mixed' &&
          completedPattern.test(text.slice(open + 1, closeAbs + 1));
        if (!complete) {
          // R1-4: a marker whose close sits on a LATER line is matched by no
          // layer — the same-line grammar misses it and the finder never sees
          // it — so it shipped as literal text with the absolute path. R3-1:
          // the same holds for a same-line `]` that does not complete the
          // marker (a bracketed path) — after the replace pass every
          // well-formed marker is gone, so such an opening is ill-formed
          // residue regardless of inner brackets; prose brackets like `[note]`
          // never prefix-match a marker name.
          const end = partialMarkerResidueEnd(text, open, continuationMemo);
          spans.push({ start: open, end });
          skipUntil = end;
        }
      }
    }
    open = text.indexOf('[', open + 1);
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

/**
 * Whether the `[` at `open` opens a residue of the given marker name,
 * confined to the line ending at `lineEnd`: the full name immediately after
 * the bracket or after horizontal spaces, folded through `toUpperCase`
 * exactly as the recognition gates do (R6-2) — an `iu` regex is not a
 * substitute.
 */
function opensMarkerName(
  text: string,
  open: number,
  lineEnd: number,
  prefix: string,
): boolean {
  let index = open + 1;
  while (index < lineEnd && /[^\S\r\n]/u.test(text[index]!)) index++;
  let upper = '';
  while (index < lineEnd && upper.length < prefix.length) {
    upper += text[index]!.toUpperCase();
    index++;
  }
  return upper === prefix;
}

/**
 * Cut every line at its first marker-shaped opening of the given name. A
 * removal can only create a new marker across the boundary it made, which a
 * budgeted loop above has already failed to settle, so the residue is cut
 * where it stands. Lines the sweep does not touch survive byte-for-byte —
 * including code quotes — this runs only when a budget is exhausted, and its
 * failure direction is the same as the stripper's: marker-shaped residue is
 * lost, never the no-leak guarantee.
 */
export function neutralizeMediaMarkerOpenings(
  text: string,
  markerName: 'IMAGE' | 'FILE',
): string {
  const prefix = `${markerName}:`;
  let result = '';
  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    let cut = -1;
    for (let index = lineStart; index < lineEnd; index++) {
      if (
        text[index] === '[' &&
        opensMarkerName(text, index, lineEnd, prefix)
      ) {
        cut = index;
        break;
      }
    }
    result += text.slice(lineStart, cut === -1 ? lineEnd : cut);
    if (newline === -1) break;
    result += '\n';
    lineStart = newline + 1;
  }
  return result;
}
