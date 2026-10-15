/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Turning what someone typed into a session to write to.
 *
 * Sessions are addressed by name, because a name reads back to a person
 * and survives a restart where a socket path does not. Names are not
 * unique, so each session also has a short `ref`, and an address that could
 * mean two sessions is an error rather than a guess: a message delivered to
 * the wrong session cannot be taken back.
 */

import { probePeerSocketVerdict, type PeerSocketVerdict } from './client.js';
import { flattenPeerLabel, peerRef } from './label.js';
import type { SessionRecord } from './registry.js';

/** A live session that advertises an inbox. */
export interface PeerDirectoryEntry {
  sessionId: string;
  name: string;
  ref: string;
  cwd: string;
  pid: number;
  /** What the session says registered it; absent reads as `tui`. */
  kind: string;
  ipcPath: string;
  ipcToken?: string;
  startedAt: number;
}

/** The addressable view of a record, or null when it has no inbox. */
export function toDirectoryEntry(
  record: SessionRecord,
): PeerDirectoryEntry | null {
  if (!record.ipcPath) return null;
  const name = flattenPeerLabel(record.name);
  if (name.length === 0) return null;
  return {
    sessionId: record.sessionId,
    name,
    ref: peerRef(record.sessionId),
    cwd: flattenPeerLabel(record.cwd),
    pid: record.pid,
    kind: record.kind ?? 'tui',
    ipcPath: record.ipcPath,
    ...(record.ipcToken !== undefined ? { ipcToken: record.ipcToken } : {}),
    startedAt: record.startedAt,
  };
}

/**
 * The entries whose inbox answers a dial.
 *
 * Each distinct address is dialed once: a process hosting several sessions
 * advertises one inbox in all their records, and asking once per record
 * would open that many connections to one socket on every lookup.
 *
 * Then, unless `collapseTwins` is false, one entry per (session id, name) is
 * kept, the newest: resuming a session in a second terminal runs the same id
 * under another process, and two identical entries would make every address
 * for it ambiguous. The collapse also means a copied record shadows the
 * original, so a caller about to present a credential turns it off and
 * treats the pair as the ambiguity it is.
 */
export async function reachableEntries(
  records: readonly SessionRecord[],
  probe: (
    socketPath: string,
  ) => Promise<PeerSocketVerdict> = probePeerSocketVerdict,
  options: { collapseTwins?: boolean } = {},
): Promise<PeerDirectoryEntry[]> {
  const candidates = records
    .map(toDirectoryEntry)
    .filter((entry): entry is PeerDirectoryEntry => entry !== null);
  const verdicts = new Map(
    await Promise.all(
      [...new Set(candidates.map((entry) => entry.ipcPath))].map(
        async (ipcPath) => [ipcPath, await probe(ipcPath)] as const,
      ),
    ),
  );
  const reachable = candidates.filter(
    (entry) => verdicts.get(entry.ipcPath) === 'alive',
  );
  if (options.collapseTwins === false) return reachable;
  const newest = new Map<string, PeerDirectoryEntry>();
  for (const entry of reachable) {
    const key = `${entry.sessionId}\0${entry.name}`;
    const seen = newest.get(key);
    if (!seen || entry.startedAt > seen.startedAt) newest.set(key, entry);
  }
  return [...newest.values()];
}

export type PeerResolution =
  | { kind: 'one'; peer: PeerDirectoryEntry }
  | { kind: 'none' }
  | { kind: 'ambiguous'; matches: PeerDirectoryEntry[] };

/**
 * Match `name`, `name [ref]`, `[ref]` or a bare ref.
 *
 * Every string is read every way it can be — `name [ref]` is also a
 * candidate literal name, a bare word is also a candidate ref — and the
 * matches are merged rather than ranked. Ranking would quietly pick one
 * session when two have a claim.
 */
export function resolvePeerTarget(
  peers: readonly PeerDirectoryEntry[],
  target: string,
): PeerResolution {
  const trimmed = target.trim();
  if (trimmed.length === 0) return { kind: 'none' };
  const decide = (matches: PeerDirectoryEntry[]): PeerResolution => {
    const unique = [...new Set(matches)];
    if (unique.length === 1) return { kind: 'one', peer: unique[0]! };
    if (unique.length > 1) return { kind: 'ambiguous', matches: unique };
    return { kind: 'none' };
  };

  const withRef = /^(.*?)\s*\[([0-9a-f]{4,12})\]$/i.exec(trimmed);
  if (withRef) {
    const namePart = withRef[1]!;
    const ref = withRef[2]!.toLowerCase();
    return decide([
      ...peers.filter((peer) => peer.name === trimmed),
      ...peers.filter(
        (peer) =>
          peer.ref === ref && (namePart.length === 0 || peer.name === namePart),
      ),
    ]);
  }
  return decide([
    ...peers.filter((peer) => peer.name === trimmed),
    ...peers.filter((peer) => peer.ref === trimmed.toLowerCase()),
  ]);
}

/**
 * The shortest address that resolves back to exactly this peer, or
 * undefined when adversarial names leave none. No address is better than
 * one that routes somewhere else.
 */
export function advertisablePeerAddress(
  peer: PeerDirectoryEntry,
  peers: readonly PeerDirectoryEntry[],
): string | undefined {
  return [peer.name, `${peer.name} [${peer.ref}]`, `[${peer.ref}]`].find(
    (candidate) => {
      const resolved = resolvePeerTarget(peers, candidate);
      return resolved.kind === 'one' && resolved.peer === peer;
    },
  );
}

/**
 * Up to `limit` names containing what was typed, prefix matches first. No
 * edit distance: a confident suggestion of the wrong session is worse than
 * none.
 */
export function suggestPeerNames(
  peers: readonly PeerDirectoryEntry[],
  target: string,
  limit = 3,
): string[] {
  const needle = target
    .trim()
    .replace(/\s*\[[0-9a-f]{0,12}\]?$/i, '')
    .trim()
    .toLowerCase();
  if (needle.length === 0) return [];
  return peers
    .filter((peer) => peer.name.toLowerCase().includes(needle))
    .sort(
      (a, b) =>
        Number(!a.name.toLowerCase().startsWith(needle)) -
        Number(!b.name.toLowerCase().startsWith(needle)),
    )
    .slice(0, limit)
    .map((peer) =>
      peers.filter((other) => other.name === peer.name).length > 1
        ? `${peer.name} [${peer.ref}]`
        : peer.name,
    );
}
