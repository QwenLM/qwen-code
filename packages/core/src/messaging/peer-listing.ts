/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Peer enumeration and rendering.
 *
 * The listing the model sees is also the address book it sends to: whatever
 * label appears in a row is a valid `to` for `SendMessage`. Every session also
 * answers to its *handle* — two hex characters derived from the socket it
 * listens on, carried in the name of any session that has not titled itself.
 * A name changes as a session's work changes; a handle does not.
 */

import * as path from 'node:path';
import { BRAND_NAME } from '../config/brand.js';
import { isCrossSessionMessagingEnabled } from './cross-session-feature.js';
import {
  listLivePeerSessions,
  type LivePeerSession,
} from './session-registry.js';
import { boundMessagingSocket } from './uds-server.js';
import {
  HANDLE_LENGTH,
  UDS_ADDRESS_PREFIX,
  isLocalIpcPath,
  isValidPeerAddress,
  parsePeerAddress,
  peerHandle,
  peerHandleFromAddress,
  shortRef,
  toUdsAddress,
} from './peer-address.js';
import { labelCarriesHandle } from './peer-message-preview.js';

// Derived from an address rather than from a listing, so they live in
// `peer-address.ts`; re-exported here because this is where a peer's identity
// is assembled and where callers have always found them.
export { peerHandle, peerHandleFromAddress, shortRef };

export interface PeerEntry {
  transport: 'uds';
  address: string;
  session: LivePeerSession;
  /** The name before any disambiguation: the session's title, or its cwd. */
  baseName: string;
  displayName: string;
  handle: string;
  ref: string;
}

/**
 * The socket a recipient string addresses, or undefined when it is not an
 * address at all.
 *
 * Only the `uds:` form counts. {@link parsePeerAddress} also reads a bare
 * absolute path as one, but a session is free to be *named* something starting
 * with `/`, and treating that as an address would take it out of the naming
 * ladder for good.
 */
function addressedSocketPath(recipient: string): string | undefined {
  if (!recipient.startsWith(UDS_ADDRESS_PREFIX)) return undefined;
  if (!isValidPeerAddress(recipient)) return undefined;
  const parsed = parsePeerAddress(recipient);
  // The same bar the send path holds a socket to. The address charset permits
  // `:` and `/`, so `uds:http://host/x.sock` decodes to a target that is
  // well-formed as a string and is not a socket we could ever have published.
  return parsed.scheme === 'uds' && isLocalIpcPath(parsed.target)
    ? parsed.target
    : undefined;
}

/** The parts of a session this naming rule reads. */
export interface NameableSession {
  name?: string;
  cwd?: string;
  /** Socket the session listens on; absent when it never bound one. */
  messagingSocketPath?: string;
}

/**
 * A session's name before any disambiguation.
 *
 * Read from the record rather than recovered from a rendering: a session titled
 * `Fix login bug-9c` would otherwise acquire a base name it never had, and any
 * later change to the rendering would silently change what resolves.
 */
export function baseNameForSession(session: NameableSession): string {
  const name = session.name?.trim();
  if (name) return name;
  const base =
    session.cwd && session.cwd !== '?' ? path.basename(session.cwd) : '';
  return base || '(untitled)';
}

/**
 * Human-facing name for a session.
 *
 * A titled session is called what it called itself. An untitled one is named
 * after its working directory — which every session in that directory would
 * share — so it carries its handle: `qwen-4-46`. A session that never bound
 * a socket has no handle, and is named by its base alone.
 *
 * Deliberately structural rather than typed to {@link LivePeerSession}: a
 * session describes *itself* with this function too, so both ends of the wire
 * agree on what a session is called by construction rather than by two copies
 * of one rule.
 */
export function displayNameForSession(session: NameableSession): string {
  const base = baseNameForSession(session);
  if (session.name?.trim()) return base;
  const socketPath = session.messagingSocketPath;
  return socketPath ? `${base}-${peerHandle(socketPath)}` : base;
}

/** Enumerates reachable peers. Returns empty when the feature is disabled. */
export async function listAllPeers(): Promise<PeerEntry[]> {
  if (!isCrossSessionMessagingEnabled()) return [];
  const sessions = await listLivePeerSessions();
  return sessions.map((session) => ({
    transport: 'uds' as const,
    address: toUdsAddress(session.messagingSocketPath),
    session,
    baseName: baseNameForSession(session),
    displayName: displayNameForSession(session),
    handle: peerHandle(session.messagingSocketPath),
    ref: shortRef('session', session.messagingSocketPath),
  }));
}

/** How this session identifies itself to its peers. */
export interface OwnPeerIdentity {
  /** Reply handle for the socket this process listens on. */
  address: string;
  /** The socket itself, for naming this session the way peers name it. */
  socketPath: string;
  /** The two-character address peers can reach this session by. */
  handle: string;
  /** The ref a peer computes for this session; survives renames. */
  ref: string;
}

/**
 * This session's own address, handle and ref, or undefined when it never bound.
 *
 * Derived from {@link boundMessagingSocket} rather than the inheritable
 * environment variable, so a child that failed to bind reports nothing instead
 * of reporting its parent. Both derivations are the same calls
 * {@link listAllPeers} makes directly above, which is what makes a session's
 * self-reported identity and the identity its peers compute for it the same
 * strings by construction rather than by two copies of one rule.
 */
export function boundPeerIdentity(): OwnPeerIdentity | undefined {
  const socket = boundMessagingSocket();
  if (!socket) return undefined;
  return {
    address: toUdsAddress(socket),
    socketPath: socket,
    handle: peerHandle(socket),
    ref: shortRef('session', socket),
  };
}

/**
 * A peer's age as a recency fact, e.g. `3m ago`.
 *
 * Exported so the `@`-mention completion states recency by the same rule the
 * `ListAgents` listing does, rather than growing a second vocabulary for the
 * same fact.
 */
export function humanizeAge(startedAt: number, now: number): string {
  if (!startedAt) return 'unknown age';
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The rungs one peer can be labelled at, shortest first.
 *
 * One vocabulary at every level: the same `-suffix` an untitled name already
 * carries, lengthened from the handle to the ref. A titled session sits at rung
 * 0 until something collides with it; an untitled one's rung 0 and rung 1 are
 * the same string, so it simply stays where it is.
 */
function labelRungs(peer: PeerEntry): string[] {
  return [
    peer.displayName,
    `${peer.baseName}-${peer.handle}`,
    `${peer.baseName}-${peer.ref}`,
  ];
}

/**
 * Labels for a whole listing, escalating only as far as collisions force.
 *
 * Assigned across the listing because which rung a peer needs depends on who
 * else is present. **Escalation changes what is rendered, never what resolves**:
 * a row shown as `Fix login bug-46f3a1` still answers to `-46`, and to `Fix
 * login bug` once no other row claims that name. That is what keeps an address
 * captured from an earlier listing usable, and it is why the handle itself is
 * never lengthened — a session's identity must not depend on which other
 * sessions happen to exist.
 */
export function assignPeerLabels(
  peers: readonly PeerEntry[],
): Map<PeerEntry, string> {
  const rungs = peers.map(labelRungs);
  const labels = new Map<PeerEntry, string>();
  const taken = new Set<string>();

  for (let rung = 0; rung < rungs[0]?.length; rung++) {
    const claims = new Map<string, number>();
    peers.forEach((peer, index) => {
      if (labels.has(peer)) return;
      const candidate = rungs[index][rung];
      claims.set(candidate, (claims.get(candidate) ?? 0) + 1);
    });
    peers.forEach((peer, index) => {
      if (labels.has(peer)) return;
      const candidate = rungs[index][rung];
      if (claims.get(candidate) !== 1 || taken.has(candidate)) return;
      labels.set(peer, candidate);
      taken.add(candidate);
    });
  }

  // Exhausting the ladder means two peers share a base name *and* a ref, which
  // is a hash collision on distinct socket paths. They render alike, and
  // `resolvePeerRecipient` reports them ambiguous rather than guessing.
  peers.forEach((peer, index) => {
    if (!labels.has(peer)) labels.set(peer, rungs[index][2]);
  });
  return labels;
}

/** Label the model should copy into `SendMessage`. */
export function addressLabel(
  peers: readonly PeerEntry[],
  peer: PeerEntry,
): string {
  return assignPeerLabels(peers).get(peer) ?? peer.displayName;
}

/**
 * The `handle -46` fact for a row, or undefined when its label already says it.
 *
 * Stating one identity twice on a row is what the old `— ref [x]` column did
 * once names could differ; this is the same suppression, against the ladder.
 */
export function handleFact(label: string, peer: PeerEntry): string | undefined {
  const carried =
    labelCarriesHandle(label, peer.handle) ||
    labelCarriesHandle(label, peer.ref);
  return carried ? undefined : `handle -${peer.handle}`;
}

export interface AgentListingExtras {
  /** Names of in-process agents reachable by plain `SendMessage`. */
  localAgents: string[];
}

/** Renders the tool result for `ListAgents`. */
export function formatPeersForModel(
  peers: readonly PeerEntry[],
  extras: AgentListingExtras,
  now: number = Date.now(),
): string {
  const lines: string[] = [];

  if (extras.localAgents.length > 0) {
    lines.push('Agents in this session (address by name):');
    for (const name of extras.localAgents) lines.push(`- ${name}`);
    lines.push('');
  }

  if (peers.length === 0) {
    lines.push('Peer sessions: none reachable right now.');
    return lines.join('\n').trim();
  }

  lines.push(
    `Peer sessions (other ${BRAND_NAME} sessions on this machine):`,
  );
  const labels = assignPeerLabels(peers);
  for (const peer of peers) {
    const label = labels.get(peer) ?? peer.displayName;
    const handle = handleFact(label, peer);
    const facts = [
      peer.session.kind ?? 'interactive',
      peer.session.status ?? 'unknown',
      `started ${humanizeAge(peer.session.startedAt, now)}`,
      `cwd ${peer.session.cwd}`,
      ...(handle ? [handle] : []),
    ].join(', ');
    lines.push(`- ${label} — ${facts}`);
  }

  // A session renames itself as its work changes, so a name captured now may
  // not resolve later. The handle derives from the socket path and outlives
  // every rename, which makes it the address worth keeping hold of.
  lines.push('');
  lines.push(
    `Address a peer by the label in its row, or by its handle alone (for ` +
      `example "-${peers[0].handle}"). A name changes as a session's work ` +
      `changes; its handle does not, for as long as that session is running.`,
  );
  return lines.join('\n');
}

export interface PeerMatch {
  peer: PeerEntry;
}

/** A well-formed peer address that no live session answers at. */
export interface StalePeerAddress {
  staleAddress: true;
  address: string;
}

export type PeerRecipientResolution =
  | PeerMatch
  | {
      ambiguous: true;
      displayName: string;
      count: number;
      /**
       * Every peer the winning tier matched.
       *
       * Carried rather than left to the caller to re-derive, because
       * `displayName` alone cannot recover them: it names `candidates[0]`, and
       * a tier that matches on something *other* than the display name — the
       * bare base name, most commonly two untitled sessions in one directory —
       * matches peers whose display names all differ. Filtering the listing by
       * this one name then returns a single peer for a two-peer ambiguity, and
       * reports it under a label that would have resolved perfectly well.
       */
      candidates: readonly PeerEntry[];
    }
  | StalePeerAddress;

/**
 * Resolves a `to` value against the peer listing.
 *
 * An address is handled ahead of everything else, then names are tried in tiers,
 * most authoritative first, stopping at the first tier any peer answers. Only
 * the first name tier consults the rendered listing; the rest are functions of
 * the peer alone, which is what keeps escalation additive — a form that
 * identified a peer before an escalation still identifies it after.
 *
 * A tier matching several peers is reported rather than guessed at, so a
 * message never silently goes to the wrong session.
 */
export interface ResolvePeerOptions {
  /**
   * Whether a bare base name — the last tier — may match.
   *
   * Defaults to true, which is what `SendMessage` wants: that tier exists for a
   * *model* holding a name from a listing taken a while ago, and dropping it
   * would break an address that used to work.
   *
   * A caller resolving text a human typed should pass false. An untitled
   * session's base name is its working directory's basename, so `api`, `docs`,
   * `web` and `core` are all live recipients — and all ordinary English words.
   * "look at the @core module" would otherwise resolve to a session, and the
   * file pipeline cannot intercept it first, because the file mention regex
   * deliberately excludes bare dotless segments.
   */
  allowBareBaseName?: boolean;
}

export function resolvePeerRecipient(
  peers: readonly PeerEntry[],
  recipient: string,
  options: ResolvePeerOptions = {},
): PeerRecipientResolution | undefined {
  const { allowBareBaseName = true } = options;
  const trimmed = recipient.trim();

  // The reply handle the envelope hands the model, which the SendMessage
  // description tells it to copy back verbatim. Resolved ahead of the ladder
  // rather than as a rung of it: an address names one socket, so it can never be
  // ambiguous, and it cannot match a name tier either — letting it fall through
  // produced "unknown name" for the one form a caller cannot have gotten wrong.
  //
  // Matched on the socket path rather than through peerHandleFromAddress: the
  // address carries the exact path, and narrowing it to two hex characters would
  // discard that and reintroduce collisions the ladder would have to report as
  // ambiguous.
  const addressed = addressedSocketPath(trimmed);
  if (addressed !== undefined) {
    const match = peers.find(
      (peer) => peer.session.messagingSocketPath === addressed,
    );
    return match ? { peer: match } : { staleAddress: true, address: trimmed };
  }

  const bracketed = trimmed.match(/^(.*?)\s*\[([0-9a-f]{6})\]$/);
  const bareHandle = trimmed.match(
    new RegExp(`^-([0-9a-f]{${HANDLE_LENGTH}})$`),
  );

  const labels = assignPeerLabels(peers);

  const tiers: Array<readonly PeerEntry[]> = [
    // The string the listing actually showed. First because it is the one form
    // a caller cannot have gotten wrong, and because escalation can otherwise
    // leave a rendered label ambiguous: a peer titled `api-46` and an untitled
    // one whose suffixed name spells `api-46` share a display name, and only
    // the assignment says which of them the row labelled `api-46` was.
    peers.filter((peer) => labels.get(peer) === trimmed),
    // Explicit and long: the ladder's last rung, and the bracket forms an
    // earlier build published. Refs are a truncated hash, so these can still
    // collide — which the ambiguity report below covers.
    peers.filter((peer) =>
      bracketed
        ? peer.ref === bracketed[2] &&
          (bracketed[1] === '' || peer.displayName === bracketed[1])
        : trimmed === `${peer.baseName}-${peer.ref}`,
    ),
    peers.filter((peer) => peer.displayName === trimmed),
    peers.filter((peer) =>
      bareHandle
        ? peer.handle === bareHandle[1]
        : trimmed === `${peer.baseName}-${peer.handle}`,
    ),
    // Last: the name without its suffix, which a model that listed peers a
    // while ago may be holding. Unique matches only, and skipped entirely for
    // a caller that is resolving typed prose rather than a remembered address.
    allowBareBaseName
      ? peers.filter((peer) => peer.baseName === trimmed)
      : [],
  ];

  for (const matches of tiers) {
    if (matches.length === 0) continue;
    if (matches.length > 1) {
      return {
        ambiguous: true,
        displayName: matches[0].displayName,
        count: matches.length,
        candidates: matches,
      };
    }
    return { peer: matches[0] };
  }
  return undefined;
}
