/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Outbound side of the peer transport.
 *
 * One connection per message: connect, write a single NDJSON line, half-close,
 * and resolve only once the socket closes. Resolving on `close` rather than on
 * `write` is what lets `SendMessage` report a real `ENOENT`/`ECONNREFUSED`
 * instead of an optimistic success.
 */

import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { ENV_MESSAGING_SELF_TOKEN } from '../config/brand.js';
import { runLogger } from '../utils/runLogger.js';
import { boundMessagingSocket } from './bound-socket.js';
import {
  getCustomContextFromContext,
  snapshotCustomContext,
} from '../utils/sessionIdContext.js';
import {
  buildCrossSessionEnvelope,
  type PeerModeClass,
} from './cross-session-envelope.js';
import type { PeerMessageStatus } from './inbound-policy.js';
import {
  hopIdForAddress,
  isLocalIpcPath,
  toUdsAddress,
} from './peer-address.js';
import type { PeerFileRef } from './peer-files.js';

/** Abandon a send that has not closed within this long. */
const SEND_TIMEOUT_MS = 5_000;

/**
 * macOS drops buffered bytes if a Unix socket is half-closed immediately after
 * writing, so the FIN is delayed. Other platforms end straight away.
 */
const MACOS_HALF_CLOSE_DELAY_MS = 150;

/** Sends remembered for receipt matching. */
const OUTSTANDING_SEND_CAPACITY = 200;

export interface OutstandingSend {
  msgId: string;
  to: string;
  /** Identity of the turn that sent the message, used when its receipt wakes us. */
  customContext?: Readonly<Record<string, string>>;
  /** Session that owns the send, so its receipt wakes the right session. */
  sessionId?: string;
}

const outstandingSends: OutstandingSend[] = [];
const heldSends: OutstandingSend[] = [];

/**
 * This session's own reply address, or undefined when it never bound.
 *
 * Derived from {@link boundMessagingSocket} rather than `ENV_MESSAGING_SOCKET`:
 * that variable is inherited, so a child that never bound would sign its
 * messages with its parent's address — which the receiving parent then drops as
 * a self-echo, and which sends a third party's reply to the parent instead of to
 * the child. No address at all is the honest answer for a process no reply can
 * reach.
 */
function ownReplyAddress(): string | undefined {
  const socket = boundMessagingSocket();
  return socket ? toUdsAddress(socket) : undefined;
}

/** The inherited descendant token, if this process has one. */
export function ownSelfToken(): string | undefined {
  const value = process.env[ENV_MESSAGING_SELF_TOKEN];
  return value && value.length > 0 ? value : undefined;
}

/** Records a send so a later receipt can be attributed to it. */
export function registerOutstandingSend(
  msgId: string,
  to: string,
  customContext?: Readonly<Record<string, string>>,
  sessionId?: string,
): void {
  outstandingSends.push({
    msgId,
    to,
    ...(customContext !== undefined
      ? { customContext: snapshotCustomContext(customContext) }
      : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
  if (outstandingSends.length > OUTSTANDING_SEND_CAPACITY) {
    outstandingSends.shift();
  }
}

/** What a receipt was matched to, or undefined when nothing remembered it. */
export interface AdmittedReceipt {
  /** The peer the original message was sent to. */
  to: string;
  /**
   * Whether this session was previously told the message was held.
   *
   * Keyed on the `held` receipt actually arriving, not on what the receiver
   * did: a receipt that never reached us leaves the record in the outstanding
   * list, so a later status is treated as a first and only answer. That keeps
   * any follow-up notification tied to an instruction this session was really
   * given.
   */
  wasHeld: boolean;
  /** Identity captured when the send was issued. */
  customContext?: Readonly<Record<string, string>>;
  /** Session that owns the send. */
  sessionId?: string;
}

/**
 * Matches a receipt to a remembered send, returning the peer it was sent to.
 *
 * A `held` receipt keeps the record alive in a side list, because a held
 * message can still be followed by `delivered` or `denied` once a human acts.
 */
export function admitReceiptForOutstandingSend(
  msgId: string,
  status: PeerMessageStatus,
): AdmittedReceipt | undefined {
  const index = outstandingSends.findIndex((entry) => entry.msgId === msgId);
  if (index !== -1) {
    const [record] = outstandingSends.splice(index, 1);
    if (record && status === 'held') {
      heldSends.push(record);
      if (heldSends.length > OUTSTANDING_SEND_CAPACITY) heldSends.shift();
    }
    return record
      ? {
          to: record.to,
          wasHeld: false,
          ...(record.customContext !== undefined
            ? { customContext: record.customContext }
            : {}),
          ...(record.sessionId !== undefined
            ? { sessionId: record.sessionId }
            : {}),
        }
      : undefined;
  }

  const heldIndex = heldSends.findIndex((entry) => entry.msgId === msgId);
  if (heldIndex !== -1 && status !== 'held') {
    const record = heldSends.splice(heldIndex, 1)[0];
    return record
      ? {
          to: record.to,
          wasHeld: true,
          ...(record.customContext !== undefined
            ? { customContext: record.customContext }
            : {}),
          ...(record.sessionId !== undefined
            ? { sessionId: record.sessionId }
            : {}),
        }
      : undefined;
  }
  return undefined;
}

/**
 * Writes one NDJSON line to a peer socket.
 *
 * `timeoutMs` exists for shutdown settlement, which has a budget far below the
 * default: a socket left waiting the full five seconds would keep a handle open
 * past the point the caller abandoned it.
 */
export function writeJsonLine(
  socketPath: string,
  payload: unknown,
  timeoutMs: number = SEND_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isLocalIpcPath(socketPath)) {
      reject(new Error(`Refusing to connect to non-local IPC path: ${socketPath}`));
      return;
    }

    const socket = net.connect({ path: socketPath });
    let failed = false;

    socket.setTimeout(timeoutMs, () => {
      failed = true;
      socket.destroy();
      reject(new Error(`Timed out sending to ${socketPath}`));
    });
    socket.on('error', (error) => {
      failed = true;
      reject(error);
    });
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`);
      if (process.platform === 'darwin') {
        setTimeout(() => {
          if (!socket.destroyed) socket.end();
        }, MACOS_HALF_CLOSE_DELAY_MS);
      } else {
        socket.end();
      }
    });
    socket.on('close', () => {
      if (!failed) resolve();
    });
  });
}

export interface SendCrossSessionMessageParams {
  socketPath: string;
  text: string;
  senderName?: string;
  fromMode?: PeerModeClass;
  files?: readonly PeerFileRef[];
  sessionId?: string;
}

/**
 * Delivers a cross-session message.
 *
 * Rejects with the underlying socket error, which the caller maps to a
 * user-facing hint.
 */
export async function sendCrossSessionMessage(
  params: SendCrossSessionMessageParams,
): Promise<{ msgId: string }> {
  const myAddress = ownReplyAddress();
  const envelope = buildCrossSessionEnvelope({
    ...(myAddress !== undefined && { from: myAddress }),
    ...(params.senderName !== undefined && { fromName: params.senderName }),
    ...(params.fromMode !== undefined && { fromMode: params.fromMode }),
    // Exactly one hop, always. Nothing in this process relays a peer message on
    // its own: a forward is a model deciding to send, which is indistinguishable
    // at this layer from a reply — so carrying an inbound chain onto an outgoing
    // message would make B's answer to A look, to A, like a loop and be dropped.
    // The chain therefore records who sent *this* message, and the guard on the
    // receiving side is there for chains built by something that does relay.
    ...(myAddress !== undefined && {
      hopChain: [hopIdForAddress(myAddress)],
    }),
    body: params.text,
  });

  const msgId = randomUUID();
  const selfToken = ownSelfToken();
  // A receipt is delivered to the address on the envelope, so a send that
  // carries none can never be answered. Remembering it would only age a real
  // record out of the ledger.
  if (myAddress !== undefined) {
    registerOutstandingSend(
      msgId,
      toUdsAddress(params.socketPath),
      getCustomContextFromContext(),
      params.sessionId,
    );
  }

  await writeJsonLine(params.socketPath, {
    type: 'user',
    msg_id: msgId,
    message: { role: 'user', content: envelope },
    priority: 'next',
    ...(myAddress !== undefined && { from: myAddress }),
    ...(selfToken !== undefined && { self_token: selfToken }),
    ...(params.files?.length && { file_attachments: params.files }),
  });

  return { msgId };
}

export interface PeerStatusControlFrame {
  type: 'control';
  action: 'peer_message_status';
  status: PeerMessageStatus;
  from: string;
  orig_msg_id?: string;
}

/** Sends a control frame, swallowing transport errors. */
export async function sendControlFrame(
  socketPath: string,
  frame: PeerStatusControlFrame,
  timeoutMs?: number,
): Promise<void> {
  try {
    await writeJsonLine(socketPath, frame, timeoutMs);
  } catch (error) {
    runLogger.debug(`[uds-client] Control frame to ${socketPath} failed: ${error}`);
  }
}

/** @internal Test helper — clears the send ledgers. */
export function _resetOutstandingSendsForTest(): void {
  outstandingSends.length = 0;
  heldSends.length = 0;
}
