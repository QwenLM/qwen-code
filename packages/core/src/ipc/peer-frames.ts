/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The wire contract between two Qwen Code sessions on one machine.
 *
 * One frame per line of JSON (NDJSON) over a UNIX domain socket. Newline
 * framing is chosen over a length prefix because it stays debuggable: a
 * frame can be delivered by hand with
 *
 *     echo '{"msgV":1,"type":"user","message":{"role":"user","content":"hi"}}' \
 *       | socat - UNIX-CONNECT:/run/user/1000/qwen-socks/1234.sock
 *
 * Every field is validated on arrival. A frame comes from another process
 * and is therefore untrusted input, even though that process is very
 * likely the same user's own session.
 */

import { randomUUID } from 'node:crypto';

/** Bumped only for a breaking change to the frame shape. */
export const PEER_FRAME_VERSION = 1;

/**
 * Longest single line accepted before the connection is dropped.
 *
 * Without a cap, a peer that never sends a newline would grow the receive
 * buffer until this process dies — a one-line denial of service against a
 * session that merely agreed to listen.
 */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** How a delivered message competes with whatever the user is typing. */
export type PeerMessagePriority = 'now' | 'next';

/** Terminal states a sent message can reach on the receiving side. */
export type PeerDeliveryStatus = 'held' | 'denied' | 'expired' | 'delivered';

export interface PeerUserFrame {
  msgV: number;
  msgId: string;
  type: 'user';
  /** Reply address: the sender's own socket path, or absent if it has none. */
  from?: string;
  /** Sender's display name, for the envelope shown to the model. */
  fromName?: string;
  /**
   * The sender's approval-mode class at send time.
   *
   * Advisory only. Nothing authenticates it — any process that can write to
   * the socket can put any value here — so the receiving gate never lets it
   * decide delivery, and only uses it to word the explanation on a parked
   * message. Do not add a code path that treats `'bypass'` here as evidence
   * of anything.
   */
  fromMode?: 'bypass' | 'prompting';
  priority: PeerMessagePriority;
  message: { role: 'user'; content: string };
}

export interface PeerControlFrame {
  msgV: number;
  msgId: string;
  type: 'control';
  action: 'delivery_status';
  status: PeerDeliveryStatus;
  /** `msgId` of the message this reports on. */
  origMsgId: string;
  from?: string;
  reason?: string;
}

export type PeerFrame = PeerUserFrame | PeerControlFrame;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parse one line into a frame, or return null.
 *
 * Unknown `type` values and unknown-but-higher `msgV` values return null
 * rather than throwing: a newer peer is expected to be unintelligible, and
 * that is not an error condition worth surfacing to the user.
 */
export function parsePeerFrame(line: string): PeerFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const msgV = parsed['msgV'];
  if (typeof msgV !== 'number' || msgV > PEER_FRAME_VERSION) return null;

  const msgId = parsed['msgId'];
  if (typeof msgId !== 'string' || msgId.length === 0) return null;

  if (parsed['type'] === 'user') {
    const message = parsed['message'];
    if (!isRecord(message)) return null;
    if (message['role'] !== 'user') return null;
    const content = message['content'];
    if (typeof content !== 'string' || content.length === 0) return null;

    const priority = parsed['priority'];
    const fromMode = parsed['fromMode'];
    return {
      msgV,
      msgId,
      type: 'user',
      from: optionalString(parsed['from']),
      fromName: optionalString(parsed['fromName']),
      ...(fromMode === 'bypass' || fromMode === 'prompting'
        ? { fromMode }
        : {}),
      priority: priority === 'now' ? 'now' : 'next',
      message: { role: 'user', content },
    };
  }

  if (parsed['type'] === 'control') {
    if (parsed['action'] !== 'delivery_status') return null;
    const status = parsed['status'];
    if (
      status !== 'held' &&
      status !== 'denied' &&
      status !== 'expired' &&
      status !== 'delivered'
    ) {
      return null;
    }
    const origMsgId = parsed['origMsgId'];
    if (typeof origMsgId !== 'string' || origMsgId.length === 0) return null;

    return {
      msgV,
      msgId,
      type: 'control',
      action: 'delivery_status',
      status,
      origMsgId,
      from: optionalString(parsed['from']),
      reason: optionalString(parsed['reason']),
    };
  }

  return null;
}

/** Serialize a frame as one NDJSON line, terminator included. */
export function encodePeerFrame(frame: PeerFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export interface BuildUserFrameFields {
  content: string;
  from?: string;
  fromName?: string;
  fromMode?: 'bypass' | 'prompting';
  priority?: PeerMessagePriority;
}

export function buildUserFrame(fields: BuildUserFrameFields): PeerUserFrame {
  return {
    msgV: PEER_FRAME_VERSION,
    msgId: randomUUID(),
    type: 'user',
    ...(fields.from !== undefined ? { from: fields.from } : {}),
    ...(fields.fromName !== undefined ? { fromName: fields.fromName } : {}),
    ...(fields.fromMode !== undefined ? { fromMode: fields.fromMode } : {}),
    priority: fields.priority ?? 'next',
    message: { role: 'user', content: fields.content },
  };
}

/**
 * Human-readable explanation of a delivery status, sent back to the peer
 * so the sending model can tell "parked for review" apart from "delivered
 * and ignored" — a distinction it cannot otherwise observe.
 */
export function describeDeliveryStatus(status: PeerDeliveryStatus): string {
  switch (status) {
    case 'held':
      return 'Your message is held for the recipient user to review before it reaches their Qwen Code session.';
    case 'denied':
      return 'The recipient declined your message; it was not delivered.';
    case 'expired':
      return 'Your held message expired without a decision and was not delivered.';
    case 'delivered':
      return 'Your message was released to the recipient session.';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export function buildDeliveryStatusFrame(fields: {
  status: PeerDeliveryStatus;
  origMsgId: string;
  from?: string;
}): PeerControlFrame {
  return {
    msgV: PEER_FRAME_VERSION,
    msgId: randomUUID(),
    type: 'control',
    action: 'delivery_status',
    status: fields.status,
    origMsgId: fields.origMsgId,
    ...(fields.from !== undefined ? { from: fields.from } : {}),
    reason: describeDeliveryStatus(fields.status),
  };
}
