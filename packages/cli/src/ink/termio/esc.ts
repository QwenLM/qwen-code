/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

/**
 * ESC Sequence Parser
 *
 * Handles simple escape sequences: ESC + one or two characters
 */

import type { Action } from './types.js';

/** Save cursor state (DECSC, ESC 7). */
export const SAVE_CURSOR = '\x1b7';

/** Restore cursor state (DECRC, ESC 8). */
export const RESTORE_CURSOR = '\x1b8';

/**
 * Parse a simple ESC sequence
 *
 * @param chars - Characters after ESC (not including ESC itself)
 */
export function parseEsc(chars: string): Action | null {
  if (chars.length === 0) return null;

  const first = chars[0]!;

  // Full reset (RIS)
  if (first === 'c') {
    return { type: 'reset' };
  }

  // Cursor save (DECSC)
  if (first === '7') {
    return { type: 'cursor', action: { type: 'save' } };
  }

  // Cursor restore (DECRC)
  if (first === '8') {
    return { type: 'cursor', action: { type: 'restore' } };
  }

  // Index - move cursor down (IND)
  if (first === 'D') {
    return {
      type: 'cursor',
      action: { type: 'move', direction: 'down', count: 1 },
    };
  }

  // Reverse index - move cursor up (RI)
  if (first === 'M') {
    return {
      type: 'cursor',
      action: { type: 'move', direction: 'up', count: 1 },
    };
  }

  // Next line (NEL)
  if (first === 'E') {
    return { type: 'cursor', action: { type: 'nextLine', count: 1 } };
  }

  // Horizontal tab set (HTS)
  if (first === 'H') {
    return null; // Tab stop, not commonly needed
  }

  // Charset selection (ESC ( X, ESC ) X, etc.) - silently ignore
  if ('()'.includes(first) && chars.length >= 2) {
    return null;
  }

  // Unknown
  return { type: 'unknown', sequence: `\x1b${chars}` };
}
