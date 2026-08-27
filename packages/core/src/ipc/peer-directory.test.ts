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
  advertisablePeerAddress,
  formatPeerAddress,
  listMessageablePeers,
  peerRef,
  resolvePeerTarget,
  suggestPeerNames,
  toPeerSessionInfo,
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
    pidNs: null,
    sessionId: 's1',
    cwd: '/w/app',
    name: 'app-ab',
    startedAt: 1_000,
    qwenVersion: null,
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

describe('toPeerSessionInfo', () => {
  it('is null for a record with no inbox', () => {
    expect(toPeerSessionInfo(record({}) as never)).toBeNull();
  });

  it('flattens a name and cwd that carry control characters', () => {
    const info = toPeerSessionInfo(
      record({
        ipcPath: '/tmp/s1.sock',
        name: 'app\u001b[31m-ab\n',
        cwd: '/w/\rapp',
      }) as never,
    );
    expect(info?.name).toBe('app [31m-ab');
    expect(info?.cwd).toBe('/w/ app');
  });

  it('is null for a record whose name flattens to nothing', () => {
    expect(
      toPeerSessionInfo(
        record({ ipcPath: '/tmp/s1.sock', name: '\u0000\u0007' }) as never,
      ),
    ).toBeNull();
  });

  it('projects the addressable fields and derives the ref', () => {
    expect(
      toPeerSessionInfo(record({ ipcPath: '/tmp/s1.sock' }) as never),
    ).toEqual({
      sessionId: 's1',
      name: 'app-ab',
      ref: peerRef('s1'),
      cwd: '/w/app',
      pid: 100,
      ipcPath: '/tmp/s1.sock',
      startedAt: 1_000,
    });
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
    expect(probePeerSocket).toHaveBeenCalledTimes(1);
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
    expect(probePeerSocket).not.toHaveBeenCalled();
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

  it('accepts a bracketed ref with no name', () => {
    expect(resolvePeerTarget([a, b], `[${b.ref}]`)).toEqual({
      kind: 'one',
      peer: b,
    });
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

  it("refuses to guess when a bare string is one peer's name and another's ref", () => {
    const victim = peer({ sessionId: 's1', name: 'app-ab', ref: 'abc123' });
    const shadow = peer({ sessionId: 's2', name: 'abc123', ref: 'ffffff' });
    const result = resolvePeerTarget([victim, shadow], 'abc123');
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.matches).toEqual(expect.arrayContaining([victim, shadow]));
      expect(result.matches).toHaveLength(2);
    }
  });

  it('refuses to guess between two sessions whose refs collide', () => {
    const x = peer({ sessionId: 's1', name: 'app-ab', ref: 'abc123' });
    const y = peer({ sessionId: 's2', name: 'docs-cd', ref: 'abc123' });
    const result = resolvePeerTarget([x, y], 'abc123');
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') expect(result.matches).toEqual([x, y]);
  });

  it('rejects a ref that does not belong to the named session', () => {
    expect(resolvePeerTarget([a, c], `docs-cd [${a.ref}]`)).toEqual({
      kind: 'none',
    });
  });

  it('does not let a name match by prefix or case', () => {
    expect(resolvePeerTarget([c], 'docs')).toEqual({ kind: 'none' });
    expect(resolvePeerTarget([c], 'DOCS-CD')).toEqual({ kind: 'none' });
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

  it('refuses to guess a bracketed ref shared by two sessions', () => {
    const x = peer({ sessionId: 's1', name: 'app-ab', ref: 'abc123' });
    const y = peer({ sessionId: 's2', name: 'docs-cd', ref: 'abc123' });
    const result = resolvePeerTarget([x, y], '[abc123]');
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') expect(result.matches).toEqual([x, y]);
  });

  it('round-trips a peer whose literal name carries brackets', () => {
    const bracketed = peer({
      sessionId: 's2',
      name: 'notes [deadbeef]',
    });
    expect(resolvePeerTarget([a, bracketed], 'notes [deadbeef]')).toEqual({
      kind: 'one',
      peer: bracketed,
    });
  });

  it('treats literal and ref readings of the same address as ambiguous', () => {
    const notes = peer({ sessionId: 's1', name: 'notes', ref: 'cafe12' });
    const literal = peer({ sessionId: 's2', name: 'notes [cafe12]' });
    const result = resolvePeerTarget([notes, literal], 'notes [cafe12]');
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.matches).toEqual(expect.arrayContaining([notes, literal]));
    }
  });
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

  it('appends the ref when the caller reserves the bare name', () => {
    const reserved = (address: string) => address === 'docs-cd';
    expect(formatPeerAddress(c, [a, c], reserved)).toBe(`docs-cd [${c.ref}]`);
    expect(formatPeerAddress(a, [a, c], reserved)).toBe('app-ab');
  });

  it('round-trips through resolvePeerTarget', () => {
    const peers = [a, b, c];
    for (const each of peers) {
      expect(resolvePeerTarget(peers, formatPeerAddress(each, peers))).toEqual({
        kind: 'one',
        peer: each,
      });
    }
  });
});

describe('advertisablePeerAddress', () => {
  const a = peer({ sessionId: 's1', name: 'app-ab', ref: 'aaa111' });
  const b = peer({ sessionId: 's2', name: 'app-ab', ref: 'bbb222' });
  const c = peer({ sessionId: 's3', name: 'docs-cd', ref: 'ccc333' });

  it('prefers the bare name when it selects the peer uniquely', () => {
    expect(advertisablePeerAddress(c, [a, c])).toBe('docs-cd');
  });

  it('appends the ref when the name is contested or reserved', () => {
    expect(advertisablePeerAddress(a, [a, b, c])).toBe('app-ab [aaa111]');
    expect(
      advertisablePeerAddress(c, [a, c], (address) => address === 'docs-cd'),
    ).toBe('docs-cd [ccc333]');
  });

  it('falls back to the bare ref when the bracketed form is taken literally', () => {
    const literal = peer({
      sessionId: 's4',
      name: 'docs-cd [ccc333]',
      ref: 'ddd444',
    });
    expect(
      advertisablePeerAddress(
        c,
        [c, literal],
        (address) => address === 'docs-cd',
      ),
    ).toBe('[ccc333]');
  });

  it('is undefined when no candidate selects the peer', () => {
    const twin = peer({ sessionId: 's5', name: 'app-ab', ref: 'aaa111' });
    expect(advertisablePeerAddress(a, [a, twin])).toBeUndefined();
  });

  it('never returns a string the caller reserves', () => {
    expect(advertisablePeerAddress(c, [c], () => true)).toBeUndefined();
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

  it('never suggests a bare name the caller would route in-process', () => {
    const reserved = (address: string) => address === 'docs-cd';
    expect(suggestPeerNames([a, b, c], 'docs', 3, reserved)).toEqual([
      `docs-cd [${c.ref}]`,
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
