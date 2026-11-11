/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import sliceAnsi from './stubs/sliceAnsi.js';
import stripAnsi from 'strip-ansi';
import { stringWidth } from './stringWidth.js';
import { getGraphemeSegmenter } from './stubs/intl.js';
import type { Styles } from './styles.js';
import { wrapAnsi } from './wrapAnsi.js';

const ELLIPSIS = '…';

function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

function visibleGraphemeBoundaries(plainText: string): number[] {
  const boundaries = [0];

  for (const { index, segment } of getGraphemeSegmenter().segment(plainText)) {
    boundaries.push(index + segment.length);
  }

  return boundaries;
}

function visibleIndexAtColumn(
  text: string,
  boundaries: number[],
  targetColumn: number,
  edge: 'start' | 'end',
): number {
  let low = 0;
  let high = boundaries.length - 1;
  let result = edge === 'start' ? (boundaries.at(-1) ?? 0) : 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const visibleIndex = boundaries[mid];
    const width = stringWidth(sliceAnsi(text, 0, visibleIndex));

    if (edge === 'start') {
      if (width >= targetColumn) {
        result = visibleIndex;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    } else if (width <= targetColumn) {
      result = visibleIndex;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return result;
}

function sliceFit(text: string, start: number, end: number): string {
  // ANSI escape bytes are ASCII, so a fully-ASCII raw string is also plain
  // ASCII. Test the raw text first to skip stripAnsi on the common path.
  if (isAscii(text)) {
    return sliceAnsi(text, start, end);
  }

  const boundaries = visibleGraphemeBoundaries(stripAnsi(text));
  const visibleStart = visibleIndexAtColumn(text, boundaries, start, 'start');
  const visibleEnd = visibleIndexAtColumn(text, boundaries, end, 'end');

  if (visibleStart >= visibleEnd) return '';
  return sliceAnsi(text, visibleStart, visibleEnd);
}

export function truncate(
  text: string,
  columns: number,
  position: 'start' | 'middle' | 'end',
): string {
  if (columns < 1) return '';
  if (columns === 1) return ELLIPSIS;

  const length = stringWidth(text);
  if (length <= columns) return text;

  if (position === 'start') {
    return ELLIPSIS + sliceFit(text, length - columns + 1, length);
  }
  if (position === 'middle') {
    const half = Math.floor(columns / 2);
    return (
      sliceFit(text, 0, half) +
      ELLIPSIS +
      sliceFit(text, length - (columns - half) + 1, length)
    );
  }
  return sliceFit(text, 0, columns - 1) + ELLIPSIS;
}

export default function wrapText(
  text: string,
  maxWidth: number,
  wrapType: Styles['textWrap'],
): string {
  // Guard against non-positive or non-finite maxWidth — Yoga can produce
  // computed widths smaller than padding+border (negative), or pass NaN when
  // widthMode is Undefined. Bun.wrapAnsi (native) does not handle these and
  // would call String.prototype.repeat() with an invalid argument, causing a
  // RangeError.
  if (!(maxWidth > 0) || !Number.isFinite(maxWidth)) {
    return '';
  }

  if (wrapType === 'wrap') {
    return wrapAnsi(text, maxWidth, {
      trim: false,
      hard: true,
    });
  }

  if (wrapType === 'wrap-trim') {
    return wrapAnsi(text, maxWidth, {
      trim: true,
      hard: true,
    });
  }

  if (wrapType!.startsWith('truncate')) {
    let position: 'end' | 'middle' | 'start' = 'end';

    if (wrapType === 'truncate-middle') {
      position = 'middle';
    }

    if (wrapType === 'truncate-start') {
      position = 'start';
    }

    return truncate(text, maxWidth, position);
  }

  return text;
}
