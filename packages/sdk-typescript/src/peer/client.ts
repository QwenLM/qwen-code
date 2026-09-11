/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dialing an inbox: write one frame and hang up, or ask whether anything
 * is listening.
 *
 * No pooling and no persistent link. Messages are rare, an address is
 * stable for its session's lifetime, and a short-lived connection makes a
 * dead peer show up at once as a refused dial rather than as a write into a
 * broken pipe.
 */

import * as net from 'node:net';
import * as path from 'node:path';
import {
  buildAuthLine,
  encodePeerFrame,
  MAX_FRAME_CHARS,
  type PeerFrame,
} from './frames.js';

/** Give up on a peer that accepts a connection and never drains it. */
export const SEND_TIMEOUT_MS = 5_000;

/** How long a reachability probe waits for a local socket to answer. */
export const PROBE_TIMEOUT_MS = 250;

/**
 * Most sends in flight at once. Each holds a descriptor until it settles,
 * and receipts are drawn by traffic other processes control; past this, a
 * send fails with `EBUSY` rather than taking the process's descriptors.
 */
export const MAX_CONCURRENT_SENDS = 64;

let inFlightSends = 0;

export class PeerSendError extends Error {
  /**
   * True when the failure is this process's own limit rather than anything
   * at the other end: nothing was dialed and nothing was written.
   */
  readonly local: boolean;

  constructor(
    message: string,
    /** The errno behind the failure, when there is one. */
    readonly code: string | undefined,
    options: { local?: boolean } = {},
  ) {
    super(message);
    this.name = 'PeerSendError';
    this.local = options.local ?? false;
  }
}

/**
 * True for a path this process is willing to dial.
 *
 * An address is read from a file another process wrote, so it is input,
 * not fact: an absolute local path, or a local pipe on Windows. Nothing
 * relative, nothing that could reach another host.
 */
export function isLocalIpcPath(candidate: string): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (candidate.includes('\0')) return false;
  if (process.platform === 'win32') {
    const normalized = candidate.replace(/\//g, '\\').toLowerCase();
    return (
      normalized.startsWith('\\\\.\\pipe\\') ||
      normalized.startsWith('\\\\?\\pipe\\')
    );
  }
  if (candidate.startsWith('//')) return false;
  return path.isAbsolute(candidate);
}

export interface SendPeerFrameOptions {
  /**
   * The token to present on the auth line: the recipient's `ipcToken`, or a
   * controller token. Leave it out for an inbox whose record advertises no
   * token.
   */
  authToken?: string;
  timeoutMs?: number;
}

/**
 * Write one frame to `socketPath`.
 *
 * Resolving means the frame was written and the peer closed the connection
 * — not that anything acted on it. Receipts are what say that.
 *
 * Rejects with a {@link PeerSendError}. `ENOENT` and `ECONNREFUSED` mean the
 * address is stale; `EAGAIN` and `EBUSY` mean the peer is alive but busy;
 * `ETIMEDOUT` means it accepted the connection and stopped reading, and may
 * still read the frame later; `EMSGSIZE` means the frame was too long to
 * send at all.
 */
export function sendPeerFrame(
  socketPath: string,
  frame: PeerFrame,
  options: SendPeerFrameOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    if (!isLocalIpcPath(socketPath)) {
      reject(
        new PeerSendError(
          `Refusing to dial a path that is not local: ${socketPath}`,
          undefined,
        ),
      );
      return;
    }
    const encoded = encodePeerFrame(frame);
    if (encoded.length - 1 > MAX_FRAME_CHARS) {
      reject(
        new PeerSendError(
          `The frame is ${encoded.length - 1} characters, over the ${MAX_FRAME_CHARS} a peer accepts`,
          'EMSGSIZE',
        ),
      );
      return;
    }
    if (inFlightSends >= MAX_CONCURRENT_SENDS) {
      reject(
        new PeerSendError(
          `Already sending ${inFlightSends} frames; not opening another connection`,
          'EBUSY',
          { local: true },
        ),
      );
      return;
    }

    const socket = net.connect({ path: socketPath });
    inFlightSends += 1;
    let settled = false;
    const settle = (error?: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      inFlightSends -= 1;
      if (error) {
        socket.destroy();
        reject(new PeerSendError(error.message, error.code));
      } else {
        resolve();
      }
    };
    // An absolute deadline rather than an idle timer, which any incoming
    // byte would reset.
    const deadline = setTimeout(() => {
      settle(
        Object.assign(new Error(`Timed out sending to ${socketPath}`), {
          code: 'ETIMEDOUT',
        }),
      );
    }, timeoutMs);
    socket.on('error', (error: NodeJS.ErrnoException) => settle(error));
    socket.on('connect', () => {
      // The auth line rides in the same write as the frame, so a partial
      // flush can never leave the frame stranded without its credentials.
      socket.end(
        options.authToken !== undefined
          ? buildAuthLine(options.authToken) + encoded
          : encoded,
      );
    });
    socket.on('close', () => settle());
  });
}

/**
 * What a probe established. Only `dead` is a definitive negative; `unknown`
 * — a timeout, a permission error, descriptor exhaustion — establishes
 * nothing.
 */
export type PeerSocketVerdict = 'alive' | 'dead' | 'unknown';

/**
 * Dial `socketPath` and report what that established.
 *
 * A full listen backlog (`EAGAIN`, `EBUSY`) is a busy peer, so alive. A
 * missing path or a socket file nothing holds (`ENOENT`, `ECONNREFUSED`) is
 * dead: a socket file outlives a crash, and only a dial tells the two apart.
 */
export function probePeerSocketVerdict(
  socketPath: string,
): Promise<PeerSocketVerdict> {
  return new Promise((resolve) => {
    if (!isLocalIpcPath(socketPath)) {
      resolve('unknown');
      return;
    }
    const socket = net.connect({ path: socketPath });
    let settled = false;
    const settle = (verdict: PeerSocketVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(verdict);
    };
    const deadline = setTimeout(() => settle('unknown'), PROBE_TIMEOUT_MS);
    deadline.unref();
    socket.on('connect', () => settle('alive'));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EAGAIN' || error.code === 'EBUSY') {
        settle('alive');
      } else if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
        settle('dead');
      } else {
        settle('unknown');
      }
    });
  });
}
