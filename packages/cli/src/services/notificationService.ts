/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Notification routing service.
 *
 * Routes notifications to the appropriate terminal channel based on
 * user configuration (`notifications` setting) and auto-detected
 * terminal type.
 *
 * Channel priority in `auto` mode:
 *   iTerm.app → OSC 9 (native notification)
 *   kitty     → OSC 99 (desktop notification protocol)
 *   ghostty   → OSC 777 (notify)
 *   others    → terminal bell fallback
 *
 * Reference: Claude Code's `src/services/notifier.ts`
 */

import { createDebugLogger } from '@qwen-code/qwen-code-core';
import type { TerminalNotification } from '../ui/hooks/useTerminalNotification.js';
import { detectTerminal, generateKittyId } from '../utils/osc.js';

const debugLogger = createDebugLogger('NOTIFICATION_SERVICE');

export type NotificationChannel =
  | 'auto'
  | 'iterm2'
  | 'kitty'
  | 'ghostty'
  | 'terminal_bell'
  | 'notifications_disabled';

export interface NotificationOptions {
  message: string;
  title?: string;
}

const DEFAULT_TITLE = 'Qwen Code';

/**
 * Send a notification through the configured channel.
 *
 * @returns The channel method that was actually used, or 'disabled'/'none'.
 */
export function sendNotification(
  opts: NotificationOptions,
  terminal: TerminalNotification,
  channel: NotificationChannel,
): string {
  const title = opts.title ?? DEFAULT_TITLE;

  try {
    switch (channel) {
      case 'auto':
        return sendAuto(opts, terminal);
      case 'iterm2':
        terminal.notifyITerm2({ ...opts, title });
        return 'iterm2';
      case 'kitty':
        terminal.notifyKitty({ ...opts, title, id: generateKittyId() });
        return 'kitty';
      case 'ghostty':
        terminal.notifyGhostty({ ...opts, title });
        return 'ghostty';
      case 'terminal_bell':
        terminal.notifyBell();
        return 'terminal_bell';
      case 'notifications_disabled':
        return 'disabled';
      default:
        return 'none';
    }
  } catch (error) {
    debugLogger.warn('Failed to send notification:', error);
    return 'error';
  }
}

function sendAuto(
  opts: NotificationOptions,
  terminal: TerminalNotification,
): string {
  const title = opts.title ?? DEFAULT_TITLE;
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
      // Apple Terminal doesn't support OSC notifications;
      // fall through to bell
      terminal.notifyBell();
      return 'terminal_bell';
    default:
      // Unknown terminal — bell is the safest fallback
      terminal.notifyBell();
      return 'terminal_bell';
  }
}
