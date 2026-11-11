/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  resolveColor,
  interpolateColor,
  getThemeTypeFromBackgroundColor,
  INK_SUPPORTED_NAMES,
  INK_NAME_TO_HEX_MAP,
  getLuminance,
  CSS_NAME_TO_HEX_MAP,
} from './theme.js';

export {
  resolveColor,
  interpolateColor,
  getThemeTypeFromBackgroundColor,
  INK_SUPPORTED_NAMES,
  INK_NAME_TO_HEX_MAP,
  getLuminance,
  CSS_NAME_TO_HEX_MAP,
};

/**
 * Checks if a color string is valid (hex, Ink-supported color name, or CSS color name).
 * This function uses the same validation logic as the Theme class's _resolveColor method
 * to ensure consistency between validation and resolution.
 * @param color The color string to validate.
 * @returns True if the color is valid.
 */
export function isValidColor(color: string): boolean {
  const lowerColor = color.toLowerCase();

  // 1. Check if it's a hex code
  if (lowerColor.startsWith('#')) {
    return /^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(color);
  }

  // 2. Check if it's an Ink supported name
  if (INK_SUPPORTED_NAMES.has(lowerColor)) {
    return true;
  }

  // 3. Check if it's a known CSS name we can map to hex
  if (CSS_NAME_TO_HEX_MAP[lowerColor]) {
    return true;
  }

  // 4. Not a valid color
  return false;
}

/**
 * Returns a safe input-frame base color for low-color terminals.
 *
 * For terminal backgrounds we return a slightly offset shade that remains
 * visible after the frame color is blended with the primary text color.
 * For standard black/white we use hand-picked values.
 * Returns undefined only when the color cannot be resolved at all.
 */
export function getSafeLowColorFrameBase(
  terminalBg: string,
): string | undefined {
  const resolvedTerminalBg = resolveColor(terminalBg) || terminalBg;
  if (
    resolvedTerminalBg === 'black' ||
    resolvedTerminalBg === '#000000' ||
    resolvedTerminalBg === '#000'
  ) {
    return '#1c1c1c';
  }
  if (
    resolvedTerminalBg === 'white' ||
    resolvedTerminalBg === '#ffffff' ||
    resolvedTerminalBg === '#fff'
  ) {
    return '#eeeeee';
  }
  // For any other valid hex color, compute a slightly lighter/darker shade
  // that works as an input frame base in 256-color terminals.
  if (resolvedTerminalBg.startsWith('#') && resolvedTerminalBg.length >= 4) {
    const lum = getLuminance(resolvedTerminalBg);
    // Dark background → lighten slightly; light background → darken slightly
    const factor = lum > 128 ? 0.15 : 0.2;
    const blended = interpolateColor(
      resolvedTerminalBg,
      lum > 128 ? '#000000' : '#ffffff',
      factor,
    );
    return blended || undefined;
  }
  return undefined;
}

// Hysteresis thresholds to prevent flickering when the background color
// is ambiguous (near the midpoint).
export const LIGHT_THEME_LUMINANCE_THRESHOLD = 140;
export const DARK_THEME_LUMINANCE_THRESHOLD = 110;

/**
 * Classifies a background color using the same hysteresis band the auto theme
 * follower switches on, rather than the plain 128 midpoint used by
 * `getThemeTypeFromBackgroundColor`.
 *
 * Returns `undefined` inside the ambiguous band, which is the point: a caller
 * that asks "is the user's theme wrong for this background?" gets the same
 * answer as the follower asking "should I switch?". Without this, luminance in
 * (128, 140] or [110, 128) produces a permanent warning that auto-switching
 * never acts on.
 *
 * @param backgroundColor The terminal background color.
 * @returns 'light' / 'dark' when unambiguous, otherwise undefined.
 */
export function getBackgroundTypeWithHysteresis(
  backgroundColor: string | undefined,
): 'light' | 'dark' | undefined {
  if (!backgroundColor) {
    return undefined;
  }

  const resolvedColor = resolveColor(backgroundColor);
  if (!resolvedColor) {
    return undefined;
  }

  const luminance = getLuminance(resolvedColor);
  if (luminance > LIGHT_THEME_LUMINANCE_THRESHOLD) {
    return 'light';
  }
  if (luminance < DARK_THEME_LUMINANCE_THRESHOLD) {
    return 'dark';
  }
  return undefined;
}

/**
 * Parses an X11 RGB string (e.g. from OSC 11) into a hex color string.
 * Supports 1-4 digit hex values per channel (e.g., F, FF, FFF, FFFF).
 *
 * @param rHex Red component as hex string
 * @param gHex Green component as hex string
 * @param bHex Blue component as hex string
 * @returns Hex color string (e.g. #RRGGBB)
 */
export function parseColor(rHex: string, gHex: string, bHex: string): string {
  const parseComponent = (hex: string) => {
    const val = parseInt(hex, 16);
    if (hex.length === 1) return (val / 15) * 255;
    if (hex.length === 2) return val;
    if (hex.length === 3) return (val / 4095) * 255;
    if (hex.length === 4) return (val / 65535) * 255;
    return val;
  };

  const r = parseComponent(rHex);
  const g = parseComponent(gHex);
  const b = parseComponent(bHex);

  const toHex = (c: number) => Math.round(c).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
