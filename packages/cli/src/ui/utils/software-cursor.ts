/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import chalk from 'chalk';
import { resolveColor } from '../themes/color-utils.js';
import { getEffectiveTerminalBackground } from './theme-background.js';

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
  backgroundColor = getEffectiveTerminalBackground(),
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

/**
 * Whether the IME composition overlay can land on the software cursor cell
 * while frames are being redrawn.
 *
 * Terminals render the IME preedit string at the hardware cursor, which Ink
 * positions on the software cursor cell of the active input (see
 * `useCursor()` in BaseTextInput). When output frames cannot be applied
 * atomically (DECSET 2026 synchronized output), every redraw repaints that
 * cell mid-composition and the fixed cursor background SGR corrupts the
 * composition overlay:
 *  - Windows terminals style IME text with their own composition highlight
 *    (#9666, fixed by #9803).
 *  - tmux sessions disable synchronized output (`TMUX` guard in
 *    synchronizedOutput.ts) and tmux <= 3.6 lacks application-side 2026
 *    support entirely, so each Ink frame clears and repaints the preedit
 *    cell, displacing the cursor and mixing pinyin fragments into the
 *    rendered input (#8177).
 * In those environments the cursor uses an underline style that leaves the
 * composition cell's background untouched.
 */
export function compositionOverlaysSoftwareCursor(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') {
    return true;
  }
  if (!env['TMUX']) {
    return false;
  }
  // With synchronized output forced on, frames apply atomically again, so
  // the block cursor is safe (e.g. future tmux releases with 2026 support).
  return !(
    env['QWEN_CODE_SYNCHRONIZED_OUTPUT'] === '1' ||
    env['QWEN_CODE_FORCE_SYNCHRONIZED_OUTPUT'] === '1'
  );
}

export function renderSoftwareCursor(text: string): string {
  const cursorText = text || ' ';
  return compositionOverlaysSoftwareCursor()
    ? chalk.underline(cursorText)
    : chalk.bgHex(getSoftwareCursorBackground())(cursorText);
}
