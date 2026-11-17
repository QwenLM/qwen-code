/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  advertisablePeerAddress,
  reachableEntries,
  resolvePeerTarget,
  suggestPeerNames,
  toDirectoryEntry,
  type PeerDirectoryEntry,
} from '../../../src/peer/directory.js';
import { peerRef } from '../../../src/peer/label.js';
import type { SessionRecord } from '../../../src/peer/registry.js';

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const sessionId = overrides.sessionId ?? 'session-a';
  return {
    schemaVersion: 1,
    pid: 100,
    procStart: null,
    pidNs: null,
    sessionId,
    cwd: '/w/a',
    name: 'alpha',
    startedAt: 1,
    qwenVersion: null,
    ipcPath: `/tmp/${sessionId}.sock`,
    ipcToken: 'tok',
    ...overrides,
  };
}

function entry(name: string, sessionId: string): PeerDirectoryEntry {
  return toDirectoryEntry(record({ name, sessionId }))!;
}

describe('toDirectoryEntry', () => {
  it('reads a record without a kind as tui, and flattens what it shows', () => {
    const peer = toDirectoryEntry(
      record({ name: 'al\npha', cwd: '/w/\u202ea' }),
    );
    expect(peer).toMatchObject({
      name: 'al pha',
      cwd: '/w/ a',
      kind: 'tui',
      ref: peerRef('session-a'),
    });
  });

  it('has nothing to address without an inbox or a name', () => {
    expect(toDirectoryEntry(record({ ipcPath: undefined }))).toBeNull();
    expect(toDirectoryEntry(record({ name: '\n\t' }))).toBeNull();
  });
});

describe('reachableEntries', () => {
  it('dials each address once, and keeps only what answers', async () => {
    const probe = vi.fn(async (socketPath: string) =>
      socketPath === '/tmp/shared.sock'
        ? ('alive' as const)
        : ('dead' as const),
    );
    const peers = await reachableEntries(
      [
        record({ sessionId: 's1', name: 'one', ipcPath: '/tmp/shared.sock' }),
        record({ sessionId: 's2', name: 'two', ipcPath: '/tmp/shared.sock' }),
        record({ sessionId: 's3', name: 'three', ipcPath: '/tmp/gone.sock' }),
      ],
      probe,
    );
    expect(probe).toHaveBeenCalledTimes(2);
    expect(peers.map((peer) => peer.name).sort()).toEqual(['one', 'two']);
  });

  it('does not advertise an address whose probe established nothing', async () => {
    const peers = await reachableEntries([record()], async () => 'unknown');
    expect(peers).toEqual([]);
  });

  it('keeps the newest of two processes running one session under one name', async () => {
    const peers = await reachableEntries(
      [
        record({ ipcPath: '/tmp/old.sock', startedAt: 1 }),
        record({ ipcPath: '/tmp/new.sock', startedAt: 2 }),
      ],
      async () => 'alive',
    );
    expect(peers).toHaveLength(1);
    expect(peers[0]?.ipcPath).toBe('/tmp/new.sock');
  });
});

describe('resolvePeerTarget', () => {
  const alpha = entry('alpha', 'session-a');
  const beta = entry('beta', 'session-b');
  const peers = [alpha, beta];

  it('resolves a name, name [ref], [ref] and a bare ref', () => {
    for (const target of [
      'alpha',
      ` alpha [${alpha.ref}] `,
      `[${alpha.ref}]`,
      alpha.ref.toUpperCase(),
    ]) {
      expect(resolvePeerTarget(peers, target)).toEqual({
        kind: 'one',
        peer: alpha,
      });
    }
    expect(resolvePeerTarget(peers, 'gamma')).toEqual({ kind: 'none' });
    expect(resolvePeerTarget(peers, '  ')).toEqual({ kind: 'none' });
  });

  it('refuses to pick between two sessions that share a name', () => {
    const twin = entry('alpha', 'session-c');
    const result = resolvePeerTarget([alpha, twin], 'alpha');
    expect(result.kind).toBe('ambiguous');
    expect(resolvePeerTarget([alpha, twin], `alpha [${twin.ref}]`)).toEqual({
      kind: 'one',
      peer: twin,
    });
  });

  it('treats a name that equals another session ref as a claim from both', () => {
    const impostor = entry(alpha.ref, 'session-z');
    expect(resolvePeerTarget([alpha, impostor], alpha.ref).kind).toBe(
      'ambiguous',
    );
  });

  it('matches a literal bracketed name as itself', () => {
    const bracketed = entry('notes [abcd]', 'session-n');
    expect(resolvePeerTarget([bracketed], 'notes [abcd]')).toEqual({
      kind: 'one',
      peer: bracketed,
    });
  });
});

describe('advertisablePeerAddress and suggestPeerNames', () => {
  it('prints the bare name when it is unique, and adds the ref when it is not', () => {
    const alpha = entry('alpha', 'session-a');
    const twin = entry('alpha', 'session-c');
    expect(advertisablePeerAddress(alpha, [alpha])).toBe('alpha');
    expect(advertisablePeerAddress(alpha, [alpha, twin])).toBe(
      `alpha [${alpha.ref}]`,
    );
  });

  it('suggests prefix matches first, from a bracketed typo too', () => {
    const peers = [
      entry('my-app', 's1'),
      entry('app-server', 's2'),
      entry('docs', 's3'),
    ];
    expect(suggestPeerNames(peers, 'app [12')).toEqual([
      'app-server',
      'my-app',
    ]);
    expect(suggestPeerNames(peers, '')).toEqual([]);
  });
});

describe('directory — twins and contested names', () => {
  it('adds the ref to a suggestion whose name another session shares', () => {
    const first = entry('app', 's1');
    const second = entry('app', 's2');
    const peers = [first, second, entry('docs', 's3')];
    expect(suggestPeerNames(peers, 'ap').sort()).toEqual(
      [`app [${first.ref}]`, `app [${second.ref}]`].sort(),
    );
  });

  it('drops a twin that does not answer before picking the newest, so a dead copy never shadows a live one', async () => {
    const peers = await reachableEntries(
      [
        record({ ipcPath: '/tmp/alive.sock', startedAt: 1 }),
        record({ ipcPath: '/tmp/dead.sock', startedAt: 2 }),
      ],
      async (socketPath) =>
        socketPath === '/tmp/alive.sock' ? 'alive' : 'dead',
    );
    expect(peers.map((peer) => peer.ipcPath)).toEqual(['/tmp/alive.sock']);
  });

  it('keeps both twins when asked not to collapse them, which makes the name ambiguous', async () => {
    const peers = await reachableEntries(
      [
        record({ ipcPath: '/tmp/a.sock', startedAt: 1 }),
        record({ ipcPath: '/tmp/b.sock', startedAt: 2 }),
      ],
      async () => 'alive',
      { collapseTwins: false },
    );
    expect(peers).toHaveLength(2);
    expect(resolvePeerTarget(peers, 'alpha').kind).toBe('ambiguous');
    expect(peers.map((peer) => advertisablePeerAddress(peer, peers))).toEqual([
      undefined,
      undefined,
    ]);
  });
});
