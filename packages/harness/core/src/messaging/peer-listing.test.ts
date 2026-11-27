/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV_FEATURE_PREFIX } from '../config/brand.js';
import { CROSS_SESSION_FEATURE_NAME } from './cross-session-feature.js';
import { toUdsAddress } from './peer-address.js';
import {
  addressLabel,
  assignPeerLabels,
  baseNameForSession,
  boundPeerIdentity,
  displayNameForSession,
  formatPeersForModel,
  handleFact,
  listAllPeers,
  peerHandle,
  peerHandleFromAddress,
  resolvePeerRecipient,
  shortRef,
  type PeerEntry,
} from './peer-listing.js';
import type { LivePeerSession } from './session-registry.js';

const mocks = vi.hoisted(() => ({
  boundMessagingSocket: vi.fn<() => string | undefined>(() => undefined),
  listLivePeerSessions: vi.fn(),
}));

vi.mock('./uds-server.js', () => ({
  boundMessagingSocket: mocks.boundMessagingSocket,
}));

vi.mock('./session-registry.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./session-registry.js')>();
  return { ...actual, listLivePeerSessions: mocks.listLivePeerSessions };
});

const FEATURE_ENV = `${ENV_FEATURE_PREFIX}${CROSS_SESSION_FEATURE_NAME}`;

function session(overrides: Partial<LivePeerSession> = {}): LivePeerSession {
  return {
    pid: 100,
    procStart: 0,
    startedAt: Date.now() - 60_000,
    cwd: '/home/dev/project',
    messagingSocketPath: '/tmp/socks/100.sock',
    peerProtocol: 1,
    kind: 'interactive',
    status: 'idle',
    ...overrides,
  };
}

function peer(
  name: string | undefined,
  socketPath: string,
  overrides: Partial<LivePeerSession> = {},
): PeerEntry {
  const live = session({
    messagingSocketPath: socketPath,
    ...(name !== undefined && { name }),
    ...overrides,
  });
  return {
    transport: 'uds',
    address: `uds:${socketPath}`,
    session: live,
    baseName: baseNameForSession(live),
    displayName: displayNameForSession(live),
    handle: peerHandle(socketPath),
    ref: shortRef('session', socketPath),
  };
}

/** An untitled session in `cwd`, which is how a peer is normally named. */
function untitled(cwd: string, socketPath: string): PeerEntry {
  return peer(undefined, socketPath, { cwd });
}

describe('peer listing', () => {
  describe('displayNameForSession', () => {
    it('[AC2] prefers the session name, unsuffixed', () => {
      expect(displayNameForSession(session({ name: 'worker' }))).toBe('worker');
    });

    it('[AC1] suffixes the working directory basename with the handle', () => {
      const live = session();
      expect(displayNameForSession(live)).toBe(
        `project-${peerHandle(live.messagingSocketPath)}`,
      );
    });

    it('[AC1] two untitled sessions in one directory are named apart', () => {
      const first = session({ messagingSocketPath: '/tmp/socks/1.sock' });
      const second = session({ messagingSocketPath: '/tmp/socks/2.sock' });

      expect(displayNameForSession(first)).not.toBe(
        displayNameForSession(second),
      );
    });

    it('falls back again when there is no cwd', () => {
      const live = session({ cwd: '?' });
      expect(displayNameForSession(live)).toBe(
        `(untitled)-${peerHandle(live.messagingSocketPath)}`,
      );
    });

    // A session that failed to bind can still send, cannot be replied to, and
    // has no handle to offer.
    it('omits the handle when the session never bound a socket', () => {
      expect(displayNameForSession({ cwd: '/home/dev/project' })).toBe(
        'project',
      );
    });

    it('reads the base name from the record, not from a rendering', () => {
      // A title ending in a handle-shaped suffix must not be mistaken for one.
      expect(baseNameForSession(session({ name: 'Fix login bug-9c' }))).toBe(
        'Fix login bug-9c',
      );
    });
  });

  describe('peerHandle', () => {
    it('is two hex digits and a prefix of the ref', () => {
      const handle = peerHandle('/tmp/a.sock');
      expect(handle).toMatch(/^[0-9a-f]{2}$/);
      expect(shortRef('session', '/tmp/a.sock').startsWith(handle)).toBe(true);
    });

    // [AC10] The property that makes it safe for one session to tell another,
    // in prose, to ask `-46`: the handle is a function of the socket alone.
    it('[AC10] is the same in every listing on the machine', () => {
      expect(peerHandle('/tmp/a.sock')).toBe(peerHandle('/tmp/a.sock'));
      expect(peerHandleFromAddress('uds:/tmp/a.sock')).toBe(
        peerHandle('/tmp/a.sock'),
      );
    });

    it('has no handle for an address that is not a socket', () => {
      expect(peerHandleFromAddress('bridge:abc')).toBeUndefined();
    });
  });

  describe('boundPeerIdentity', () => {
    let previousFeature: string | undefined;

    beforeEach(() => {
      previousFeature = process.env[FEATURE_ENV];
      mocks.boundMessagingSocket.mockReturnValue(undefined);
      mocks.listLivePeerSessions.mockResolvedValue([]);
    });

    afterEach(() => {
      if (previousFeature === undefined) delete process.env[FEATURE_ENV];
      else process.env[FEATURE_ENV] = previousFeature;
    });

    it('is undefined when this process never bound a socket', () => {
      expect(boundPeerIdentity()).toBeUndefined();
    });

    it('reports the address, handle and ref of the bound socket', () => {
      mocks.boundMessagingSocket.mockReturnValue('/tmp/socks/42.sock');

      expect(boundPeerIdentity()).toEqual({
        address: 'uds:/tmp/socks/42.sock',
        socketPath: '/tmp/socks/42.sock',
        handle: peerHandle('/tmp/socks/42.sock'),
        ref: shortRef('session', '/tmp/socks/42.sock'),
      });
    });

    // The point of deriving this in core: a session's self-reported ref and the
    // ref every peer computes for it must be the same string. Asserting through
    // the real listAllPeers is what makes a change to either derivation fail
    // here rather than silently desynchronizing the two.
    it('reports the same ref a peer computes for the same socket', async () => {
      process.env[FEATURE_ENV] = '1';
      const socketPath = '/tmp/socks/42.sock';
      mocks.boundMessagingSocket.mockReturnValue(socketPath);
      mocks.listLivePeerSessions.mockResolvedValue([
        session({ messagingSocketPath: socketPath }),
      ]);

      const [entry] = await listAllPeers();

      expect(entry.ref).toBe(boundPeerIdentity()?.ref);
      expect(entry.handle).toBe(boundPeerIdentity()?.handle);
      expect(entry.address).toBe(boundPeerIdentity()?.address);
    });
  });

  describe('shortRef', () => {
    it('is stable and six hex digits', () => {
      const ref = shortRef('session', '/tmp/a.sock');
      expect(ref).toMatch(/^[0-9a-f]{6}$/);
      expect(shortRef('session', '/tmp/a.sock')).toBe(ref);
      expect(shortRef('session', '/tmp/b.sock')).not.toBe(ref);
    });
  });

  describe('addressLabel', () => {
    it('[AC2] leaves a unique title alone', () => {
      const peers = [peer('alpha', '/tmp/a.sock'), peer('beta', '/tmp/b.sock')];
      expect(addressLabel(peers, peers[0])).toBe('alpha');
    });

    it('escalates a shared title to the handle rung', () => {
      const peers = [peer('twin', '/tmp/a.sock'), peer('twin', '/tmp/b.sock')];
      expect(addressLabel(peers, peers[0])).toBe(`twin-${peers[0].handle}`);
      expect(addressLabel(peers, peers[1])).toBe(`twin-${peers[1].handle}`);
    });

    it('escalates to the ref rung when handles collide too', () => {
      const collided = (name: string, socketPath: string) => ({
        ...peer(name, socketPath),
        handle: 'aa',
      });
      const peers = [
        collided('twin', '/tmp/a.sock'),
        collided('twin', '/tmp/b.sock'),
      ];

      expect(addressLabel(peers, peers[0])).toBe(`twin-${peers[0].ref}`);
      expect(addressLabel(peers, peers[1])).toBe(`twin-${peers[1].ref}`);
    });

    it('[AC1] untitled peers in one directory need no escalation', () => {
      const peers = [
        untitled('/home/dev/api', '/tmp/a.sock'),
        untitled('/home/dev/api', '/tmp/b.sock'),
      ];
      const labels = assignPeerLabels(peers);

      expect(labels.get(peers[0])).toBe(peers[0].displayName);
      expect(labels.get(peers[1])).toBe(peers[1].displayName);
    });

    // A title can spell exactly what another peer's suffixed name spells. The
    // rung the untitled peer already occupies is not taken from it.
    it('escalates the title that collides with a suffixed name', () => {
      const plain = untitled('/home/dev/api', '/tmp/a.sock');
      const impostor = peer(plain.displayName, '/tmp/b.sock');
      const labels = assignPeerLabels([plain, impostor]);

      expect(labels.get(plain)).toBe(plain.displayName);
      expect(labels.get(impostor)).toBe(
        `${impostor.baseName}-${impostor.handle}`,
      );
    });
  });

  describe('handleFact', () => {
    it('states the handle for a label that does not carry it', () => {
      const alpha = peer('alpha', '/tmp/a.sock');
      expect(handleFact('alpha', alpha)).toBe(`handle -${alpha.handle}`);
    });

    it('says nothing when the label already ends in the suffix', () => {
      const plain = untitled('/home/dev/api', '/tmp/a.sock');
      expect(handleFact(plain.displayName, plain)).toBeUndefined();
      expect(handleFact(`api-${plain.ref}`, plain)).toBeUndefined();
    });
  });

  describe('formatPeersForModel', () => {
    it('says so when nothing is reachable', () => {
      expect(formatPeersForModel([], { localAgents: [] })).toContain(
        'none reachable',
      );
    });

    it('lists local agents separately from peers', () => {
      const output = formatPeersForModel([peer('alpha', '/tmp/a.sock')], {
        localAgents: ['Reviewer'],
      });
      expect(output).toContain('Reviewer');
      expect(output).toContain('alpha');
      expect(output).toContain('Peer sessions');
    });

    it('includes status and working directory', () => {
      const output = formatPeersForModel([peer('alpha', '/tmp/a.sock')], {
        localAgents: [],
      });
      expect(output).toContain('idle');
      expect(output).toContain('/home/dev/project');
    });

    it('[AC3] states the handle of a titled peer, whose name omits it', () => {
      const alpha = peer('alpha', '/tmp/a.sock');
      const output = formatPeersForModel([alpha], { localAgents: [] });

      expect(output).toContain(`handle -${alpha.handle}`);
      expect(output).toContain('its handle does not');
    });

    it('[AC3] does not repeat the handle when the name already carries it', () => {
      const peers = [
        untitled('/home/dev/api', '/tmp/a.sock'),
        untitled('/home/dev/api', '/tmp/b.sock'),
      ];
      const output = formatPeersForModel(peers, { localAgents: [] });

      const rows = output.split('\n').filter((line) => line.startsWith('- api'));
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row).not.toContain('handle -');
    });

    it('[AC3] does not repeat it on an escalated row either', () => {
      const collided = (name: string, socketPath: string) => ({
        ...peer(name, socketPath),
        handle: 'aa',
      });
      const peers = [
        collided('twin', '/tmp/a.sock'),
        collided('twin', '/tmp/b.sock'),
      ];
      const output = formatPeersForModel(peers, { localAgents: [] });

      for (const row of output.split('\n').filter((l) => l.startsWith('- twin'))) {
        expect(row).not.toContain('handle -');
      }
    });

    it('no longer publishes the bracketed ref', () => {
      const output = formatPeersForModel([peer('alpha', '/tmp/a.sock')], {
        localAgents: [],
      });
      expect(output).not.toContain('ref [');
    });
  });

  describe('resolvePeerRecipient', () => {
    it('resolves a unique name', () => {
      const peers = [peer('alpha', '/tmp/a.sock')];
      const match = resolvePeerRecipient(peers, 'alpha');
      expect(match && 'peer' in match && match.peer.displayName).toBe('alpha');
    });

    it('returns undefined for an unknown name', () => {
      expect(resolvePeerRecipient([peer('alpha', '/tmp/a.sock')], 'nope')).toBeUndefined();
    });

    it('refuses to guess between same-named peers', () => {
      const peers = [peer('twin', '/tmp/a.sock'), peer('twin', '/tmp/b.sock')];
      const match = resolvePeerRecipient(peers, 'twin');
      expect(match).toMatchObject({ ambiguous: true, count: 2 });
    });

    it('disambiguates with the ref form', () => {
      const peers = [peer('twin', '/tmp/a.sock'), peer('twin', '/tmp/b.sock')];
      const match = resolvePeerRecipient(peers, `twin [${peers[1].ref}]`);
      expect(match && 'peer' in match && match.peer.address).toBe(
        'uds:/tmp/b.sock',
      );
    });

    it('accepts a bare ref', () => {
      const peers = [peer('twin', '/tmp/a.sock')];
      const match = resolvePeerRecipient(peers, `[${peers[0].ref}]`);
      expect(match && 'peer' in match).toBe(true);
    });

    it('[AC10] a bare ref still reaches the session after it is renamed', () => {
      const before = peer('planning', '/tmp/a.sock');
      const captured = `[${before.ref}]`;

      // Same session, same socket, new name — what `/rename` or a `SetTopic`
      // now produces in a peer's next listing.
      const after = peer('implementing', '/tmp/a.sock');
      expect(after.displayName).not.toBe(before.displayName);

      expect(resolvePeerRecipient([after], before.displayName)).toBeUndefined();
      const match = resolvePeerRecipient([after], captured);
      expect(match && 'peer' in match && match.peer.address).toBe(
        'uds:/tmp/a.sock',
      );
    });

    it('returns undefined for an unknown ref', () => {
      expect(
        resolvePeerRecipient([peer('twin', '/tmp/a.sock')], 'twin [abcdef]'),
      ).toBeUndefined();
    });

    it('[AC4] resolves the handle alone', () => {
      const peers = [
        untitled('/home/dev/api', '/tmp/a.sock'),
        peer('other', '/tmp/b.sock'),
      ];
      const match = resolvePeerRecipient(peers, `-${peers[0].handle}`);
      expect(match && 'peer' in match && match.peer.address).toBe(
        'uds:/tmp/a.sock',
      );
    });

    it('[AC6] the handle still reaches the session after it is renamed', () => {
      const before = untitled('/home/dev/api', '/tmp/a.sock');
      const captured = `-${before.handle}`;
      const after = peer('implementing', '/tmp/a.sock');

      expect(after.displayName).not.toBe(before.displayName);
      expect(resolvePeerRecipient([after], before.displayName)).toBeUndefined();
      const match = resolvePeerRecipient([after], captured);
      expect(match && 'peer' in match && match.peer.address).toBe(
        'uds:/tmp/a.sock',
      );
    });

    it('[AC4] resolves a base name that only one peer answers to', () => {
      const peers = [
        untitled('/home/dev/api', '/tmp/a.sock'),
        untitled('/home/dev/web', '/tmp/b.sock'),
      ];
      const match = resolvePeerRecipient(peers, 'api');
      expect(match && 'peer' in match && match.peer.address).toBe(
        'uds:/tmp/a.sock',
      );
    });

    it('[AC5] refuses to guess between peers sharing a base name', () => {
      const peers = [
        untitled('/home/dev/api', '/tmp/a.sock'),
        untitled('/home/dev/api', '/tmp/b.sock'),
      ];
      expect(resolvePeerRecipient(peers, 'api')).toMatchObject({
        ambiguous: true,
        count: 2,
      });
    });

    // Two peers can present the same display name: one titled `api-46`, one
    // untitled whose suffixed name spells it. The listing gives that row to the
    // untitled peer and escalates the other, and the input resolves to whichever
    // row was labelled with it.
    it('[AC7] resolves the label the listing showed, not the collision', () => {
      const plain = untitled('/home/dev/api', '/tmp/a.sock');
      const impostor = peer(plain.displayName, '/tmp/b.sock');
      const peers = [plain, impostor];

      expect(assignPeerLabels(peers).get(plain)).toBe(plain.displayName);
      const match = resolvePeerRecipient(peers, plain.displayName);
      expect(match && 'peer' in match && match.peer.address).toBe(
        'uds:/tmp/a.sock',
      );

      // …and the escalated peer is reachable at the label it was given.
      const escalated = assignPeerLabels(peers).get(impostor) as string;
      const other = resolvePeerRecipient(peers, escalated);
      expect(other && 'peer' in other && other.peer.address).toBe(
        'uds:/tmp/b.sock',
      );
    });

    describe('colliding refs', () => {
      // Refs are a truncated hash, so a collision is possible. Producing one
      // from real socket paths would mean finding a SHA-256 prefix collision,
      // so the entries are built with equal refs directly.
      const collided = (name: string, socketPath: string) => ({
        ...peer(name, socketPath),
        ref: 'aaaaaa',
      });

      it('refuses to guess when a ref matches two peers', () => {
        const peers = [
          collided('twin', '/tmp/a.sock'),
          collided('twin', '/tmp/b.sock'),
        ];
        const match = resolvePeerRecipient(peers, 'twin [aaaaaa]');
        expect(match).toMatchObject({ ambiguous: true, count: 2 });
      });

      it('still resolves when the display name disambiguates', () => {
        const peers = [
          collided('alpha', '/tmp/a.sock'),
          collided('beta', '/tmp/b.sock'),
        ];
        const match = resolvePeerRecipient(peers, 'beta [aaaaaa]');
        expect(match && 'peer' in match && match.peer.address).toBe(
          'uds:/tmp/b.sock',
        );
      });

      it('is ambiguous for a bare colliding ref', () => {
        const peers = [
          collided('alpha', '/tmp/a.sock'),
          collided('beta', '/tmp/b.sock'),
        ];
        expect(resolvePeerRecipient(peers, '[aaaaaa]')).toMatchObject({
          ambiguous: true,
        });
      });
    });

    describe('ambiguity candidates', () => {
      it('carries every peer the winning tier matched', () => {
        const peers = [peer('twin', '/tmp/a.sock'), peer('twin', '/tmp/b.sock')];
        const match = resolvePeerRecipient(peers, 'twin');
        expect(match).toMatchObject({ ambiguous: true, count: 2 });
        expect(
          match && 'ambiguous' in match ? match.candidates : [],
        ).toEqual(peers);
      });

      /**
       * The case `displayName` alone cannot express. Two untitled sessions in
       * one directory share a base name but *not* a display name, so recovering
       * the candidates by filtering the listing on `displayName` finds one peer
       * for a two-peer ambiguity — and names it with a label that resolves.
       */
      it('carries both peers when the matched tier was the bare base name', () => {
        const peers = [
          untitled('/home/dev/peer-cli-4', '/tmp/a.sock'),
          untitled('/home/dev/peer-cli-4', '/tmp/b.sock'),
        ];
        const match = resolvePeerRecipient(peers, 'peer-cli-4');

        expect(match).toMatchObject({ ambiguous: true, count: 2 });
        if (!match || !('ambiguous' in match)) throw new Error('expected two');

        expect(match.candidates).toEqual(peers);
        expect(new Set(match.candidates.map((c) => c.displayName)).size).toBe(2);
        // What the old re-derivation would have recovered: one peer for a
        // two-peer ambiguity.
        expect(
          peers.filter((p) => p.displayName === match.displayName),
        ).toHaveLength(1);
      });

      it('offers candidates that each resolve uniquely', () => {
        const peers = [
          untitled('/home/dev/peer-cli-4', '/tmp/a.sock'),
          untitled('/home/dev/peer-cli-4', '/tmp/b.sock'),
        ];
        const match = resolvePeerRecipient(peers, 'peer-cli-4');
        const candidates =
          match && 'ambiguous' in match ? match.candidates : [];

        for (const candidate of candidates) {
          const label = addressLabel(peers, candidate);
          expect(resolvePeerRecipient(peers, label)).toHaveProperty(
            'peer',
            candidate,
          );
        }
      });
    });

    /**
     * The reply handle, which is the form the envelope hands the model and the
     * `SendMessage` description tells it to copy back. Nothing resolved it, so
     * the documented way to answer a peer failed every time.
     */
    describe('a uds: address', () => {
      it('[RA1] resolves the address the envelope carries', () => {
        const peers = [peer('alpha', '/tmp/a.sock'), peer('beta', '/tmp/b.sock')];
        const match = resolvePeerRecipient(peers, 'uds:/tmp/b.sock');
        expect(match && 'peer' in match && match.peer.address).toBe(
          'uds:/tmp/b.sock',
        );
      });

      // The wire form is percent-encoded; the same session has to answer to it.
      it('[RA1] resolves a percent-encoded address', () => {
        const socketPath = '/tmp/test socks/100.sock';
        const peers = [peer('alpha', socketPath)];
        const match = resolvePeerRecipient(peers, toUdsAddress(socketPath));
        expect(match && 'peer' in match && match.peer.session.messagingSocketPath).toBe(
          socketPath,
        );
      });

      // An address names one socket, so it outranks the naming ladder: a peer
      // that happens to be *called* another peer's address must not intercept a
      // reply meant for that peer.
      it('[RA1] outranks a peer named after the address', () => {
        const peers = [
          peer('uds:/tmp/b.sock', '/tmp/a.sock'),
          peer('beta', '/tmp/b.sock'),
        ];
        const match = resolvePeerRecipient(peers, 'uds:/tmp/b.sock');
        expect(match && 'peer' in match && match.peer.address).toBe(
          'uds:/tmp/b.sock',
        );
      });

      // Distinguished from an unknown name: the caller copied this string out of
      // a message it received, so "check the spelling" is the wrong answer.
      it('[RA2] reports a well-formed address that nobody answers', () => {
        const peers = [peer('alpha', '/tmp/a.sock')];
        expect(resolvePeerRecipient(peers, 'uds:/tmp/gone.sock')).toEqual({
          staleAddress: true,
          address: 'uds:/tmp/gone.sock',
        });
      });

      // The case a caller most often hits, and the one an early "no peers, give
      // up" return used to swallow.
      it('[RA2] reports a stale address even when no peer is left', () => {
        expect(resolvePeerRecipient([], 'uds:/tmp/gone.sock')).toEqual({
          staleAddress: true,
          address: 'uds:/tmp/gone.sock',
        });
      });

      // A session is free to be named something starting with `/`, and
      // parsePeerAddress reads a bare absolute path as an address. Only the
      // explicit `uds:` form may leave the naming ladder.
      it('[RA2] leaves a name that looks like a path in the ladder', () => {
        const peers = [peer('/tmp/notes.sock', '/tmp/a.sock')];
        const match = resolvePeerRecipient(peers, '/tmp/notes.sock');
        expect(match && 'peer' in match && match.peer.address).toBe(
          'uds:/tmp/a.sock',
        );
      });

      it('[RA2] returns undefined for a malformed address', () => {
        const peers = [peer('alpha', '/tmp/a.sock')];
        for (const bad of [
          'uds:',
          `uds:${'x'.repeat(400)}`,
          'uds:http://evil/x.sock',
          'uds:relative.sock',
        ]) {
          expect(resolvePeerRecipient(peers, bad)).toBeUndefined();
        }
      });
    });
  });

  /**
   * The property the enumerated cases above are examples of.
   *
   * A listing is an address book, so the two halves have to agree: every string
   * it prints must come back to the row that printed it. Asserting it over
   * generated listings — including ones that force each rung of the ladder — is
   * what catches an escalation rule that renders something nothing can resolve,
   * which an example-based test only catches if someone thought of the example.
   */
  describe('[AC7] round trip', () => {
    const listings: Array<[string, PeerEntry[]]> = [
      ['distinct titles', [peer('alpha', '/tmp/a.sock'), peer('beta', '/tmp/b.sock')]],
      [
        'untitled peers in one directory',
        [
          untitled('/home/dev/api', '/tmp/a.sock'),
          untitled('/home/dev/api', '/tmp/b.sock'),
          untitled('/home/dev/api', '/tmp/c.sock'),
        ],
      ],
      [
        'untitled peers across directories',
        [
          untitled('/home/dev/api', '/tmp/a.sock'),
          untitled('/home/dev/web', '/tmp/b.sock'),
        ],
      ],
      ['shared titles', [peer('twin', '/tmp/a.sock'), peer('twin', '/tmp/b.sock')]],
      [
        'a title spelling another peer suffixed name',
        (() => {
          const plain = untitled('/home/dev/api', '/tmp/a.sock');
          return [plain, peer(plain.displayName, '/tmp/b.sock')];
        })(),
      ],
      [
        'titled and untitled sharing a directory',
        [
          untitled('/home/dev/api', '/tmp/a.sock'),
          peer('api', '/tmp/b.sock', { cwd: '/home/dev/api' }),
        ],
      ],
      [
        'colliding handles',
        [
          { ...peer('twin', '/tmp/a.sock'), handle: 'aa' },
          { ...peer('twin', '/tmp/b.sock'), handle: 'aa' },
        ],
      ],
    ];

    for (const [name, peers] of listings) {
      it(`labels are unique and resolve back: ${name}`, () => {
        const labels = assignPeerLabels(peers);
        const rendered = peers.map((entry) => labels.get(entry) as string);

        expect(new Set(rendered).size).toBe(peers.length);

        for (const entry of peers) {
          const match = resolvePeerRecipient(peers, labels.get(entry) as string);
          expect(match && 'peer' in match && match.peer).toBe(entry);
        }
      });

      it(`every row's own suffix reaches it: ${name}`, () => {
        const labels = assignPeerLabels(peers);

        for (const entry of peers) {
          const sharesHandle =
            peers.filter((other) => other.handle === entry.handle).length > 1;
          const match = resolvePeerRecipient(peers, `-${entry.handle}`);

          if (sharesHandle) {
            // Fails closed rather than guessing; the row's label still works.
            expect(match).toMatchObject({ ambiguous: true });
            expect(labels.get(entry)).toBeDefined();
            continue;
          }
          expect(match && 'peer' in match && match.peer).toBe(entry);
        }
      });
    }
  });
});
