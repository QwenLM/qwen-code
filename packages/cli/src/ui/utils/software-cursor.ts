/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import chalk from 'chalk';
import { theme } from '../semantic-colors.js';
import { resolveColor } from '../themes/color-utils.js';

const LIGHT_CURSOR_BACKGROUND = '#D4D4D4';
const DARK_CURSOR_BACKGROUND = '#3A3A3A';
const INK_NAME_TO_HEX: Readonly<Record<string, string>> = {
  black: '#000000',
  red: '#ff0000',
  green: '#00ff00',
  yellow: '#ffff00',
  blue: '#0000ff',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  white: '#ffffff',
  gray: '#808080',
  grey: '#808080',
  blackbright: '#808080',
  redbright: '#ff8080',
  greenbright: '#80ff80',
  yellowbright: '#ffff80',
  bluebright: '#8080ff',
  cyanbright: '#80ffff',
  magentabright: '#ff80ff',
  whitebright: '#ffffff',
};

function toHex(color: string): string | undefined {
  const resolved = resolveColor(color) ?? color;
  const lower = resolved.toLowerCase();

  if (/^#[0-9a-f]{3}$/.test(lower)) {
    return `#${lower
      .slice(1)
      .split('')
      .map((c) => c + c)
      .join('')}`;
  }

  if (/^#[0-9a-f]{6}$/.test(lower)) {
    return lower;
  }

  return INK_NAME_TO_HEX[lower];
}

export function getSoftwareCursorBackground(
  backgroundColor = theme.background?.primary ?? '',
): string {
  const hex = backgroundColor ? toHex(backgroundColor) : undefined;
  if (!hex) {
    return LIGHT_CURSOR_BACKGROUND;
  }

  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (r * 299 + g * 587 + b * 114) / 1000;

  return luminance >= 128 ? DARK_CURSOR_BACKGROUND : LIGHT_CURSOR_BACKGROUND;
}

export function renderSoftwareCursor(text: string): string {
  return chalk.bgHex(getSoftwareCursorBackground())(text || ' ');
}
