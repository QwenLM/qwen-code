/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Notification routing service.
 *
 * When `terminalBell` setting is enabled, auto-detects the terminal and
 * sends notifications through the best available channel:
 *
 *   iTerm.app → OSC 9 (native notification)
 *   kitty     → OSC 99 (desktop notification protocol)
 *   ghostty   → OSC 777 (notify)
 *   others    → terminal bell fallback
 *
 * When disabled, no notification is sent.
 */

import { createDebugLogger } from '@qwen-code/qwen-code-core';
import type { TerminalNotification } from '../ui/hooks/useTerminalNotification.js';
import { detectTerminal, generateKittyId } from '../utils/osc.js';

const debugLogger = createDebugLogger('NOTIFICATION_SERVICE');

export interface NotificationOptions {
  message: string;
  title?: string;
}

const DEFAULT_TITLE = 'Qwen Code';

/**
 * Send a notification through the auto-detected channel.
 *
 * @param opts - Notification content
 * @param terminal - Terminal notification primitives
 * @param enabled - Whether notifications are enabled (from `terminalBell` setting)
 * @returns The channel method that was actually used, or 'disabled'.
 */
export function sendNotification(
  opts: NotificationOptions,
  terminal: TerminalNotification,
  enabled: boolean,
): string {
  if (!enabled) {
    return 'disabled';
  }

  // Don't write raw escape sequences when stdout is not a TTY
  // (CI, piped output, redirected to log files, etc.)
  if (!process.stdout?.isTTY) {
    return 'disabled';
  }

  const title = opts.title ?? DEFAULT_TITLE;

  try {
    const terminalType = detectTerminal();

    switch (terminalType) {
      case 'iTerm.app':
        terminal.notifyITerm2({ ...opts, title });
        return 'iterm2';
      case 'kitty':
        terminal.notifyKitty({ ...opts, title, id: generateKittyId() });
        return 'kitty';
      case 'ghostty':
        terminal.notifyGhostty({ ...opts, title });
        return 'ghostty';
      case 'Apple_Terminal':
      default:
        terminal.notifyBell();
        return 'terminal_bell';
    }
  } catch (error) {
    debugLogger.warn('Failed to send notification:', error);
    return 'error';
  }
}
