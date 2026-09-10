/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What crosses a peer connection: the auth line that opens it, and the
 * frames after it.
 *
 * One JSON object per line. Every field is checked on arrival, because the
 * process at the other end is only as trustworthy as anything else running
 * as this user. A value of the wrong shape is dropped rather than reported:
 * a newer peer is then merely partly unintelligible, never fatal.
 */

import { randomUUID } from 'node:crypto';

/** Bumped only when the shape of an existing field changes. */
export const PEER_FRAME_VERSION = 1;

/**
 * Longest line either side accepts, in UTF-16 code units.
 *
 * Counted on the decoded string rather than in bytes: both ends compare it
 * against a JS string, and re-encoding every line just to count bytes would
 * cost more than the precision is worth. A receiver drops the connection on
 * a longer line, so a sender measures first and fails with a reason instead
 * of a bare reset.
 */
export const MAX_FRAME_CHARS = 1024 * 1024;

/**
 * Most ids one `dropped` receipt settles beyond the one it is addressed for.
 * The list is drawn from ids senders chose, so it is bounded like every
 * other array that crosses a process boundary.
 */
export const MAX_DROPPED_MSG_IDS = 256;

/** How a delivered message competes with whatever the recipient is doing. */
export type PeerMessagePriority = 'now' | 'next';

/**
 * The review class a sender asserts: `prompting` when a person reviews each
 * action, `bypass` when some apply without review. A claim, not a
 * credential; a program that is not a coding session has no honest value to
 * give and should leave it out.
 */
export type PeerModeClass = 'bypass' | 'prompting';

/** Which wall a `dropped` message met. */
export type PeerDropReason = 'rate-limited' | 'duplicate' | 'queue-full';

/** What became of a message on the receiving side. */
export type PeerDeliveryStatus =
  | 'held'
  | 'denied'
  | 'refused'
  | 'expired'
  | 'delivered'
  | 'misaddressed'
  | 'dropped';

export const PEER_DELIVERY_STATUSES: readonly PeerDeliveryStatus[] = [
  'held',
  'denied',
  'refused',
  'expired',
  'delivered',
  'misaddressed',
  'dropped',
];

export interface PeerUserFrame {
  msgV: number;
  msgId: string;
  type: 'user';
  /** The sender's own inbox path, where receipts go. */
  from?: string;
  /** The token the sender's inbox requires, so receipts authenticate. */
  replyToken?: string;
  fromName?: string;
  fromMode?: PeerModeClass;
  /** The session id the sender read from the recipient's record. */
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
  /** The `msgId` this receipt reports on. */
  origMsgId: string;
  from?: string;
  /** Free text for a person. Never parse it. */
  reason?: string;
  /** Only meaningful with `status: 'dropped'`. */
  dropReason?: PeerDropReason;
  /** Further ids this receipt settles. Only with `status: 'dropped'`. */
  droppedMsgIds?: string[];
}

export type PeerFrame = PeerUserFrame | PeerControlFrame;

/**
 * The shape a message id must have.
 *
 * Ids double as handles a person types to decide a held message, so one
 * with whitespace, or one that strips to nothing, could never be decided on
 * its own — and one that canonicalizes to `all` would decide everything.
 */
const MSG_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Dashes stripped, case folded: the form every id comparison uses. */
export function canonicalizeMsgId(msgId: string): string {
  return msgId.replace(/-/g, '').toLowerCase();
}

export function isPeerMsgId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    MSG_ID_RE.test(value) &&
    canonicalizeMsgId(value) !== 'all'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isDeliveryStatus(value: unknown): value is PeerDeliveryStatus {
  return (
    typeof value === 'string' &&
    (PEER_DELIVERY_STATUSES as readonly string[]).includes(value)
  );
}

function optionalDropReason(value: unknown): PeerDropReason | undefined {
  return value === 'rate-limited' ||
    value === 'duplicate' ||
    value === 'queue-full'
    ? value
    : undefined;
}

/**
 * Parse one line into a frame, or return null.
 *
 * A higher `msgV`, an unknown `type` and a malformed field all come back as
 * null rather than an error: nothing about an unintelligible line is worth
 * interrupting anyone for.
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
  if (!isPeerMsgId(msgId)) return null;

  if (parsed['type'] === 'user') {
    const message = parsed['message'];
    if (!isRecord(message) || message['role'] !== 'user') return null;
    const content = message['content'];
    if (typeof content !== 'string' || content.length === 0) return null;
    const fromMode = parsed['fromMode'];
    const replyToken = optionalString(parsed['replyToken']);
    const toSessionId = optionalString(parsed['toSessionId']);
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
      priority: parsed['priority'] === 'now' ? 'now' : 'next',
      message: { role: 'user', content },
    };
  }

  if (parsed['type'] === 'control') {
    if (parsed['action'] !== 'delivery_status') return null;
    const status = parsed['status'];
    if (!isDeliveryStatus(status)) return null;
    const origMsgId = parsed['origMsgId'];
    if (typeof origMsgId !== 'string' || origMsgId.length === 0) return null;
    // Only a drop carries these. Reading them off any other status would let
    // a peer attach ids to, say, a `delivered` receipt and settle messages
    // that receipt says nothing about.
    const dropReason =
      status === 'dropped'
        ? optionalDropReason(parsed['dropReason'])
        : undefined;
    const rawIds = status === 'dropped' ? parsed['droppedMsgIds'] : undefined;
    const droppedMsgIds = Array.isArray(rawIds)
      ? rawIds.filter(isPeerMsgId).slice(0, MAX_DROPPED_MSG_IDS)
      : [];
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
      ...(droppedMsgIds.length > 0 ? { droppedMsgIds } : {}),
    };
  }

  return null;
}

/** One frame as one line, terminator included. */
export function encodePeerFrame(frame: PeerFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * The first line of a connection to an inbox that requires a token.
 *
 * Shaped like a frame, so an inbox that requires no token reads it as an
 * unknown type and skips it: leading with it is always safe.
 */
export function buildAuthLine(token: string): string {
  return `${JSON.stringify({ msgV: PEER_FRAME_VERSION, type: 'auth', token })}\n`;
}

/** The token an auth line presents, or null when the line is not one. */
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

export interface BuildUserFrameFields {
  content: string;
  from?: string;
  replyToken?: string;
  fromName?: string;
  fromMode?: PeerModeClass;
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

export interface BuildDeliveryStatusFields {
  status: PeerDeliveryStatus;
  origMsgId: string;
  from?: string;
  reason?: string;
  dropReason?: PeerDropReason;
  droppedMsgIds?: readonly string[];
}

export function buildDeliveryStatusFrame(
  fields: BuildDeliveryStatusFields,
): PeerControlFrame {
  return {
    msgV: PEER_FRAME_VERSION,
    msgId: randomUUID(),
    type: 'control',
    action: 'delivery_status',
    status: fields.status,
    origMsgId: fields.origMsgId,
    ...(fields.from !== undefined ? { from: fields.from } : {}),
    reason: fields.reason ?? describeDeliveryStatus(fields.status),
    ...(fields.status === 'dropped' && fields.dropReason !== undefined
      ? { dropReason: fields.dropReason }
      : {}),
    // Left off rather than sent empty: the field means "these ids too".
    ...(fields.status === 'dropped' &&
    fields.droppedMsgIds !== undefined &&
    fields.droppedMsgIds.length > 0
      ? { droppedMsgIds: fields.droppedMsgIds.slice(0, MAX_DROPPED_MSG_IDS) }
      : {}),
  };
}

/** A sentence for a person about what a status means for the sender. */
export function describeDeliveryStatus(status: PeerDeliveryStatus): string {
  switch (status) {
    case 'held':
      return 'Your message is waiting for the recipient to review it.';
    case 'denied':
      return 'The recipient reviewed your message and declined it.';
    case 'refused':
      return 'The recipient does not take messages like this one, so nobody saw it. Do not re-send it.';
    case 'expired':
      return 'Your message was not delivered: it waited too long, or the recipient closed first.';
    case 'delivered':
      return 'Your message was delivered.';
    case 'misaddressed':
      return 'That address belongs to a different session than the one you named. Look the recipient up again before re-sending.';
    case 'dropped':
      return 'Your message was turned away before anyone saw it. Treat it as unsent.';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
