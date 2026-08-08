/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client side of same-machine peer messaging: dial a peer's socket, write
 * one frame, hang up.
 *
 * There is no connection pooling and no persistent link. A session's
 * socket path is stable for its lifetime, messages are rare, and a
 * short-lived connection means a dead peer surfaces immediately as
 * ECONNREFUSED instead of as a silent write into a broken pipe.
 */

import * as net from 'node:net';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  buildDeliveryStatusFrame,
  encodePeerFrame,
  type PeerDeliveryStatus,
  type PeerFrame,
} from './peer-frames.js';
import { isLocalIpcPath } from './socket-path.js';

const debugLogger = createDebugLogger('PEER_IPC');

/** Give up on a peer that accepts a connection but never drains it. */
export const SEND_TIMEOUT_MS = 5_000;

/** A liveness probe should cost nothing; a slow answer is a dead peer. */
export const PROBE_TIMEOUT_MS = 250;

export class PeerSendError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'PeerSendError';
  }
}

/**
 * Write one frame to `socketPath`.
 *
 * Rejects with a {@link PeerSendError} carrying the underlying errno so
 * callers can distinguish the cases that matter to a user: ENOENT and
 * ECONNREFUSED mean the peer is gone and its address is stale, while a
 * full listen backlog means it is alive and the same address is worth
 * retrying. Which errno reports that overflow is platform-dependent:
 * Linux returns EAGAIN, other platforms EBUSY.
 */
export function sendPeerFrame(
  socketPath: string,
  frame: PeerFrame,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isLocalIpcPath(socketPath)) {
      reject(
        new PeerSendError(
          `Refusing to connect to a non-local IPC path: ${socketPath}`,
          undefined,
        ),
      );
      return;
    }

    const socket = net.connect({ path: socketPath });
    let settled = false;

    const fail = (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new PeerSendError(error.message, error.code));
    };

    socket.setTimeout(SEND_TIMEOUT_MS, () => {
      fail(
        Object.assign(new Error(`Timed out sending to ${socketPath}`), {
          code: 'ETIMEDOUT',
        }),
      );
    });
    socket.on('error', fail);
    socket.on('connect', () => {
      socket.end(encodePeerFrame(frame));
    });
    socket.on('close', () => {
      if (settled) return;
      settled = true;
      debugLogger.debug(`sent ${frame.type} frame to ${socketPath}`);
      resolve();
    });
  });
}

/**
 * Best-effort delivery receipt.
 *
 * Failures are logged and swallowed: a receipt is a courtesy to the
 * sender, and a peer that has since exited must not turn into an error on
 * the receiving side, which did nothing wrong.
 */
export async function sendDeliveryStatus(
  socketPath: string,
  fields: { status: PeerDeliveryStatus; origMsgId: string; from?: string },
): Promise<void> {
  try {
    await sendPeerFrame(socketPath, buildDeliveryStatusFrame(fields));
  } catch (error) {
    debugLogger.debug(
      `delivery-status (${fields.status}) to ${socketPath} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * True when something is listening on `socketPath`.
 *
 * A full listen backlog counts as alive: the peer is listening but
 * momentarily saturated, which is a busy session, not a dead one. Linux
 * reports that overflow as `EAGAIN` and other platforms as `EBUSY`, so
 * both have to count — keying on `EBUSY` alone buries every congested
 * Linux peer. Everything else — including a socket file left behind by a
 * crashed process — is dead, which is the point: a stale socket inode
 * still stats fine, so only a dial can tell the difference.
 */
export function probePeerSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!isLocalIpcPath(socketPath)) {
      resolve(false);
      return;
    }
    const socket = net.connect({ path: socketPath });
    const settle = (alive: boolean) => {
      socket.destroy();
      resolve(alive);
    };
    socket.on('connect', () => settle(true));
    socket.on('error', (error: NodeJS.ErrnoException) =>
      settle(error.code === 'EBUSY' || error.code === 'EAGAIN'),
    );
    socket.setTimeout(PROBE_TIMEOUT_MS, () => settle(false));
  });
}
