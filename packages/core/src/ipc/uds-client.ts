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

/**
 * Most concurrent outbound sends allowed.
 *
 * Every send holds a file descriptor until it settles, and receipts are
 * drawn by inbound traffic a same-uid peer controls. Without a ceiling a
 * peer that accepts but never drains (each send then hangs a full
 * timeout) can exhaust this session's fd limit with receipts alone — the
 * outbound mirror of what MAX_PEER_CONNECTIONS stops on the inbound side.
 * Sends over the ceiling are dropped; receipts are best-effort anyway.
 *
 * Must stay above MAX_HELD_MESSAGES: closing a session bursts one expiry
 * receipt per held message all at once, and a ceiling below the burst
 * drops the tail — the senders of the oldest held messages would never
 * learn their message expired.
 */
export const MAX_CONCURRENT_SENDS = 64;

/**
 * How long a reachability probe waits for a connection.
 *
 * Discovery probes every registered session concurrently, so this bounds
 * the cost of a `list_agents` call to about one probe however many
 * sessions are registered. A local socket accepts in microseconds; a
 * quarter second is already generous for a machine under load.
 */
export const PROBE_TIMEOUT_MS = 250;

let inFlightSends = 0;

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
  timeoutMs: number = SEND_TIMEOUT_MS,
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

    if (inFlightSends >= MAX_CONCURRENT_SENDS) {
      reject(
        new PeerSendError(
          `Already sending ${inFlightSends} peer frames; not opening another connection`,
          'EBUSY',
        ),
      );
      return;
    }

    const socket = net.connect({ path: socketPath });
    inFlightSends += 1;
    let settled = false;

    const fail = (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      inFlightSends -= 1;
      socket.destroy();
      reject(new PeerSendError(error.message, error.code));
    };

    // An absolute deadline, not socket.setTimeout: that is an *idle* timer
    // that any incoming byte resets, so a peer dribbling one byte at a
    // time would hold the connection (and its fd) open forever.
    const deadline = setTimeout(() => {
      fail(
        Object.assign(new Error(`Timed out sending to ${socketPath}`), {
          code: 'ETIMEDOUT',
        }),
      );
    }, timeoutMs);
    socket.on('error', fail);
    socket.on('connect', () => {
      socket.end(encoded);
    });
    socket.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      inFlightSends -= 1;
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
 * A full listen backlog (EAGAIN on POSIX, EBUSY on Windows named pipes)
 * counts as alive: the peer is listening but momentarily saturated, which
 * is a busy session, not a dead one. Everything else — including a socket
 * file left behind by a crashed process — is dead, which is the point: a
 * stale socket inode still stats fine, so only a dial can tell the
 * difference.
 */
export function probePeerSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!isLocalIpcPath(socketPath)) {
      resolve(false);
      return;
    }
    const socket = net.connect({ path: socketPath });
    let settled = false;
    const settle = (alive: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(alive);
    };
    // An absolute deadline rather than socket.setTimeout, for the same
    // reason sendPeerFrame uses one: an idle timer is reset by any byte.
    const deadline = setTimeout(() => settle(false), PROBE_TIMEOUT_MS);
    deadline.unref();
    socket.on('connect', () => settle(true));
    socket.on('error', (error: NodeJS.ErrnoException) =>
      settle(error.code === 'EAGAIN' || error.code === 'EBUSY'),
    );
  });
}
