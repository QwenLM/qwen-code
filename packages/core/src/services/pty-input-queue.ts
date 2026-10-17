/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WindowsPtyAgentInternals } from './conpty-host.js';

export interface PtyInputQueueInternals {
  _socket?: { writableLength?: number };
  _agent?: WindowsPtyAgentInternals;
  _writeStream?: {
    _writeQueue?: Array<{ buffer?: Buffer; offset?: number }>;
  };
}

/**
 * Private queue shapes for @lydell/node-pty 1.2.0-beta.10 (the core pin):
 * POSIX write tasks, Windows input socket, and the legacy POSIX socket.
 * Recheck these shapes and deferred Windows startup writes on upgrades;
 * node-pty's public write() provides no drain signal.
 */
export function getPtyInputQueueBytes(
  pty: PtyInputQueueInternals,
): number | undefined {
  if (pty._writeStream !== undefined) {
    const queue = pty._writeStream?._writeQueue;
    if (!Array.isArray(queue)) return undefined;
    let bytes = 0;
    for (const task of queue) {
      const buffer = task?.buffer;
      const offset = task?.offset;
      if (
        !Buffer.isBuffer(buffer) ||
        typeof offset !== 'number' ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > buffer.length
      ) {
        return undefined;
      }
      bytes += buffer.length - offset;
    }
    return bytes;
  }
  // A Windows PTY's _socket is its output socket, never an input fallback.
  const bytes = (pty._agent !== undefined ? pty._agent?.inSocket : pty._socket)
    ?.writableLength;
  return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0
    ? bytes
    : undefined;
}
