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
 *
 * Measured in UTF-16 code units, not bytes, because both sides compare it
 * against a decoded JS string; re-encoding every chunk just to count bytes
 * would cost more than the precision is worth. A line made entirely of
 * astral characters can therefore hold up to four times this many bytes —
 * still bounded, which is the only property the cap has to guarantee.
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
   * The sender's approval-mode class at send time, used for mode parity on
   * the receiving side. Absent means "asserts nothing", which the gate
   * treats as the cautious case rather than as a match.
   */
  fromMode?: 'bypass' | 'prompting';
  /**
   * Session id of the intended recipient. The address a sender dials is
   * keyed by PID, and PIDs get reused, so a receiver whose session id
   * differs refuses the frame: it was written for whoever held this
   * address when the sender last looked, not for the session holding it
   * now. Absent means the sender did not say, which older senders don't.
   */
  toSessionId?: string;
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

/**
 * Accepted shape of a `msgId` on the wire.
 *
 * An id is also the handle the user types into `/peers` to decide a held
 * message: `/peers` tokenizes input on whitespace and prints dash-stripped
 * handles, so an id with whitespace has no typable handle and an id that
 * dash-strips to nothing renders an empty one. Either defeats per-message
 * review — with a benign-plus-malicious pair, the user who wants the
 * benign message is forced into `accept all`, releasing the malicious one
 * unreviewed. An id that canonicalizes to `all` is refused for the same
 * reason: it aliases the bulk keyword, so it could never be decided
 * individually — acting on its displayed handle would decide every held
 * message instead. `buildUserFrame` emits `randomUUID`, which always
 * passes.
 */
const MSG_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The one handle form every id comparison and display uses: dashes
 * stripped, case folded. `/peers` resolution prints and matches handles in
 * this form, so the gate's duplicate guard must compare ids in it too —
 * two ids that canonicalize alike would otherwise both park while showing
 * the identical handle, undecidable individually.
 */
export function canonicalizeMsgId(msgId: string): string {
  return msgId.replace(/-/g, '').toLowerCase();
}

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
  if (typeof msgId !== 'string' || !MSG_ID_RE.test(msgId)) return null;
  // Reserved at the wire boundary: `/peers` intercepts the `all` keyword
  // before it ever resolves an id.
  if (canonicalizeMsgId(msgId) === 'all') return null;

  if (parsed['type'] === 'user') {
    const message = parsed['message'];
    if (!isRecord(message)) return null;
    if (message['role'] !== 'user') return null;
    const content = message['content'];
    if (typeof content !== 'string' || content.length === 0) return null;

    const priority = parsed['priority'];
    const fromMode = parsed['fromMode'];
    const toSessionId = optionalString(parsed['toSessionId']);
    return {
      msgV,
      msgId,
      type: 'user',
      from: optionalString(parsed['from']),
      fromName: optionalString(parsed['fromName']),
      ...(fromMode === 'bypass' || fromMode === 'prompting'
        ? { fromMode }
        : {}),
      ...(toSessionId !== undefined ? { toSessionId } : {}),
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
  toSessionId?: string;
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
    ...(fields.toSessionId !== undefined
      ? { toSessionId: fields.toSessionId }
      : {}),
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
