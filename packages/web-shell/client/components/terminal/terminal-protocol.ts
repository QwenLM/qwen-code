/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebShellTheme } from '../../themeContext';

export const CONTROL_FRAME_PREFIX = '\x00';
/** Exponential backoff bounds for automatic WebSocket reconnection. */
export const RECONNECT_INITIAL_MS = 500;
export const RECONNECT_MAX_MS = 10_000;
/**
 * Close codes that end the terminal instead of reconnecting. 4003 is the
 * Managed relay's synthesized "worker lost" code (TerminalRelayHandler
 * TERMINAL_LOST_CLOSE_CODE); the daemon's own terminal never sends it, so the
 * shared local panel is unaffected. Keep the two sides in sync.
 */
export const NON_RETRYABLE_CLOSE_CODES = new Set([
  4000, 4001, 4002, 4003, 4004,
]);

export const WS_AUTH_SUBPROTOCOL = 'qwen-ws';
export const WS_BEARER_SUBPROTOCOL_PREFIX = 'qwen-bearer.';

export function xtermTheme(theme: WebShellTheme) {
  return theme === 'light'
    ? {
        background: '#ffffff',
        foreground: '#1a1a1a',
        cursor: '#1a1a1a',
        // An unset selectionBackground defaults to white in xterm and blends
        // into the white terminal background, leaving text selection with no
        // visible highlight in the light theme. Pin the light-theme selection
        // blue instead so selected terminal text stays visible.
        selectionBackground: '#bdd8fe',
      }
    : {
        background: '#0a0a0a',
        foreground: '#e0e6f0',
        cursor: '#e0e6f0',
      };
}
