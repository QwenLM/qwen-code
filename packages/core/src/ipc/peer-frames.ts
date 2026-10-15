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
import type { PeerDropReason } from './peer-admission.js';

/** Bumped only for a breaking change to the frame shape. */
export const PEER_FRAME_VERSION = 1;

/**
 * Most ids one `dropped` receipt may list beyond the one it is addressed
 * for.
 *
 * A receipt that folds a burst has to name what it stands for, but the
 * list is written by the receiver from ids a *sender* chose, so it needs a
 * ceiling like every other peer-supplied array. A sender that lost more
 * than this many in one batch learns the count from its own ledger.
 */
export const MAX_DROPPED_MSG_IDS = 256;

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
export type PeerDeliveryStatus =
  | 'held'
  /** A person reviewed the message and declined it. */
  | 'denied'
  /**
   * The receiving session's policy turns peer messages away, so no
   * person ever saw this one. Distinct from `denied`, which is a
   * decision: a sender that is refused should stop rather than wait for
   * a review that will not happen.
   */
  | 'refused'
  | 'expired'
  | 'delivered'
  /**
   * The frame named a session id the receiver does not hold: the sender's
   * directory was stale (the address changed hands, or the peer ran
   * /clear). Distinct from `denied` — nobody decided anything.
   */
  | 'misaddressed'
  /**
   * The receiver's inbox turned the message away before any policy or
   * person saw it: the sender outran its rate limit, repeated its
   * previous message, or the inbox had no room to queue it. `dropReason`
   * says which, and one receipt may stand for several messages — the
   * rest are named in `droppedMsgIds`.
   *
   * Distinct from `refused`, which is a standing policy, and from
   * `expired`, which is a decision that never came: this one says the
   * message never entered the queue at all and re-sending it now would
   * meet the same wall.
   */
  | 'dropped';

export interface PeerUserFrame {
  msgV: number;
  msgId: string;
  type: 'user';
  /** Reply address: the sender's own socket path, or absent if it has none. */
  from?: string;
  /**
   * Auth token for the sender's own inbox at `from`, so the receiver can
   * authenticate its delivery receipts. Carried in the frame rather than
   * looked up from the registry per receipt: a peer this session accepted
   * a message from could read the token from the sender's 0600 record
   * anyway, so nothing new is exposed. Untrusted like every field here —
   * a wrong value just makes the best-effort receipt bounce.
   */
  replyToken?: string;
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
  /** Which wall the message met. Only meaningful with `status: 'dropped'`. */
  dropReason?: PeerDropReason;
  /**
   * Further messages this receipt settles, beyond `origMsgId`. A burst of
   * drops from one sender is answered with one receipt rather than one
   * each, so the sender can move every message it lost to a terminal
   * state from a single frame. Only meaningful with `status: 'dropped'`.
   */
  droppedMsgIds?: string[];
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
 * Largest authentication token retained from an untrusted peer frame.
 *
 * A real token is 64 hex characters, and a sender's own inbox refuses a
 * presented token over 256, so a longer one cannot authenticate anything
 * and holding it would let a peer choose how many bytes a waiting receipt
 * pins. It is dropped where the token would be *retained* rather than at
 * the parser: the message itself may be perfectly ordinary, and refusing
 * to deliver it over a field that only routes the answer would lose a
 * message in order to bound a buffer.
 */
export const MAX_RETAINED_REPLY_TOKEN_CHARS = 256;

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
 * True for an id that could name a real message on this wire — the same
 * test the frame's own `msgId` passes, applied to the ids a `dropped`
 * receipt folds in. One definition, so a form the parser would refuse at
 * the top of a frame cannot arrive inside one.
 */
function isAddressableMsgId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    MSG_ID_RE.test(value) &&
    canonicalizeMsgId(value) !== 'all'
  );
}

/** The `dropReason` on a control frame, or undefined for anything else. */
function optionalDropReason(value: unknown): PeerDropReason | undefined {
  return value === 'rate-limited' ||
    value === 'duplicate' ||
    value === 'queue-full'
    ? value
    : undefined;
}

/**
 * The ids a `dropped` receipt folds in: well-formed ones only, capped.
 *
 * Written by the receiver but drawn from what senders put on the wire, so
 * it is checked here like every other array that crosses a process
 * boundary. A malformed entry is skipped rather than failing the frame —
 * the receipt still settles every id it got right.
 */
function parseDroppedMsgIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter(isAddressableMsgId).slice(0, MAX_DROPPED_MSG_IDS);
  return ids.length > 0 ? ids : undefined;
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

  // `all` is reserved at the wire boundary: `/peers` intercepts the bulk
  // keyword before it ever resolves an id.
  const msgId = parsed['msgId'];
  if (!isAddressableMsgId(msgId)) return null;

  if (parsed['type'] === 'user') {
    const message = parsed['message'];
    if (!isRecord(message)) return null;
    if (message['role'] !== 'user') return null;
    const content = message['content'];
    if (typeof content !== 'string' || content.length === 0) return null;

    const priority = parsed['priority'];
    const fromMode = parsed['fromMode'];
    const toSessionId = optionalString(parsed['toSessionId']);
    const replyToken = optionalString(parsed['replyToken']);
    return {
      msgV,
      msgId,
      type: 'user',
      from: optionalString(parsed['from']),
      ...(replyToken !== undefined ? { replyToken } : {}),
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
      status !== 'refused' &&
      status !== 'expired' &&
      status !== 'delivered' &&
      status !== 'misaddressed' &&
      status !== 'dropped'
    ) {
      return null;
    }
    const origMsgId = parsed['origMsgId'];
    if (typeof origMsgId !== 'string' || origMsgId.length === 0) return null;

    // Only a drop carries these. Reading them off any other status would
    // let a peer attach a list of ids to, say, a `delivered` receipt and
    // settle messages the receipt says nothing about.
    const dropReason =
      status === 'dropped'
        ? optionalDropReason(parsed['dropReason'])
        : undefined;
    const droppedMsgIds =
      status === 'dropped'
        ? parseDroppedMsgIds(parsed['droppedMsgIds'])
        : undefined;

    return {
      msgV,
      msgId,
      type: 'control',
      action: 'delivery_status',
      status,
      origMsgId,
      from: optionalString(parsed['from']),
      reason: optionalString(parsed['reason']),
      ...(dropReason !== undefined ? { dropReason } : {}),
      ...(droppedMsgIds !== undefined ? { droppedMsgIds } : {}),
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
  replyToken?: string;
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
    ...(fields.replyToken !== undefined
      ? { replyToken: fields.replyToken }
      : {}),
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
    case 'refused':
      return "The recipient session does not accept messages from other sessions, so nobody saw this one. Don't re-send it; reach that session's user another way.";
    case 'expired':
      return 'Your held message expired without a decision and was not delivered.';
    case 'delivered':
      return 'Your message was released to the recipient session.';
    case 'misaddressed':
      return 'That address now belongs to a different session than the one you addressed; it was not delivered. List the agents again before re-sending.';
    case 'dropped':
      return "Your message was dropped at the recipient's inbox before anyone saw it: sent too fast, a repeat of your previous message, or the inbox queue was full. Treat it as unsent; fold what still matters into one later message rather than re-sending.";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/**
 * The half-sentence that names which wall a dropped message met.
 *
 * Written to sit inside the sending session's own transcript line, where
 * the surrounding sentence already says the message was dropped — so this
 * is a cause, not a sentence of its own.
 */
export function describeDropReason(reason: PeerDropReason): string {
  switch (reason) {
    case 'rate-limited':
      return 'you sent faster than that session accepts';
    case 'duplicate':
      return 'it repeated your previous message';
    case 'queue-full':
      return 'its queue of undelivered peer messages was full';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/**
 * The connection-level admission line, not a member of {@link PeerFrame}:
 * an inbox that requires a token reads it off the first line of a
 * connection before any frame is parsed, and it never reaches `onFrame`.
 *
 * Shaped like a frame (`msgV` + `type`) so an inbox that does NOT require
 * a token — an older build — sees an unknown `type` in `parsePeerFrame`,
 * skips the line, and reads the frames after it: a sender can therefore
 * always lead with the auth line when it has the peer's token, without
 * knowing which side of the upgrade the peer is on.
 */
export function buildAuthLine(token: string): string {
  return `${JSON.stringify({ msgV: PEER_FRAME_VERSION, type: 'auth', token })}\n`;
}

/** The token an auth line presents, or null if the line is not one. */
export function parsePeerAuthLine(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const msgV = parsed['msgV'];
  if (typeof msgV !== 'number' || msgV > PEER_FRAME_VERSION) return null;
  if (parsed['type'] !== 'auth') return null;
  const token = parsed['token'];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export function buildDeliveryStatusFrame(fields: {
  status: PeerDeliveryStatus;
  origMsgId: string;
  from?: string;
  dropReason?: PeerDropReason;
  droppedMsgIds?: string[];
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
    ...(fields.dropReason !== undefined
      ? { dropReason: fields.dropReason }
      : {}),
    // An empty list is left off rather than sent as `[]`: the field means
    // "these ids too", and there are none.
    ...(fields.droppedMsgIds !== undefined && fields.droppedMsgIds.length > 0
      ? { droppedMsgIds: fields.droppedMsgIds.slice(0, MAX_DROPPED_MSG_IDS) }
      : {}),
  };
}
