/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { themeManager } from '../themes/theme-manager.js';

// Representative terminal background colours used only for luminance-based
// decisions (e.g. software cursor contrast). The TUI paints no background of
// its own, so anything sitting "on the input area" actually sits on the
// terminal's own background; the cursor must derive its contrast from that.
// Only the light/dark bucket matters, so pure black/white are the safest
// stand-ins.
const DARK_TERMINAL_BACKGROUND = '#000000';
const LIGHT_TERMINAL_BACKGROUND = '#ffffff';

/**
 * A brightness-representative stand-in for the terminal's own background,
 * derived from its detected dark/light type.
 *
 * The TUI never floods a background of its own, so derived decisions such as
 * software cursor contrast must be made against the terminal background the
 * content actually renders on — not against the active theme's background,
 * which is never painted.
 */
export function getEffectiveTerminalBackground(): string {
  return themeManager.getTerminalBackgroundType() === 'light'
    ? LIGHT_TERMINAL_BACKGROUND
    : DARK_TERMINAL_BACKGROUND;
}
