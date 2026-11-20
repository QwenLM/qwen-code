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

/** Grapheme column of caret within its line. */
export function caretGraphemeColumn(
  text: string,
  caret: number,
  lineStarts: number[],
): number {
  const index = lineIndexAt(lineStarts, caret);
  const lineStart = lineStarts[index];
  const lineEnd =
    index + 1 < lineStarts.length ? lineStarts[index + 1] - 1 : text.length;
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

interface VisualLineCache {
  text: string;
  width: number;
  starts: number[];
}

const visualLineCache = new WeakMap<HTMLTextAreaElement, VisualLineCache>();

/**
 * Displayed (soft-wrapped) line start offsets, measured with a mirror that
 * replicates the textarea's wrapping styles. Falls back to logical lines when
 * layout is unavailable (jsdom) so unit tests exercise the pure math.
 */
export function measureVisualLineStarts(
  el: HTMLTextAreaElement,
  text: string,
): number[] {
  const width = el.clientWidth;
  const cached = visualLineCache.get(el);
  if (cached && cached.text === text && cached.width === width) {
    return cached.starts;
  }
  const fallback = logicalLineStarts(text);
  if (typeof document === 'undefined' || width <= 0) return fallback;
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
  const mirrorText = text.endsWith('\n') ? `${text}\u200b` : text;
  const node = document.createTextNode(mirrorText);
  mirror.appendChild(node);
  document.body.appendChild(mirror);
  const starts = [0];
  let lastTop = Number.NaN;
  const range = document.createRange();
  // Per-grapheme character rects, not collapsed carets: a collapsed range at
  // a wrap boundary reports the previous line's end (upstream affinity),
  // which would shift every detected line start one character late.
  const boundaries = graphemeBoundaries(mirrorText);
  for (let i = 0; i + 1 < boundaries.length; i += 1) {
    range.setStart(node, boundaries[i]);
    range.setEnd(node, boundaries[i + 1]);
    const rect = range.getBoundingClientRect();
    if (Number.isNaN(lastTop)) {
      lastTop = rect.top;
    } else if (rect.top > lastTop + 1) {
      starts.push(boundaries[i]);
      lastTop = rect.top;
    }
  }
  range.detach();
  mirror.remove();
  visualLineCache.set(el, { text, width, starts });
  return starts;
}

/** Scroll the caret's displayed line into the textarea's scrollport. */
export function revealCaret(
  el: HTMLTextAreaElement,
  text: string,
  caret: number,
): void {
  const starts = measureVisualLineStarts(el, text);
  const index = lineIndexAt(starts, caret);
  const style = window.getComputedStyle(el);
  const lineHeight =
    parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6;
  const caretTop = (parseFloat(style.paddingTop) || 0) + index * lineHeight;
  if (caretTop < el.scrollTop) {
    el.scrollTop = caretTop;
  } else if (caretTop + lineHeight > el.scrollTop + el.clientHeight) {
    el.scrollTop = caretTop + lineHeight - el.clientHeight;
  }
}
