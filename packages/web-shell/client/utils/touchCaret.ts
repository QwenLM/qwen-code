/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Caret math for the touch editing-row keys. Textarea carets are UTF-16
// offsets, but stepping or clamping by a single code unit can land inside a
// surrogate pair (or a wider grapheme cluster), so every boundary here is a
// grapheme boundary. Vertical navigation uses the *displayed* lines: a long
// paragraph soft-wraps, and the keys must move between those visual lines the
// way the native arrow keys do, not between '\n' separators only.

interface GraphemeSegmenter {
  segment(text: string): Iterable<{ index: number }>;
}

type SegmenterCtor = new (
  locales?: string,
  options?: { granularity: 'grapheme' },
) => GraphemeSegmenter;

function segmenterCtor(): SegmenterCtor | undefined {
  const intl = Intl as unknown as { Segmenter?: SegmenterCtor };
  return typeof intl.Segmenter === 'function' ? intl.Segmenter : undefined;
}

/** Grapheme start offsets, always ending with text.length. */
export function graphemeBoundaries(text: string): number[] {
  const boundaries: number[] = [0];
  const Ctor = segmenterCtor();
  if (Ctor) {
    for (const segment of new Ctor(undefined, {
      granularity: 'grapheme',
    }).segment(text)) {
      if (segment.index > 0) boundaries.push(segment.index);
    }
  } else {
    // Code-point fallback: still never splits a surrogate pair.
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) i += 1;
      if (i + 1 < text.length) boundaries.push(i + 1);
    }
  }
  if (boundaries[boundaries.length - 1] !== text.length) {
    boundaries.push(text.length);
  }
  return boundaries;
}

export function nextGraphemeBoundary(text: string, caret: number): number {
  for (const boundary of graphemeBoundaries(text)) {
    if (boundary > caret) return boundary;
  }
  return text.length;
}

export function logicalLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

export function lineIndexAt(lineStarts: number[], caret: number): number {
  let index = 0;
  for (let i = 0; i < lineStarts.length; i += 1) {
    if (lineStarts[i] <= caret) index = i;
    else break;
  }
  return index;
}

/**
 * Content end of a displayed line. An explicit newline is skipped, but a
 * soft-wrap boundary has no separator to skip: subtracting one there would
 * chop the final grapheme of the wrapped line (splitting a surrogate pair).
 */
export function lineContentEnd(
  text: string,
  lineStarts: number[],
  index: number,
): number {
  if (index + 1 >= lineStarts.length) return text.length;
  const next = lineStarts[index + 1];
  return text[next - 1] === '\n' ? next - 1 : next;
}

/** Grapheme column of caret within its line. */
export function caretGraphemeColumn(
  text: string,
  caret: number,
  lineStarts: number[],
): number {
  const index = lineIndexAt(lineStarts, caret);
  const lineStart = lineStarts[index];
  const lineEnd = lineContentEnd(text, lineStarts, index);
  const boundaries = graphemeBoundaries(text.slice(lineStart, lineEnd));
  const column = caret - lineStart;
  let count = 0;
  for (const boundary of boundaries) {
    if (boundary >= column) break;
    count += 1;
  }
  return count;
}

/** Offset of the given grapheme column within a line, clamped to its length. */
export function offsetAtGraphemeColumn(
  text: string,
  lineStart: number,
  lineEnd: number,
  column: number,
): number {
  const boundaries = graphemeBoundaries(text.slice(lineStart, lineEnd));
  const clamped = Math.min(column, boundaries.length - 1);
  return lineStart + boundaries[clamped];
}

interface MirrorCache {
  text: string;
  width: number;
  mirror: HTMLDivElement;
  node: Text;
}

const mirrorCache = new WeakMap<HTMLTextAreaElement, MirrorCache>();

/**
 * Build (or reuse) a mirror replicating the textarea's wrapping styles. The
 * mirror is cached per text+width, so a vertical run pays one layout, not
 * one per key. Measuring line tops never enumerates the whole draft —
 * `topAt` answers in O(log n) binary searches around the caret instead of a
 * per-grapheme rect loop, which would block the key handler on long drafts.
 */
function getMirror(el: HTMLTextAreaElement, text: string): MirrorCache | null {
  const width = el.clientWidth;
  if (typeof document === 'undefined' || width <= 0) return null;
  const cached = mirrorCache.get(el);
  if (cached && cached.text === text && cached.width === width) return cached;
  // Never abandon a superseded mirror in the document: it would hold a full
  // copy of that old draft for the life of the page. One live mirror per
  // textarea, discarded on clear/unmount via discardMirror.
  cached?.mirror.remove();
  mirrorCache.delete(el);
  const style = window.getComputedStyle(el);
  const mirror = document.createElement('div');
  mirror.setAttribute('aria-hidden', 'true');
  mirror.style.position = 'fixed';
  mirror.style.left = '-99999px';
  mirror.style.top = '0';
  mirror.style.visibility = 'hidden';
  mirror.style.pointerEvents = 'none';
  mirror.style.boxSizing = 'border-box';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.wordBreak = 'normal';
  mirror.style.width = `${width}px`;
  mirror.style.font = style.font;
  mirror.style.fontSize = style.fontSize;
  mirror.style.fontFamily = style.fontFamily;
  mirror.style.fontWeight = style.fontWeight;
  mirror.style.letterSpacing = style.letterSpacing;
  mirror.style.lineHeight = style.lineHeight;
  mirror.style.tabSize = style.tabSize;
  mirror.style.paddingTop = style.paddingTop;
  mirror.style.paddingBottom = style.paddingBottom;
  mirror.style.paddingLeft = style.paddingLeft;
  mirror.style.paddingRight = style.paddingRight;
  mirror.style.borderTopWidth = style.borderTopWidth;
  mirror.style.borderBottomWidth = style.borderBottomWidth;
  mirror.style.borderLeftWidth = style.borderLeftWidth;
  mirror.style.borderRightWidth = style.borderRightWidth;
  mirror.style.borderStyle = 'solid';
  mirror.style.borderColor = 'transparent';
  // A trailing '\n' only renders its empty line box when something follows
  // it; the zero-width sentinel makes the last visual line measurable.
  const node = document.createTextNode(
    text.endsWith('\n') ? `${text}\u200b` : text,
  );
  mirror.appendChild(node);
  document.body.appendChild(mirror);
  const entry: MirrorCache = { text, width, mirror, node };
  mirrorCache.set(el, entry);
  return entry;
}

/** Drop a textarea's mirror node and its cached draft text. */
export function discardMirror(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  mirrorCache.get(el)?.mirror.remove();
  mirrorCache.delete(el);
}

/** Layout top of the displayed line containing offset. */
function topAt(cache: MirrorCache, text: string, offset: number): number {
  if (cache.node.length === 0) return 0;
  let o = offset;
  if (o >= text.length) o = cache.node.length - 1;
  else if (text[o] === '\n' && o > 0) o = o - 1;
  // Character rect, not a collapsed caret: a collapsed range at a wrap
  // boundary reports the previous line's end (upstream affinity).
  const range = document.createRange();
  range.setStart(cache.node, o);
  range.setEnd(cache.node, Math.min(o + 1, cache.node.length));
  const top = range.getBoundingClientRect().top;
  range.detach();
  return top;
}

/** First offset in [lo, hi] whose line top >= target (tops are monotonic). */
function firstAtLeast(
  cache: MirrorCache,
  text: string,
  lo: number,
  hi: number,
  target: number,
): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (topAt(cache, text, mid) >= target - 0.5) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** First offset in [lo, hi] whose line top > target. */
function firstAbove(
  cache: MirrorCache,
  text: string,
  lo: number,
  hi: number,
  target: number,
): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (topAt(cache, text, mid) > target + 0.5) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Displayed line starts around the caret: previous visual line (if any),
 * current visual line and next visual line. Only these boundaries are
 * measured — the up/down keys move one line per press, so the array need
 * not enumerate the whole draft. Falls back to all logical lines when
 * layout is unavailable (jsdom).
 */
export function visualLineStartsAround(
  el: HTMLTextAreaElement,
  text: string,
  caret: number,
): number[] {
  const logicalStarts = logicalLineStarts(text);
  const cache = getMirror(el, text);
  if (!cache) return logicalStarts;
  const index = lineIndexAt(logicalStarts, caret);
  const logicalStart = logicalStarts[index];
  const logicalEnd =
    index + 1 < logicalStarts.length
      ? logicalStarts[index + 1] - 1
      : text.length;
  const top = topAt(cache, text, caret);
  const currentStart = firstAtLeast(cache, text, logicalStart, caret, top);
  const starts: number[] = [];
  if (currentStart > logicalStart) {
    const prevTop = topAt(cache, text, currentStart - 1);
    starts.push(
      firstAtLeast(cache, text, logicalStart, currentStart - 1, prevTop),
    );
  } else if (index > 0) {
    // The current visual line opens this logical line; the previous visual
    // line is the last of the preceding logical line.
    const prevTop = topAt(cache, text, logicalStarts[index] - 1);
    starts.push(
      firstAtLeast(
        cache,
        text,
        logicalStarts[index - 1],
        logicalStarts[index] - 1,
        prevTop,
      ),
    );
  }
  starts.push(currentStart);
  const lastTop = topAt(cache, text, logicalEnd);
  if (top < lastTop - 0.5) {
    const nextStart = firstAbove(cache, text, caret + 1, logicalEnd, top);
    starts.push(nextStart);
    // The next visual line also needs its own end boundary: without it the
    // target-line clamp would read to the end of the whole document.
    const nextTop = topAt(cache, text, nextStart);
    const nextEnd =
      nextTop < lastTop - 0.5
        ? firstAbove(cache, text, nextStart + 1, logicalEnd, nextTop)
        : logicalEnd;
    if (nextEnd > nextStart) starts.push(nextEnd);
  } else if (index + 1 < logicalStarts.length) {
    const nextStart = logicalStarts[index + 1];
    starts.push(nextStart);
    // A wrapped next logical line must contribute its opening displayed line
    // too, or Down skips straight into a later wrap. Otherwise the sentinel
    // after a logical line is the *start* of the line after next, not next-1:
    // an empty next line is zero-length, and next-1 would collapse onto
    // nextStart and drop the boundary entirely.
    const nextTop = topAt(cache, text, nextStart);
    const nextLogicalEnd =
      index + 2 < logicalStarts.length
        ? logicalStarts[index + 2] - 1
        : text.length;
    const nextEnd =
      nextLogicalEnd > nextStart &&
      nextTop < topAt(cache, text, nextLogicalEnd) - 0.5
        ? firstAbove(cache, text, nextStart + 1, nextLogicalEnd, nextTop)
        : index + 2 < logicalStarts.length
          ? logicalStarts[index + 2]
          : text.length;
    if (nextEnd > nextStart) starts.push(nextEnd);
  } else if (caret < text.length) {
    // The document-end sentinel bounds the current line, but it must not
    // become a pseudo line start when the caret sits on it — otherwise the
    // caret reads as column 0 of that phantom line and up/down mis-step.
    starts.push(text.length);
  }
  return [...new Set(starts)].sort((a, b) => a - b);
}

/** Scroll the caret's displayed line into the textarea's scrollport. */
export function revealCaret(
  el: HTMLTextAreaElement,
  text: string,
  caret: number,
): void {
  const style = window.getComputedStyle(el);
  const lineHeight =
    parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6;
  let caretTop: number;
  const cache = getMirror(el, text);
  if (cache) {
    caretTop = topAt(cache, text, caret) - topAt(cache, text, 0);
  } else {
    caretTop =
      (parseFloat(style.paddingTop) || 0) +
      lineIndexAt(logicalLineStarts(text), caret) * lineHeight;
  }
  if (caretTop < el.scrollTop) {
    el.scrollTop = caretTop;
  } else if (caretTop + lineHeight > el.scrollTop + el.clientHeight) {
    el.scrollTop = caretTop + lineHeight - el.clientHeight;
  }
}
