/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  listLiveSessions,
  type SessionRegistryRecord,
} from '../services/session-registry.js';
import { flattenPeerLabel } from './peer-envelope.js';
import {
  hasPeerSessionAddressPrefix,
  isPeerSessionAddress,
  PEER_SESSION_ADDRESS_PREFIX,
} from './peer-frames.js';
import { isLocalIpcPath } from './socket-path.js';
import { probePeerSocket } from './uds-client.js';

const MAX_CONCURRENT_PEER_PROBES = 8;

export interface PeerSessionInfo {
  sessionId: string;
  name: string;
  ref: string;
  cwd: string;
  pid: number;
  procStart: string | null;
  ipcPath: string;
  startedAt: number;
}

export function peerRef(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 6);
}

function toPeer(record: SessionRegistryRecord): PeerSessionInfo | null {
  if (!record.ipcPath || !isLocalIpcPath(record.ipcPath)) return null;
  const name = flattenPeerLabel(record.name);
  if (!name) return null;
  return {
    sessionId: record.sessionId,
    name,
    ref: peerRef(record.sessionId),
    cwd: flattenPeerLabel(record.cwd),
    pid: record.pid,
    procStart: record.procStart,
    ipcPath: record.ipcPath,
    startedAt: record.startedAt,
  };
}

export async function listMessageablePeers(): Promise<PeerSessionInfo[]> {
  const candidates = (await listLiveSessions())
    .map(toPeer)
    .filter((peer): peer is PeerSessionInfo => peer !== null);
  const reachable = new Array<boolean>(candidates.length).fill(false);
  let nextIndex = 0;
  const probeNext = async () => {
    while (nextIndex < candidates.length) {
      const index = nextIndex++;
      reachable[index] = await probePeerSocket(candidates[index]!.ipcPath);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_PEER_PROBES, candidates.length) },
      probeNext,
    ),
  );
  return candidates.filter((_, index) => reachable[index]);
}

export type PeerResolution =
  | { kind: 'one'; peer: PeerSessionInfo }
  | { kind: 'none' }
  | { kind: 'ambiguous'; matches: PeerSessionInfo[] };

function resolveMatches(matches: PeerSessionInfo[]): PeerResolution {
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'one', peer: matches[0]! };
  return { kind: 'ambiguous', matches };
}

export function resolvePeerTarget(
  peers: readonly PeerSessionInfo[],
  target: string,
): PeerResolution {
  const trimmed = target.trim();
  if (!trimmed) return { kind: 'none' };

  if (hasPeerSessionAddressPrefix(trimmed)) {
    if (!isPeerSessionAddress(trimmed)) return { kind: 'none' };
    return resolveMatches(
      peers.filter(
        (peer) =>
          formatPeerAddress(peer).toLowerCase() === trimmed.toLowerCase(),
      ),
    );
  }

  if (isLocalIpcPath(trimmed)) {
    return resolveMatches(peers.filter((peer) => peer.ipcPath === trimmed));
  }

  return resolveMatches(peers.filter((peer) => peer.name === trimmed));
}

export function formatPeerAddress(
  peer: Pick<
    PeerSessionInfo,
    'sessionId' | 'ipcPath' | 'pid' | 'procStart' | 'startedAt'
  >,
): string {
  const token = createHash('sha256')
    .update(peer.sessionId)
    .update('\0')
    .update(peer.ipcPath)
    .update('\0')
    .update(String(peer.pid))
    .update('\0')
    .update(peer.procStart ?? '')
    .update('\0')
    .update(String(peer.startedAt))
    .digest('hex');
  return `${PEER_SESSION_ADDRESS_PREFIX}${token}`;
}

export function isExplicitPeerTarget(target: string): boolean {
  const trimmed = target.trim();
  return hasPeerSessionAddressPrefix(trimmed) || isLocalIpcPath(trimmed);
}

export function suggestPeerNames(
  peers: readonly PeerSessionInfo[],
  target: string,
): string[] {
  const needle = target.trim().toLowerCase();
  if (!needle) return [];
  return peers
    .filter((peer) => peer.name.toLowerCase().includes(needle))
    .slice(0, 3)
    .map((peer) => formatPeerAddress(peer));
}
