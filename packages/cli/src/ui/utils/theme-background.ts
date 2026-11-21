/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { themeManager } from '../themes/theme-manager.js';

// Representative terminal background colours used only for luminance-based
// decisions (e.g. software cursor contrast). The main composer keeps the
// terminal's own background; its cursor must derive contrast from that.
// Only the light/dark bucket matters, so pure black/white are the safest
// stand-ins. Message and dialog surfaces do not change the main composer's
// terminal-native background.
const DARK_TERMINAL_BACKGROUND = '#000000';
const LIGHT_TERMINAL_BACKGROUND = '#ffffff';

/**
 * A brightness-representative stand-in for the terminal's own background,
 * derived from its detected dark/light type.
 *
 * The main composer stays transparent even when messages and dialogs have
 * themed surfaces, so its software cursor uses the terminal background.
 */
export function getEffectiveTerminalBackground(): string {
  return themeManager.getTerminalBackgroundType() === 'light'
    ? LIGHT_TERMINAL_BACKGROUND
    : DARK_TERMINAL_BACKGROUND;
}

export function getDialogSurfaceColor(): string | undefined {
  const activeTheme = themeManager.getActiveTheme();
  const surface = activeTheme.semanticColors.background.surface;
  if (
    surface &&
    (activeTheme.type === 'dark' || activeTheme.type === 'light') &&
    activeTheme.type !== themeManager.getTerminalBackgroundType()
  ) {
    return undefined;
  }
  return surface;
}
