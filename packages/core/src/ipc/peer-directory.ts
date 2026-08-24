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
import { isLocalIpcPath } from './socket-path.js';
import { probePeerSocket } from './uds-client.js';

export interface PeerSessionInfo {
  sessionId: string;
  name: string;
  ref: string;
  cwd: string;
  pid: number;
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
    ipcPath: record.ipcPath,
    startedAt: record.startedAt,
  };
}

export async function listMessageablePeers(): Promise<PeerSessionInfo[]> {
  const candidates = (await listLiveSessions())
    .map(toPeer)
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

const PEER_ADDRESS_PREFIX = 'qwen-session:';

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

  const explicit = new RegExp(
    `^${PEER_ADDRESS_PREFIX}([0-9a-f]{6})$`,
    'i',
  ).exec(trimmed);
  if (explicit) {
    const ref = explicit[1]!.toLowerCase();
    return resolveMatches(peers.filter((peer) => peer.ref === ref));
  }

  if (isLocalIpcPath(trimmed)) {
    return resolveMatches(peers.filter((peer) => peer.ipcPath === trimmed));
  }

  return resolveMatches(peers.filter((peer) => peer.name === trimmed));
}

export function formatPeerAddress(peer: PeerSessionInfo): string {
  return `${PEER_ADDRESS_PREFIX}${peer.ref}`;
}

export function isExplicitPeerTarget(target: string): boolean {
  const trimmed = target.trim();
  return (
    new RegExp(`^${PEER_ADDRESS_PREFIX}[0-9a-f]{6}$`, 'i').test(trimmed) ||
    isLocalIpcPath(trimmed)
  );
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
