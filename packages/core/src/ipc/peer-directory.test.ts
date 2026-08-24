/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRegistryRecord } from '../services/session-registry.js';
import {
  formatPeerAddress,
  listMessageablePeers,
  peerRef,
  resolvePeerTarget,
  type PeerSessionInfo,
} from './peer-directory.js';

const mocks = vi.hoisted(() => ({
  listLiveSessions: vi.fn(),
  probePeerSocket: vi.fn(),
}));

vi.mock('../services/session-registry.js', () => ({
  listLiveSessions: mocks.listLiveSessions,
}));
vi.mock('./uds-client.js', () => ({
  probePeerSocket: mocks.probePeerSocket,
}));

const socket = (name: string) =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\qwen-${name}`
    : `/tmp/qwen-${name}.sock`;

function record(
  name: string,
  overrides: Partial<SessionRegistryRecord> = {},
): SessionRegistryRecord {
  return {
    schemaVersion: 1,
    pid: 10,
    procStart: null,
    pidNs: null,
    sessionId: `${name}-session`,
    cwd: `/work/${name}`,
    name,
    startedAt: 1,
    qwenVersion: null,
    ipcPath: socket(name),
    ...overrides,
  };
}

function peer(name: string, ref: string): PeerSessionInfo {
  return {
    sessionId: `${name}-${ref}`,
    name,
    ref,
    cwd: `/work/${name}`,
    pid: 10,
    ipcPath: socket(ref),
    startedAt: 1,
  };
}

describe('peer directory', () => {
  beforeEach(() => {
    mocks.listLiveSessions.mockReset().mockResolvedValue([]);
    mocks.probePeerSocket.mockReset().mockResolvedValue(true);
  });

  it('derives a stable short ref', () => {
    expect(peerRef('session-a')).toMatch(/^[0-9a-f]{6}$/);
    expect(peerRef('session-a')).toBe(peerRef('session-a'));
    expect(peerRef('session-a')).not.toBe(peerRef('session-b'));
  });

  it('lists only reachable local inboxes and sanitizes display fields', async () => {
    mocks.listLiveSessions.mockResolvedValue([
      record('live\npeer', {
        sessionId: 'live',
        cwd: '/work/live\u001b[2J',
        ipcPath: socket('live'),
      }),
      record('dead', { ipcPath: socket('dead') }),
      record('disabled', { ipcPath: undefined }),
      record('remote', { ipcPath: 'tcp://example.com:80' }),
    ]);
    mocks.probePeerSocket.mockImplementation(
      async (path: string) => path === socket('live'),
    );

    const peers = await listMessageablePeers();

    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({
      sessionId: 'live',
      name: 'live peer',
      cwd: '/work/live [2J',
      ipcPath: socket('live'),
    });
    expect(mocks.probePeerSocket).toHaveBeenCalledTimes(2);
  });

  it('resolves a unique name, ref, or reply socket path', () => {
    const target = peer('worker', 'a1b2c3');
    const peers = [target];

    expect(resolvePeerTarget(peers, 'worker')).toEqual({
      kind: 'one',
      peer: target,
    });
    expect(resolvePeerTarget(peers, 'A1B2C3')).toEqual({
      kind: 'one',
      peer: target,
    });
    expect(resolvePeerTarget(peers, target.ipcPath)).toEqual({
      kind: 'one',
      peer: target,
    });
  });

  it('requires name [ref] when a name is ambiguous', () => {
    const a = peer('worker', 'aaaaaa');
    const b = peer('worker', 'bbbbbb');
    const peers = [a, b];

    expect(resolvePeerTarget(peers, 'worker')).toEqual({
      kind: 'ambiguous',
      matches: peers,
    });
    expect(resolvePeerTarget(peers, 'worker [bbbbbb]')).toEqual({
      kind: 'one',
      peer: b,
    });
    expect(formatPeerAddress(a, peers)).toBe('worker [aaaaaa]');
  });

  it('does not guess when short refs collide', () => {
    const a = peer('one', 'aaaaaa');
    const b = peer('two', 'aaaaaa');
    expect(resolvePeerTarget([a, b], 'aaaaaa')).toEqual({
      kind: 'ambiguous',
      matches: [a, b],
    });
  });
});
