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
  MAX_FRAME_BYTES,
  type PeerDeliveryStatus,
  type PeerFrame,
} from './peer-frames.js';
import { isLocalIpcPath } from './socket-path.js';

const debugLogger = createDebugLogger('PEER_IPC');

/** Give up on a peer that accepts a connection but never drains it. */
export const SEND_TIMEOUT_MS = 5_000;

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
 * Resolving means the frame was written and the peer then closed the
 * connection — not that the peer read it, still less that it acted on it.
 * A one-shot write cannot know that; the `delivery_status` control frame
 * is the channel that carries real acknowledgement back.
 *
 * Rejects with a {@link PeerSendError} carrying the underlying errno.
 * Worth telling apart: ENOENT and ECONNREFUSED mean the peer is gone and
 * its address is stale; EAGAIN (POSIX) and EBUSY (Windows named pipes)
 * mean it is alive but its listen backlog is momentarily full, so the same
 * address is worth retrying; ETIMEDOUT means it accepted the connection
 * and then stopped servicing it.
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

    // The receiver drops the connection on an over-long line, which would
    // surface here as a bare ECONNRESET. Fail on this side instead, where
    // the message can name the real problem.
    const encoded = encodePeerFrame(frame);
    if (encoded.length - 1 > MAX_FRAME_BYTES) {
      reject(
        new PeerSendError(
          `Frame is ${encoded.length - 1} characters, over the ${MAX_FRAME_BYTES} limit a peer will accept`,
          'EMSGSIZE',
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
      socket.end(encoded);
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
