/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { theme } from '../semantic-colors.js';
import { themeManager } from '../themes/theme-manager.js';

// Representative terminal background colours used only for luminance-based
// decisions (e.g. software cursor contrast) when the active theme's background
// does not match the terminal and therefore isn't painted. Only the
// light/dark bucket matters, so pure black/white are the safest stand-ins.
const DARK_TERMINAL_BACKGROUND = '#000000';
const LIGHT_TERMINAL_BACKGROUND = '#ffffff';

/**
 * Whether the active theme's background brightness agrees with the terminal's
 * detected background.
 *
 * The TUI paints no global background — almost everything relies on the
 * terminal's own background. So a component may only flood itself with the
 * theme background when that background actually matches the terminal;
 * otherwise (e.g. a user forcing "Qwen Light" onto a dark terminal) the fill
 * renders as a bright block fighting the dark surroundings.
 *
 * Themes whose type is 'ansi' or 'custom' can't be classified as light/dark,
 * so they're treated as matching to preserve existing behaviour.
 */
export function themeBackgroundMatchesTerminal(): boolean {
  const activeType = themeManager.getActiveTheme().type;
  if (activeType !== 'light' && activeType !== 'dark') {
    return true;
  }
  return activeType === themeManager.getTerminalBackgroundType();
}

/**
 * The colour to flood-fill the input box content area with, or `undefined` to
 * leave it transparent so it blends into the terminal when the active theme
 * fights the terminal background.
 */
export function getInputBackgroundFill(): string | undefined {
  return themeBackgroundMatchesTerminal()
    ? theme.background?.primary
    : undefined;
}

/**
 * The brightness-representative colour the input area actually shows on screen:
 * the theme background when it matches the terminal, otherwise a stand-in for
 * the terminal's own background. Used for derived decisions such as software
 * cursor contrast, which must stay correct even when no fill is painted.
 */
export function getEffectiveInputBackground(): string {
  if (themeBackgroundMatchesTerminal()) {
    return theme.background?.primary ?? '';
  }
  return themeManager.getTerminalBackgroundType() === 'light'
    ? LIGHT_TERMINAL_BACKGROUND
    : DARK_TERMINAL_BACKGROUND;
}
