/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Turning "the name a model typed" into "a socket to write to".
 *
 * Discovery reads the session registry, keeps the records that advertise
 * an inbox, and dials each one — a record can outlive its process by the
 * width of a crash, and a stale socket file still stats fine, so only a
 * connection proves reachability.
 *
 * Addressing is by **name**, not by path. A socket path is an
 * implementation detail that changes every restart; a name survives one,
 * reads back to the user, and is what `qwen sessions ps` already prints.
 * Names are not unique, so each peer also carries a short `ref` derived
 * from its session id, and an ambiguous name is an error rather than a
 * guess — see {@link resolvePeerTarget}.
 */

import { createHash } from 'node:crypto';
import {
  listLiveSessions,
  type SessionRegistryRecord,
} from '../services/session-registry.js';
import { flattenPeerLabel } from './peer-envelope.js';
import { probePeerSocket } from './uds-client.js';

/** A live session that can be sent to. */
export interface PeerSessionInfo {
  sessionId: string;
  name: string;
  /** Short disambiguator, stable for the life of the session. */
  ref: string;
  cwd: string;
  pid: number;
  ipcPath: string;
  startedAt: number;
}

/**
 * Short handle for a session, derived from its id.
 *
 * Six hex characters: long enough that a collision between the handful of
 * sessions on one machine is unlikely, short enough to type. Derived
 * rather than random so the same session always prints the same ref, even
 * across separate `list_agents` calls.
 */
export function peerRef(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 6);
}

/**
 * The addressable view of a registry record, or null if it has no inbox.
 *
 * `name` and `cwd` are read from a file another process wrote and end up
 * in tool output and error messages, so they are flattened the way the
 * envelope flattens a sender's label: control characters collapsed and
 * the length capped. A name that flattens to nothing cannot be typed, so
 * the record is not addressable.
 */
export function toPeerSessionInfo(
  record: SessionRegistryRecord,
): PeerSessionInfo | null {
  if (!record.ipcPath) return null;
  const name = flattenPeerLabel(record.name);
  if (name.length === 0) return null;
  return {
    sessionId: record.sessionId,
    name,
    ref: peerRef(record.sessionId),
    cwd: flattenPeerLabel(record.cwd),
    pid: record.pid,
    ipcPath: record.ipcPath,
    startedAt: record.startedAt,
  };
}

/**
 * Every peer session that is live *and* currently accepting messages.
 *
 * Probes run concurrently and each is capped at 250 ms, so the whole call
 * costs about one probe's latency however many sessions are registered.
 */
export async function listMessageablePeers(): Promise<PeerSessionInfo[]> {
  const records = await listLiveSessions();
  const candidates = records
    .map(toPeerSessionInfo)
    .filter((peer): peer is PeerSessionInfo => peer !== null);

  const reachable = await Promise.all(
    candidates.map((peer) => probePeerSocket(peer.ipcPath)),
  );
  return candidates.filter((_, index) => reachable[index]);
}

export type PeerResolution =
  | { kind: 'one'; peer: PeerSessionInfo }
  | { kind: 'none' }
  | { kind: 'ambiguous'; matches: PeerSessionInfo[] };

/**
 * Parse `"name"`, `"name [ref]"`, or a bare ref, and match it against the
 * reachable peers.
 *
 * An ambiguous bare name resolves to nothing and reports the matches
 * instead of picking one. Injecting a message into the wrong session is
 * not recoverable by retrying — the other session has already acted on
 * it — so the caller is made to say which one it meant. That also makes
 * pinning unnecessary: a bare name that could mean two sessions never
 * silently switches between them, because it never resolves at all.
 */
export function resolvePeerTarget(
  peers: readonly PeerSessionInfo[],
  target: string,
): PeerResolution {
  const trimmed = target.trim();
  if (trimmed.length === 0) return { kind: 'none' };

  // "name [ref]" — the form list_agents prints. It has two readings: the
  // bracketed form names a session by ref, but the whole string is also a
  // candidate literal name — registry names are other-process input and
  // can themselves contain brackets. Resolve both and merge: picking one
  // reading silently injects into the wrong session when both have a
  // claim, and a literal bracketed name must round-trip to itself.
  const withRef = /^(.*?)\s*\[([0-9a-f]{4,12})\]$/i.exec(trimmed);
  if (withRef) {
    const [, namePart, ref] = withRef;
    const bracketed = peers.filter(
      (peer) =>
        peer.ref === ref!.toLowerCase() &&
        (namePart!.length === 0 || peer.name === namePart),
    );
    const literal = peers.filter((peer) => peer.name === trimmed);
    const matches = [...new Set([...literal, ...bracketed])];
    if (matches.length === 1) return { kind: 'one', peer: matches[0]! };
    if (matches.length > 1) return { kind: 'ambiguous', matches };
    return { kind: 'none' };
  }

  // A bare string is read two ways as well — as a name, and as a ref (an
  // error message quotes one, and making the user reconstruct "name
  // [ref]" from it would be busywork). Merged, not ranked: a name that
  // equals another session's ref is a claim from both, and resolving it
  // by priority would inject into whichever one the ladder happened to
  // try first.
  const byName = peers.filter((peer) => peer.name === trimmed);
  const byRef = peers.filter((peer) => peer.ref === trimmed.toLowerCase());
  const matches = [...new Set([...byName, ...byRef])];
  if (matches.length === 1) return { kind: 'one', peer: matches[0]! };
  if (matches.length > 1) return { kind: 'ambiguous', matches };

  return { kind: 'none' };
}

/**
 * How a peer is addressed in output: bare name, or `name [ref]`.
 *
 * The ref is appended when the bare name is contested by another peer,
 * or when `isReserved` says the caller's own routing would keep the bare
 * name in-process (a teammate of the same name, the broadcast keyword) —
 * an address that reads as a peer but routes elsewhere is worse than a
 * longer one.
 */
export function formatPeerAddress(
  peer: PeerSessionInfo,
  peers: readonly PeerSessionInfo[],
  isReserved?: (address: string) => boolean,
): string {
  const contested =
    peers.filter((other) => other.name === peer.name).length > 1;
  return contested || isReserved?.(peer.name) === true
    ? `${peer.name} [${peer.ref}]`
    : peer.name;
}

/**
 * Suggest the closest names when a target does not resolve.
 *
 * Prefix and substring only — no edit distance. A near-miss on this list
 * is almost always a truncation or a forgotten suffix, and a fuzzy match
 * that confidently proposes the wrong session is worse than no
 * suggestion.
 */
export function suggestPeerNames(
  peers: readonly PeerSessionInfo[],
  target: string,
  limit = 3,
  isReserved?: (address: string) => boolean,
): string[] {
  const needle = target.trim().toLowerCase();
  if (needle.length === 0) return [];
  return peers
    .filter((peer) => {
      const name = peer.name.toLowerCase();
      return name.startsWith(needle) || name.includes(needle);
    })
    .slice(0, limit)
    .map((peer) => formatPeerAddress(peer, peers, isReserved));
}
