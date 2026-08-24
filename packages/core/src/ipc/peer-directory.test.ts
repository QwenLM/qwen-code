/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRegistryRecord } from '../services/session-registry.js';
import {
  formatPeerAddress,
  isExplicitPeerTarget,
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
    procStart: 'process-10',
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

  it('bounds concurrent reachability probes', async () => {
    mocks.listLiveSessions.mockResolvedValue(
      Array.from({ length: 20 }, (_, index) => record(`peer-${index}`)),
    );
    let active = 0;
    let maxActive = 0;
    mocks.probePeerSocket.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return true;
    });

    const peers = await listMessageablePeers();

    expect(peers).toHaveLength(20);
    expect(maxActive).toBe(8);
  });

  it('resolves a unique name, explicit address, or reply socket path', () => {
    const target = peer('worker', 'a1b2c3');
    const peers = [target];

    expect(formatPeerAddress(target)).toMatch(/^qwen-session:[0-9a-f]{64}$/);
    expect(isExplicitPeerTarget(formatPeerAddress(target))).toBe(true);

    expect(resolvePeerTarget(peers, 'worker')).toEqual({
      kind: 'one',
      peer: target,
    });
    expect(
      resolvePeerTarget(peers, formatPeerAddress(target).toUpperCase()),
    ).toEqual({
      kind: 'one',
      peer: target,
    });
    expect(resolvePeerTarget(peers, target.ipcPath)).toEqual({
      kind: 'one',
      peer: target,
    });
  });

  it('requires an explicit address when a name is ambiguous', () => {
    const a = peer('worker', 'aaaaaa');
    const b = peer('worker', 'bbbbbb');
    const peers = [a, b];

    expect(resolvePeerTarget(peers, 'worker')).toEqual({
      kind: 'ambiguous',
      matches: peers,
    });
    expect(resolvePeerTarget(peers, formatPeerAddress(b))).toEqual({
      kind: 'one',
      peer: b,
    });
    expect(formatPeerAddress(a)).not.toBe(formatPeerAddress(b));
  });

  it('does not use the short display ref as the address identity', () => {
    const a = peer('one', 'aaaaaa');
    const b = peer('two', 'aaaaaa');
    expect(formatPeerAddress(a)).not.toBe(formatPeerAddress(b));
    expect(resolvePeerTarget([a, b], formatPeerAddress(a))).toEqual({
      kind: 'one',
      peer: a,
    });
  });

  it('binds an address to one live process incarnation', () => {
    const original = peer('worker', 'aaaaaa');
    const sibling = {
      ...original,
      ipcPath: socket('sibling'),
    };
    const pidReuse = {
      ...original,
      startedAt: original.startedAt + 1,
    };

    expect(formatPeerAddress(original)).not.toBe(formatPeerAddress(sibling));
    expect(formatPeerAddress(original)).not.toBe(formatPeerAddress(pidReuse));
    expect(resolvePeerTarget([pidReuse], formatPeerAddress(original))).toEqual({
      kind: 'none',
    });
  });

  it('round-trips advertised addresses containing reserved syntax', () => {
    const peers = [
      peer('target [bbbbbb]', 'aaaaaa'),
      peer('target', 'bbbbbb'),
      peer('/tmp/path-shaped-name', 'cccccc'),
    ];

    for (const candidate of peers) {
      expect(resolvePeerTarget(peers, formatPeerAddress(candidate))).toEqual({
        kind: 'one',
        peer: candidate,
      });
    }
  });

  it('keeps explicit and reply-path namespaces separate from names', () => {
    const named = peer('/tmp/forged.sock', 'aaaaaa');
    const path = {
      ...peer('other', 'bbbbbb'),
      ipcPath: '/tmp/forged.sock [aaaaaa]',
    };
    expect(resolvePeerTarget([named, path], formatPeerAddress(named))).toEqual({
      kind: 'one',
      peer: named,
    });
    expect(
      resolvePeerTarget([named, path], '/tmp/forged.sock [aaaaaa]'),
    ).toEqual({ kind: 'one', peer: path });

    const bareName = peer('cccccc', 'dddddd');
    const bareRef = peer('ref-owner', 'cccccc');
    expect(resolvePeerTarget([bareName, bareRef], 'cccccc')).toEqual({
      kind: 'one',
      peer: bareName,
    });

    const malformed = peer('qwen-session:truncated', 'eeeeee');
    expect(resolvePeerTarget([malformed], 'qwen-session:truncated')).toEqual({
      kind: 'none',
    });
  });
});
