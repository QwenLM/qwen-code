/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const listLiveSessions = vi.fn();
const probePeerSocket = vi.fn();

vi.mock('../services/session-registry.js', () => ({
  listLiveSessions: (...args: unknown[]) => listLiveSessions(...args),
}));
vi.mock('./uds-client.js', () => ({
  probePeerSocket: (...args: unknown[]) => probePeerSocket(...args),
}));

const {
  formatPeerAddress,
  listMessageablePeers,
  peerRef,
  resolvePeerTarget,
  suggestPeerNames,
} = await import('./peer-directory.js');

type Peer = Awaited<ReturnType<typeof listMessageablePeers>>[number];

function peer(over: Partial<Peer> & { sessionId: string; name: string }): Peer {
  return {
    ref: peerRef(over.sessionId),
    cwd: '/w/app',
    pid: 100,
    ipcPath: `/tmp/${over.sessionId}.sock`,
    startedAt: 1_000,
    ...over,
  } as Peer;
}

function record(over: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    pid: 100,
    procStart: null,
    sessionId: 's1',
    cwd: '/w/app',
    name: 'app-ab',
    kind: 'interactive',
    startedAt: 1_000,
    qwenVersion: null,
    peerProtocol: 1,
    ...over,
  };
}

beforeEach(() => {
  listLiveSessions.mockReset();
  probePeerSocket.mockReset();
  probePeerSocket.mockResolvedValue(true);
});

describe('peerRef', () => {
  it('is six hex characters', () => {
    expect(peerRef('some-session-id')).toMatch(/^[0-9a-f]{6}$/);
  });

  it('is stable for the same session and differs across sessions', () => {
    expect(peerRef('a')).toBe(peerRef('a'));
    expect(peerRef('a')).not.toBe(peerRef('b'));
  });
});

describe('listMessageablePeers', () => {
  it('skips records with no inbox advertised', async () => {
    listLiveSessions.mockResolvedValue([
      record({ sessionId: 's1', ipcPath: '/tmp/s1.sock' }),
      record({ sessionId: 's2' }),
    ]);
    const peers = await listMessageablePeers();
    expect(peers.map((p) => p.sessionId)).toEqual(['s1']);
  });

  it('skips records whose socket does not answer', async () => {
    listLiveSessions.mockResolvedValue([
      record({ sessionId: 's1', ipcPath: '/tmp/s1.sock' }),
      record({ sessionId: 's2', ipcPath: '/tmp/s2.sock' }),
    ]);
    probePeerSocket.mockImplementation(async (path: string) =>
      path.endsWith('s1.sock'),
    );

    const peers = await listMessageablePeers();
    expect(peers.map((p) => p.sessionId)).toEqual(['s1']);
  });

  it('probes concurrently rather than one at a time', async () => {
    listLiveSessions.mockResolvedValue([
      record({ sessionId: 's1', ipcPath: '/tmp/s1.sock' }),
      record({ sessionId: 's2', ipcPath: '/tmp/s2.sock' }),
      record({ sessionId: 's3', ipcPath: '/tmp/s3.sock' }),
    ]);
    let inFlight = 0;
    let peak = 0;
    probePeerSocket.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return true;
    });

    await listMessageablePeers();
    expect(peak).toBe(3);
  });

  it('returns an empty list when nothing is registered', async () => {
    listLiveSessions.mockResolvedValue([]);
    expect(await listMessageablePeers()).toEqual([]);
  });
});

describe('resolvePeerTarget', () => {
  const a = peer({ sessionId: 's1', name: 'app-ab' });
  const b = peer({ sessionId: 's2', name: 'app-ab', cwd: '/w/other' });
  const c = peer({ sessionId: 's3', name: 'docs-cd' });

  it('resolves a unique bare name', () => {
    expect(resolvePeerTarget([a, c], 'docs-cd')).toEqual({
      kind: 'one',
      peer: c,
    });
  });

  it('refuses to guess between two sessions sharing a name', () => {
    const result = resolvePeerTarget([a, b, c], 'app-ab');
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.matches).toHaveLength(2);
    }
  });

  it('resolves "name [ref]"', () => {
    expect(resolvePeerTarget([a, b], `app-ab [${b.ref}]`)).toEqual({
      kind: 'one',
      peer: b,
    });
  });

  it('accepts a bare ref', () => {
    expect(resolvePeerTarget([a, b], b.ref)).toEqual({ kind: 'one', peer: b });
  });

  it('accepts an uppercase ref', () => {
    expect(
      resolvePeerTarget([a, b], `app-ab [${b.ref.toUpperCase()}]`),
    ).toEqual({ kind: 'one', peer: b });
  });

  it('tolerates surrounding whitespace', () => {
    expect(resolvePeerTarget([c], '  docs-cd  ')).toEqual({
      kind: 'one',
      peer: c,
    });
  });

  it('rejects a ref that does not belong to the named session', () => {
    expect(resolvePeerTarget([a, c], `docs-cd [${a.ref}]`)).toEqual({
      kind: 'none',
    });
  });

  it('rejects an unknown name', () => {
    expect(resolvePeerTarget([a], 'nope')).toEqual({ kind: 'none' });
  });

  it('rejects an empty target', () => {
    expect(resolvePeerTarget([a], '   ')).toEqual({ kind: 'none' });
  });

  it('resolves nothing against an empty directory', () => {
    expect(resolvePeerTarget([], 'app-ab')).toEqual({ kind: 'none' });
  });

  // The inbound envelope advertises the sender's socket path as the reply
  // address, so it has to route back even when the name is contested or
  // the frame carried no name at all.
  it.skipIf(process.platform === 'win32')(
    'resolves the socket path an envelope hands back as its reply address',
    () => {
      expect(resolvePeerTarget([a, b, c], b.ipcPath)).toEqual({
        kind: 'one',
        peer: b,
      });
    },
  );

  // The path branch matches literally. Asserting only that an unrelated
  // stale path misses is vacuous — a session name can never equal a path
  // (`RECORD_NAME` has no '/'), so every implementation returns 'none'
  // for it. What can actually regress is the comparison itself widening
  // to a substring test, which would route a dead session's reply address
  // to whichever live peer its path happens to contain.
  it.skipIf(process.platform === 'win32')(
    'matches a reply address literally rather than by containment',
    () => {
      // A stale path that has a live peer's path as a prefix.
      expect(resolvePeerTarget([a, c], `${a.ipcPath}.old`)).toEqual({
        kind: 'none',
      });
      // A stale path that is a prefix of a live peer's path.
      expect(resolvePeerTarget([a, c], a.ipcPath.slice(0, -1))).toEqual({
        kind: 'none',
      });
      // And the only reachable peer is still not a fallback for a path
      // that matches nothing.
      expect(resolvePeerTarget([a], '/tmp/gone.sock')).toEqual({
        kind: 'none',
      });
    },
  );
});

describe('formatPeerAddress', () => {
  const a = peer({ sessionId: 's1', name: 'app-ab' });
  const b = peer({ sessionId: 's2', name: 'app-ab' });
  const c = peer({ sessionId: 's3', name: 'docs-cd' });

  it('is the bare name when it is unique', () => {
    expect(formatPeerAddress(c, [a, c])).toBe('docs-cd');
  });

  it('appends the ref only when the name is contested', () => {
    expect(formatPeerAddress(a, [a, b, c])).toBe(`app-ab [${a.ref}]`);
  });
});

describe('suggestPeerNames', () => {
  const a = peer({ sessionId: 's1', name: 'qwen-code-f7' });
  const b = peer({ sessionId: 's2', name: 'qwen-code-37' });
  const c = peer({ sessionId: 's3', name: 'docs-cd' });

  it('suggests names sharing a prefix', () => {
    expect(suggestPeerNames([a, b, c], 'qwen-code')).toEqual([
      'qwen-code-f7',
      'qwen-code-37',
    ]);
  });

  it('suggests on a substring too', () => {
    expect(suggestPeerNames([a, b, c], 'code-37')).toEqual(['qwen-code-37']);
  });

  it('disambiguates its suggestions when names collide', () => {
    const d = peer({ sessionId: 's4', name: 'qwen-code-f7' });
    expect(suggestPeerNames([a, d], 'qwen')).toEqual([
      `qwen-code-f7 [${a.ref}]`,
      `qwen-code-f7 [${d.ref}]`,
    ]);
  });

  it('returns nothing rather than guessing wildly', () => {
    expect(suggestPeerNames([a, b, c], 'zzz')).toEqual([]);
    expect(suggestPeerNames([a, b, c], '  ')).toEqual([]);
  });

  it('caps the number of suggestions', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      peer({ sessionId: `s${i}`, name: `app-${i}` }),
    );
    expect(suggestPeerNames(many, 'app')).toHaveLength(3);
  });
});
