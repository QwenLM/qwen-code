/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Peer addressing and loop detection.
 *
 * A peer address is the reply handle carried on every cross-session message.
 * Only one scheme exists today: `uds:<percent-encoded socket path>`.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';

export const UDS_ADDRESS_PREFIX = 'uds:';

/** Upper bound on a serialized address, enforced by the envelope parser. */
export const MAX_PEER_ADDRESS_LENGTH = 300;

/**
 * Longest hop chain we will accept. Beyond this the envelope fails to parse and
 * the message is dropped, which is the only bound on chain length: this session
 * only ever emits a one-hop chain of its own address.
 */
export const MAX_HOP_CHAIN = 32;

/** Hex length of one hop identifier. */
export const HOP_ID_LENGTH = 24;

/** Hex digits of the disambiguating suffix a peer listing escalates to. */
const SHORT_REF_LENGTH = 6;

/** Hex digits of the handle a session is addressed by. */
export const HANDLE_LENGTH = 2;

const ADDRESS_CHARSET = /^[A-Za-z0-9%:_/.\\-]+$/;

/** Characters that survive percent-encoding unescaped. */
const SAFE_ADDRESS_CHAR = /[A-Za-z0-9_/.-]/;

function percentEncode(value: string): string {
  let out = '';
  for (const char of value) {
    if (SAFE_ADDRESS_CHAR.test(char)) {
      out += char;
      continue;
    }
    for (const byte of Buffer.from(char, 'utf8')) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

function percentDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape means the address was not produced by us. Returning it
    // verbatim keeps the caller's own validation in charge of rejecting it.
    return value;
  }
}

/** Wraps a socket path into the `uds:` address used as a reply handle. */
export function toUdsAddress(socketPath: string): string {
  return `${UDS_ADDRESS_PREFIX}${percentEncode(socketPath)}`;
}

export interface ParsedPeerAddress {
  scheme: 'uds' | 'other';
  target: string;
}

/**
 * Splits an address into scheme and target. A bare absolute path is accepted as
 * a `uds` address so hand-written configuration stays usable.
 */
export function parsePeerAddress(address: string): ParsedPeerAddress {
  if (address.startsWith(UDS_ADDRESS_PREFIX)) {
    return {
      scheme: 'uds',
      target: percentDecode(address.slice(UDS_ADDRESS_PREFIX.length)),
    };
  }
  if (address.startsWith('/')) return { scheme: 'uds', target: address };
  return { scheme: 'other', target: address };
}

/** Whether a string is shaped like an address we are willing to parse. */
export function isValidPeerAddress(address: string): boolean {
  return (
    address.length > 0 &&
    address.length <= MAX_PEER_ADDRESS_LENGTH &&
    ADDRESS_CHARSET.test(address)
  );
}

/**
 * Whether a path is safe to `connect()` to.
 *
 * Rejects anything that is not a plain absolute path, so a crafted address can
 * never steer a connection at a URL or a relative path resolved against an
 * attacker-influenced cwd.
 */
export function isLocalIpcPath(candidate: string): boolean {
  if (!candidate || candidate.includes('\0')) return false;
  if (candidate.includes('://')) return false;
  return path.isAbsolute(candidate);
}

function sessionDigest(kind: string, id: string): string {
  return createHash('sha256').update(`${kind}:${id}`).digest('hex');
}

/** Short, stable disambiguator for two peers sharing a display name. */
export function shortRef(kind: string, id: string): string {
  return sessionDigest(kind, id).slice(0, SHORT_REF_LENGTH);
}

/**
 * The address a session answers to for as long as it runs.
 *
 * A function of the socket path alone, so every session on this machine derives
 * the same handle for the same peer — which is what makes it safe for one
 * session to tell another, in prose, to ask `-46`. It is a *prefix* of
 * {@link shortRef}, so a listing escalates to a longer slice of one hash rather
 * than to a second identity; the two live together here so that stays true.
 */
export function peerHandle(socketPath: string): string {
  return sessionDigest('session', socketPath).slice(0, HANDLE_LENGTH);
}

/**
 * The handle of whoever sent a message, from the address it asks replies at.
 *
 * The address is sender-authored and is not an authenticator. What deriving a
 * handle from it buys is falsifiability: the result either names a row in the
 * peer listing or names nothing, where a claimed name can only be read.
 */
export function peerHandleFromAddress(address: string): string | undefined {
  const parsed = parsePeerAddress(address);
  return parsed.scheme === 'uds' && parsed.target
    ? peerHandle(parsed.target)
    : undefined;
}

/**
 * Stable per-address hop identifier.
 *
 * Unkeyed on purpose: loop detection only works if every session derives the
 * same identifier for the same address, so any key would have to be shared
 * machine-wide and would buy no secrecy. See design §5 decision 10.
 */
export function hopIdForAddress(address: string): string {
  return createHash('sha256')
    .update(address)
    .digest('hex')
    .slice(0, HOP_ID_LENGTH);
}

/**
 * Whether a chain already passed through the given hop.
 *
 * The receiving half of loop detection, and the only half there is. Sending is
 * always one hop (see `uds-client.ts`), because relaying here is a model calling
 * `SendMessage` and nothing distinguishes that from replying — so this guard
 * exists for a chain some other relay built, not for one of ours.
 */
export function hopChainContains(
  chain: readonly string[] | undefined,
  hopId: string,
): boolean {
  return chain?.includes(hopId) ?? false;
}
