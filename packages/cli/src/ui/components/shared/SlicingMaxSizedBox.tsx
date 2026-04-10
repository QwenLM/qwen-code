/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import { MaxSizedBox } from './MaxSizedBox.js';

/**
 * Maximum number of characters to retain before rendering.
 * Unlike MaxSizedBox's visual cropping, SlicingMaxSizedBox truncates data
 * BEFORE React rendering to avoid Ink laying out massive invisible content.
 *
 * Set to 20KB (vs the previous 1MB) to match Gemini CLI's approach.
 */
export const MAXIMUM_RESULT_DISPLAY_CHARACTERS = 20000;

interface SlicingMaxSizedBoxProps {
  /** Raw text data to display */
  data: string;
  /** Maximum lines to retain before rendering (pre-render slicing) */
  maxLines: number | undefined;
  /** MaxSizedBox maxHeight for visual cropping fallback */
  maxHeight: number | undefined;
  /** MaxSizedBox maxWidth */
  maxWidth: number;
  /** Overflow direction for hidden content indicator */
  overflowDirection?: 'top' | 'bottom';
  /** Render callback receiving the truncated data */
  children: (truncatedData: string) => React.ReactNode;
}

/**
 * Pre-render data slicing wrapper around MaxSizedBox.
 *
 * Problem: MaxSizedBox uses visual overflow to hide content, but Ink still
 * lays out ALL content to determine what overflows. For 500-line tool outputs,
 * this means Ink computes layout for 500 lines even though only ~15 are visible,
 * causing terminal flickering on every new line.
 *
 * Solution: SlicingMaxSizedBox uses useMemo() to slice data to maxLines BEFORE
 * the React render tree. Ink only receives ~15 lines → layout is instant → no flicker.
 *
 * Two-layer truncation:
 * 1. Character limit: truncate to MAXIMUM_RESULT_DISPLAY_CHARACTERS (20KB)
 * 2. Line limit: slice to maxLines rows
 *
 * The inner MaxSizedBox still provides visual cropping as a safety fallback.
 */
export const SlicingMaxSizedBox: React.FC<SlicingMaxSizedBoxProps> = ({
  data,
  maxLines,
  maxHeight,
  maxWidth,
  overflowDirection = 'top',
  children,
}) => {
  const { truncatedData, hiddenLineCount } = useMemo(() => {
    let text = data;
    let hidden = 0;

    // Layer 1: Character truncation
    if (text.length > MAXIMUM_RESULT_DISPLAY_CHARACTERS) {
      text = '...' + text.slice(-MAXIMUM_RESULT_DISPLAY_CHARACTERS);
    }

    // Layer 2: Line-level slicing (the key anti-flicker mechanism)
    if (maxLines !== undefined && maxLines > 0) {
      const lines = text.split('\n');
      if (lines.length > maxLines) {
        // Reserve 1 line for the "hidden" indicator shown by MaxSizedBox
        const targetLines = Math.max(1, maxLines - 1);
        hidden = lines.length - targetLines;
        if (overflowDirection === 'top') {
          text = lines.slice(-targetLines).join('\n');
        } else {
          text = lines.slice(0, targetLines).join('\n');
        }
      }
    }

    return { truncatedData: text, hiddenLineCount: hidden };
  }, [data, maxLines, overflowDirection]);

  // When pre-slicing is active, disable MaxSizedBox's independent height
  // truncation to prevent double-counting hidden lines. Pre-sliced text may
  // contain lines that soft-wrap into multiple visual rows; if MaxSizedBox
  // also truncates, its hiddenLinesCount would be added to our
  // additionalHiddenLinesCount, mixing logical and visual line counts.
  // With maxHeight=undefined, MaxSizedBox handles width only and renders the
  // indicator from additionalHiddenLinesCount alone.
  const effectiveMaxHeight = hiddenLineCount > 0 ? undefined : maxHeight;

  return (
    <MaxSizedBox
      maxHeight={effectiveMaxHeight}
      maxWidth={maxWidth}
      overflowDirection={overflowDirection}
      additionalHiddenLinesCount={hiddenLineCount}
    >
      {children(truncatedData)}
    </MaxSizedBox>
  );
};
