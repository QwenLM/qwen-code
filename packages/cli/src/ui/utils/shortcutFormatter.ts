/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const isMac = process.platform === 'darwin';

/**
 * Maps modifier names to macOS symbol equivalents.
 */
const MAC_MODIFIERS: Record<string, string> = {
  ctrl: '⌃',
  cmd: '⌘',
  alt: '⌥',
  shift: '⇧',
};

/**
 * Formats a keyboard shortcut string for display, using macOS symbols when
 * running on Darwin.
 *
 * Examples (on macOS):
 *   "ctrl+y"  → "⌃Y"
 *   "cmd+v"   → "⌘V"
 *   "ctrl+c"  → "⌃C"
 *
 * On other platforms the input is returned unchanged.
 */
export function formatShortcut(shortcut: string): string {
  if (!isMac) {
    return shortcut;
  }

  return shortcut
    .split(/\s+/)
    .map((combo) => {
      const parts = combo.split('+');
      let result = '';
      for (const part of parts) {
        const lower = part.toLowerCase();
        if (MAC_MODIFIERS[lower]) {
          result += MAC_MODIFIERS[lower];
        } else {
          result += part.toUpperCase();
        }
      }
      return result;
    })
    .join(' ');
}
