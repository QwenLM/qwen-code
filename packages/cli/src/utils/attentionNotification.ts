/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';

export enum AttentionNotificationReason {
  ToolApproval = 'tool_approval',
  LongTaskComplete = 'long_task_complete',
}

export interface TerminalNotificationOptions {
  stream?: Pick<NodeJS.WriteStream, 'write' | 'isTTY'>;
  enabled?: boolean;
}

const TERMINAL_BELL = '\u0007';

/**
 * Grabs the user's attention by emitting the terminal bell character.
 * This causes the terminal to flash or play a sound, alerting the user
 * to check the CLI for important events.
 *
 * @returns true when the bell was successfully written to the terminal.
 */
export function notifyTerminalAttention(
  _reason: AttentionNotificationReason,
  options: TerminalNotificationOptions = {},
): boolean {
  // Check if terminal bell is enabled (default true for backwards compatibility)
  if (options.enabled === false) {
    return false;
  }

  const stream = options.stream ?? process.stdout;
  if (!stream?.write || stream.isTTY === false) {
    return false;
  }

  try {
    stream.write(TERMINAL_BELL);
    return true;
  } catch (error) {
    console.warn('Failed to send terminal bell:', error);
    return false;
  }
}
