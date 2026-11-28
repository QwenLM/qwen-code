/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import chalk from 'chalk';
import cliBoxes, { type Boxes, type BoxStyle } from 'cli-boxes';
import { applyColor } from './colorize.js';
import type { DOMNode } from './dom.js';
import type Output from './output.js';
import { stringWidth } from './stringWidth.js';
import { truncate } from './wrap-text.js';
import type { Color } from './styles.js';
import { isUnicodeSupported } from '../ui/utils/terminalUtils.js';

export type BorderTextOptions = {
  content: string; // Pre-rendered string with ANSI color codes
  position: 'top' | 'bottom';
  align: 'start' | 'end' | 'center';
  offset?: number; // Only used with 'start' or 'end' alignment. Number of characters from the edge.
  /** Spaces added on each side of `content`. Default 0. */
  padding?: number;
  /** Color for the text; when set, the border's dim flag applies to it too. */
  color?: Color;
};

/**
 * Custom border styles not provided by cli-boxes.
 * The dashed style uses Unicode box-drawing characters when supported,
 * and falls back to basic ASCII on legacy terminals (e.g. Windows CMD).
 */
const DASHED_UNICODE = {
  top: '╌',
  left: '╎',
  right: '╎',
  bottom: '╌',
  topLeft: ' ',
  topRight: ' ',
  bottomLeft: ' ',
  bottomRight: ' ',
} as const;

const DASHED_ASCII = {
  top: '-',
  left: '|',
  right: '|',
  bottom: '-',
  topLeft: ' ',
  topRight: ' ',
  bottomLeft: ' ',
  bottomRight: ' ',
} as const;

export const CUSTOM_BORDER_STYLES = {
  get dashed() {
    return isUnicodeSupported() ? DASHED_UNICODE : DASHED_ASCII;
  },
} as const;

export type BorderStyle =
  | keyof Boxes
  | keyof typeof CUSTOM_BORDER_STYLES
  | BoxStyle;

function embedTextInBorder(
  borderLine: string,
  content: string,
  align: 'start' | 'end' | 'center',
  offset: number = 0,
  borderChar: string,
  padding: number = 0,
): [before: string, text: string, after: string] {
  const borderLength = borderLine.length;
  const pad = ' '.repeat(Math.max(0, padding));
  // Keep at least one border cell visible on each side of the text.
  const budget = borderLength - 2 - pad.length * 2;
  if (budget < 1) {
    return [borderLine, '', ''];
  }

  const text = pad + truncate(content, budget, 'end') + pad;
  const textLength = stringWidth(text);

  let position: number;
  if (align === 'center') {
    position = Math.floor((borderLength - textLength) / 2);
  } else if (align === 'start') {
    position = offset + 1; // +1 to account for corner character
  } else {
    // align === 'end'
    position = borderLength - textLength - offset - 1; // -1 for corner character
  }

  // Ensure position is valid
  position = Math.max(1, Math.min(position, borderLength - textLength - 1));

  const before = borderLine.substring(0, 1) + borderChar.repeat(position - 1);
  const after =
    borderChar.repeat(borderLength - position - textLength - 1) +
    borderLine.substring(borderLength - 1);

  return [before, text, after];
}

function renderBorderLineWithText(
  borderLine: string,
  borderText: BorderTextOptions,
  borderChar: string,
  color: Color | undefined,
  dim: boolean | undefined,
): string {
  const [before, text, after] = embedTextInBorder(
    borderLine,
    borderText.content,
    borderText.align,
    borderText.offset,
    borderChar,
    borderText.padding,
  );
  const styledText =
    text && borderText.color
      ? styleBorderLine(text, borderText.color, dim)
      : text;
  return (
    styleBorderLine(before, color, dim) +
    styledText +
    styleBorderLine(after, color, dim)
  );
}

function styleBorderLine(
  line: string,
  color: Color | undefined,
  dim: boolean | undefined,
): string {
  let styled = applyColor(line, color);
  if (dim) {
    styled = chalk.dim(styled);
  }
  return styled;
}

const renderBorder = (
  x: number,
  y: number,
  node: DOMNode,
  output: Output,
): void => {
  if (node.style.borderStyle) {
    const width = Math.floor(node.yogaNode!.getComputedWidth());
    const height = Math.floor(node.yogaNode!.getComputedHeight());

    // Yoga can produce non-finite dimensions during certain layout passes.
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return;
    }
    const box =
      typeof node.style.borderStyle === 'string'
        ? (CUSTOM_BORDER_STYLES[
            node.style.borderStyle as keyof typeof CUSTOM_BORDER_STYLES
          ] ?? cliBoxes[node.style.borderStyle as keyof Boxes])
        : node.style.borderStyle;

    const topBorderColor = node.style.borderTopColor ?? node.style.borderColor;
    const bottomBorderColor =
      node.style.borderBottomColor ?? node.style.borderColor;
    const leftBorderColor =
      node.style.borderLeftColor ?? node.style.borderColor;
    const rightBorderColor =
      node.style.borderRightColor ?? node.style.borderColor;

    const dimTopBorderColor =
      node.style.borderTopDimColor ?? node.style.borderDimColor;

    const dimBottomBorderColor =
      node.style.borderBottomDimColor ?? node.style.borderDimColor;

    const dimLeftBorderColor =
      node.style.borderLeftDimColor ?? node.style.borderDimColor;

    const dimRightBorderColor =
      node.style.borderRightDimColor ?? node.style.borderDimColor;

    const showTopBorder = node.style.borderTop !== false;
    const showBottomBorder = node.style.borderBottom !== false;
    const showLeftBorder = node.style.borderLeft !== false;
    const showRightBorder = node.style.borderRight !== false;

    const contentWidth = Math.max(
      0,
      width - (showLeftBorder ? 1 : 0) - (showRightBorder ? 1 : 0),
    );

    const topBorderLine = showTopBorder
      ? (showLeftBorder ? box.topLeft : '') +
        box.top.repeat(contentWidth) +
        (showRightBorder ? box.topRight : '')
      : '';

    // Handle text in top border
    let topBorder: string | undefined;
    if (showTopBorder && node.style.borderText?.position === 'top') {
      topBorder = renderBorderLineWithText(
        topBorderLine,
        node.style.borderText,
        box.top,
        topBorderColor,
        dimTopBorderColor,
      );
    } else if (showTopBorder) {
      topBorder = styleBorderLine(
        topBorderLine,
        topBorderColor,
        dimTopBorderColor,
      );
    }

    let verticalBorderHeight = height;

    if (showTopBorder) {
      verticalBorderHeight -= 1;
    }

    if (showBottomBorder) {
      verticalBorderHeight -= 1;
    }

    verticalBorderHeight = Math.max(0, verticalBorderHeight);

    let leftBorder = (applyColor(box.left, leftBorderColor) + '\n').repeat(
      verticalBorderHeight,
    );

    if (dimLeftBorderColor) {
      leftBorder = chalk.dim(leftBorder);
    }

    let rightBorder = (applyColor(box.right, rightBorderColor) + '\n').repeat(
      verticalBorderHeight,
    );

    if (dimRightBorderColor) {
      rightBorder = chalk.dim(rightBorder);
    }

    const bottomBorderLine = showBottomBorder
      ? (showLeftBorder ? box.bottomLeft : '') +
        box.bottom.repeat(contentWidth) +
        (showRightBorder ? box.bottomRight : '')
      : '';

    // Handle text in bottom border
    let bottomBorder: string | undefined;
    if (showBottomBorder && node.style.borderText?.position === 'bottom') {
      bottomBorder = renderBorderLineWithText(
        bottomBorderLine,
        node.style.borderText,
        box.bottom,
        bottomBorderColor,
        dimBottomBorderColor,
      );
    } else if (showBottomBorder) {
      bottomBorder = styleBorderLine(
        bottomBorderLine,
        bottomBorderColor,
        dimBottomBorderColor,
      );
    }

    const offsetY = showTopBorder ? 1 : 0;

    if (topBorder) {
      output.write(x, y, topBorder);
    }

    if (showLeftBorder) {
      output.write(x, y + offsetY, leftBorder);
    }

    if (showRightBorder) {
      output.write(x + width - 1, y + offsetY, rightBorder);
    }

    if (bottomBorder) {
      output.write(x, y + height - 1, bottomBorder);
    }
  }
};

export default renderBorder;
