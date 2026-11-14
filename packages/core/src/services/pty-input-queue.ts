/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WindowsPtyAgentInternals } from './conpty-host.js';

export const PTY_INPUT_QUEUE_FIELDS = [
  '_writeStream._writeQueue',
  '_agent.inSocket.writableLength',
  '_socket.writableLength',
  'stats.writeQueuedBytes',
] as const;

export const MAX_PTY_INPUT_QUEUE_TASKS = 1024;

export type PtyInputQueueBytes = number | 'saturated' | undefined;

export interface PtyInputQueueInternals {
  stats?: { writeQueuedBytes?: number };
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
 * Bun exposes retained queued/in-flight bytes through its public stats.
 * A POSIX queue at the task limit is saturated without inspecting its entries.
 * Below that limit every task is validated, bounding work per admission even
 * when a stalled child retains many one-byte writes. Drain restores capacity.
 */
export function getPtyInputQueueBytes(
  pty: PtyInputQueueInternals,
): PtyInputQueueBytes {
  if (pty._writeStream !== undefined) {
    const queue = pty._writeStream?._writeQueue;
    if (!Array.isArray(queue)) return undefined;
    if (queue.length >= MAX_PTY_INPUT_QUEUE_TASKS) return 'saturated';
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
  const stats = pty.stats;
  const bytes =
    stats !== undefined
      ? stats?.writeQueuedBytes
      : (pty._agent !== undefined ? pty._agent?.inSocket : pty._socket)
          ?.writableLength;
  return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0
    ? bytes
    : undefined;
}
