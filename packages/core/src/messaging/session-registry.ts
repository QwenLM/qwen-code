/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live-session registry.
 *
 * Each gated session publishes `~/.qwen/sessions/<pid>.json` describing itself
 * and, crucially, the socket path peers should connect to. The registry is only
 * a directory: it is never trusted, is re-validated field by field on read, and
 * liveness always comes from probing the socket rather than from the file.
 */

import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import { runLogger } from '../utils/runLogger.js';
import {
  UDS_ADDRESS_PREFIX,
  isLocalIpcPath,
  parsePeerAddress,
} from './peer-address.js';

/** Wire version of the registry entry, bumped on incompatible field changes. */
export const PEER_PROTOCOL_VERSION = 1;

/** Registry files larger than this are treated as corrupt. */
const MAX_REGISTRY_FILE_BYTES = 256 * 1024;

/** Hard timeout for one socket liveness probe. */
const PROBE_TIMEOUT_MS = 250;

/** Sanity bound on timestamps read from disk. */
const MAX_SANE_EPOCH_MS = 4e15;

export type SessionKind = 'interactive' | 'bg' | 'daemon' | 'daemon-worker';
export type SessionStatus = 'busy' | 'shell' | 'idle' | 'waiting';

const SESSION_KINDS: readonly string[] = [
  'interactive',
  'bg',
  'daemon',
  'daemon-worker',
];
const SESSION_STATUSES: readonly string[] = [
  'busy',
  'shell',
  'idle',
  'waiting',
];

export interface SessionRegistryEntry {
  pid: number;
  procStart: number;
  startedAt: number;
  cwd: string;
  sessionId?: string;
  name?: string;
  kind?: SessionKind;
  status?: SessionStatus;
  /** Empty when this session has no cross-session socket. */
  messagingSocketPath: string;
  peerProtocol: number;
}

/** A sanitized registry row plus the file it came from. */
export interface SessionRegistryRow extends SessionRegistryEntry {
  file: string;
}

/** A peer that answered a liveness probe. */
export type LivePeerSession = Omit<SessionRegistryRow, 'file'>;

/** Trailing window over which rapid refreshes collapse into one write. */
const REFRESH_COALESCE_MS = 250;

/** Longest a pending refresh may wait before it is forced through. */
const REFRESH_MAX_WAIT_MS = 2_000;

/** Epoch ms at which this process started; guards against pid reuse. */
export function getProcessStartMs(): number {
  return Date.now() - Math.round(process.uptime() * 1000);
}

/** Whether a pid names a live process owned by someone we can signal. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export function getSessionRegistryDir(): string {
  return path.join(Storage.getGlobalConfigDir(), 'sessions');
}

export function getSessionRegistryPath(pid: number = process.pid): string {
  return path.join(getSessionRegistryDir(), `${pid}.json`);
}

/** The entry this process last published, or undefined when nothing is live. */
let publishedEntry: SessionRegistryEntry | undefined;

/** Tail of the write queue; see {@link enqueueWrite}. */
let writeChain: Promise<unknown> = Promise.resolve();

/** Mutable fields changed since the last write, awaiting the coalesce window. */
let pendingPatch: Partial<SessionRegistryEntry> | undefined;
let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
let pendingSince = 0;

/** Refresh writes that failed, reported in aggregate at teardown. */
let refreshFailures = 0;

/**
 * Fields fixed for the life of the entry.
 *
 * `startedAt` feeds the peer listing's age column and `procStart` is the
 * pid-reuse guard, so recomputing either on refresh would corrupt a fact rather
 * than update it.
 */
type MutableEntryFields = Omit<
  SessionRegistryEntry,
  'pid' | 'procStart' | 'startedAt'
>;

/**
 * Queues work behind every earlier registry write.
 *
 * The temp path is derived from the pid alone, so two concurrent writes from
 * this process would truncate each other's file and race their renames. Ordering
 * matters as much as atomicity: refreshes are fire-and-forget, and an unordered
 * queue could publish a stale patch over a fresh one.
 */
function enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
  const next = writeChain.then(work, work);
  writeChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function writeEntryToDisk(entry: SessionRegistryEntry): Promise<boolean> {
  const file = getSessionRegistryPath(entry.pid);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await fs.mkdir(getSessionRegistryDir(), { recursive: true, mode: 0o700 });
    await fs.writeFile(temp, JSON.stringify(entry), { mode: 0o600 });
    await fs.rename(temp, file);
    return true;
  } catch (error) {
    runLogger.debug(`[session-registry] Failed to write ${file}: ${error}`);
    await fs.unlink(temp).catch(() => {});
    return false;
  }
}

/**
 * Publishes (or replaces) this process's registry entry.
 *
 * Writes through a temp file so a concurrent reader never sees a partial JSON
 * document, and through {@link enqueueWrite} so a concurrent *writer* cannot
 * corrupt one. Failures are logged and swallowed: an unpublished session is
 * invisible to peers, which is degraded but not broken.
 *
 * The entry is only remembered as published once the write succeeds, so a bind
 * that failed leaves {@link refreshSessionRegistryEntry} inert.
 */
export async function writeSessionRegistryEntry(
  entry: SessionRegistryEntry,
): Promise<boolean> {
  const ok = await enqueueWrite(() => writeEntryToDisk(entry));
  if (ok) publishedEntry = entry;
  return ok;
}

/**
 * Applies a patch, re-asserting the fields that must not move.
 *
 * The parameter type already forbids them, but this is the only place the
 * invariant is enforceable at runtime, and a caller reaching it through a cast
 * would otherwise corrupt a peer's age column or the pid-reuse guard rather
 * than merely publishing something stale.
 */
function mergePatch(
  base: SessionRegistryEntry,
  patch: Partial<SessionRegistryEntry>,
): SessionRegistryEntry {
  return {
    ...base,
    ...patch,
    pid: base.pid,
    procStart: base.procStart,
    startedAt: base.startedAt,
  };
}

function cancelPendingRefresh(): void {
  if (coalesceTimer) clearTimeout(coalesceTimer);
  coalesceTimer = undefined;
  pendingPatch = undefined;
  pendingSince = 0;
}

function flushRefresh(): void {
  const patch = pendingPatch;
  cancelPendingRefresh();
  if (!patch || !publishedEntry) return;

  const merged = mergePatch(publishedEntry, patch);
  void enqueueWrite(async () => {
    // Teardown may have run while this sat in the queue. Writing now would
    // resurrect a registry file for a session whose socket is already closed.
    if (!publishedEntry) return;
    if (await writeEntryToDisk(merged)) {
      publishedEntry = merged;
    } else {
      refreshFailures++;
    }
  });
}

/**
 * Schedules the pending patch.
 *
 * A plain trailing debounce starves: while changes keep arriving inside the
 * window the write never happens, which is precisely the busy turn a peer most
 * wants to observe. Clamping the delay against {@link REFRESH_MAX_WAIT_MS}
 * bounds how long a pending change can be held back.
 */
function scheduleRefresh(): void {
  const now = Date.now();
  if (pendingSince === 0) pendingSince = now;
  if (coalesceTimer) clearTimeout(coalesceTimer);

  const remaining = REFRESH_MAX_WAIT_MS - (now - pendingSince);
  coalesceTimer = setTimeout(
    flushRefresh,
    Math.max(0, Math.min(REFRESH_COALESCE_MS, remaining)),
  );
  // A pending refresh must never be the reason the process stays alive.
  coalesceTimer.unref?.();
}

/**
 * Updates this session's published entry in place.
 *
 * Fire-and-forget: callers are event listeners and React effects, neither of
 * which can await. A no-op until something has been published, so a gated-off
 * session or a failed bind never touches the filesystem.
 */
export function refreshSessionRegistryEntry(
  patch: Partial<MutableEntryFields>,
): void {
  if (!publishedEntry) return;

  const combined = { ...pendingPatch, ...patch };
  const merged = mergePatch(publishedEntry, combined);
  if (JSON.stringify(merged) === JSON.stringify(publishedEntry)) {
    // Nothing left to say — including when a queued change has since been
    // reverted, in which case the scheduled write is dropped rather than run.
    cancelPendingRefresh();
    return;
  }

  pendingPatch = combined;
  scheduleRefresh();
}

/** Refresh writes that failed since startup. */
export function getSessionRegistryRefreshFailures(): number {
  return refreshFailures;
}

/**
 * Removes a registry entry. Safe to call when none exists.
 *
 * Cancels any pending refresh and forgets the published entry before the unlink
 * is queued, so neither a scheduled nor an already-queued write can re-create
 * the file behind it.
 */
export async function removeSessionRegistryEntry(
  pid: number = process.pid,
): Promise<void> {
  if (publishedEntry?.pid === pid) {
    cancelPendingRefresh();
    publishedEntry = undefined;
  }
  await enqueueWrite(() =>
    fs.unlink(getSessionRegistryPath(pid)).catch(() => {}),
  );
}

/** @internal Test helper — clears publish state, pending work and counters. */
export function _resetSessionRegistryStateForTest(): void {
  cancelPendingRefresh();
  publishedEntry = undefined;
  writeChain = Promise.resolve();
  refreshFailures = 0;
  knownPeerSnapshot = undefined;
  knownPeerRefresh = undefined;
}

function saneEpochMs(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_SANE_EPOCH_MS
    ? value
    : undefined;
}

function parseKind(value: unknown): SessionKind | undefined {
  return typeof value === 'string' && SESSION_KINDS.includes(value)
    ? (value as SessionKind)
    : undefined;
}

function parseStatus(value: unknown): SessionStatus | undefined {
  return typeof value === 'string' && SESSION_STATUSES.includes(value)
    ? (value as SessionStatus)
    : undefined;
}

function parseFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function parseString(value: unknown, maxLength = 512): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, maxLength)
    : undefined;
}

async function readRegistryFile(
  file: string,
  pid: number,
): Promise<SessionRegistryRow | null> {
  let raw: string;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_REGISTRY_FILE_BYTES) return null;
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }

  const socketPath = parseString(parsed['messagingSocketPath']) ?? '';
  return {
    pid,
    file,
    procStart: saneEpochMs(parsed['procStart']) ?? 0,
    startedAt: saneEpochMs(parsed['startedAt']) ?? 0,
    cwd: parseString(parsed['cwd']) ?? '?',
    ...(parseString(parsed['sessionId'], 120) !== undefined && {
      sessionId: parseString(parsed['sessionId'], 120),
    }),
    ...(parseString(parsed['name'], 120) !== undefined && {
      name: parseString(parsed['name'], 120),
    }),
    ...(parseKind(parsed['kind']) !== undefined && {
      kind: parseKind(parsed['kind']),
    }),
    ...(parseStatus(parsed['status']) !== undefined && {
      status: parseStatus(parsed['status']),
    }),
    messagingSocketPath: isLocalIpcPath(socketPath) ? socketPath : '',
    peerProtocol: parseFiniteNumber(parsed['peerProtocol']) ?? 0,
  };
}

/**
 * Reads every well-formed registry entry.
 *
 * Files whose name is not exactly `<pid>.json` are deleted rather than parsed:
 * a name like `007.json` cannot have been written by us, and leaving it in place
 * would keep the directory growing.
 */
export async function readSessionRegistry(): Promise<SessionRegistryRow[]> {
  const dir = getSessionRegistryDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }

  const rows = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        const file = path.join(dir, name);
        const stem = name.slice(0, -'.json'.length);
        const pid = Number.parseInt(stem, 10);
        if (!Number.isInteger(pid) || pid <= 0 || String(pid) !== stem) {
          await fs.unlink(file).catch(() => {});
          return null;
        }
        return readRegistryFile(file, pid);
      }),
  );

  return rows.filter((row): row is SessionRegistryRow => row !== null);
}

/** How long one registry snapshot may answer known-peer questions. */
const KNOWN_PEER_TTL_MS = 1_000;

/**
 * How old a snapshot must be before a miss is allowed to re-read it.
 *
 * A miss holds the message for review, so a peer that registered just after
 * our last snapshot deserves a second look — but a flood of forged addresses
 * must not turn into a `readdir` per message. This caps it at four a second.
 */
const KNOWN_PEER_MISS_REFRESH_MS = 250;

let knownPeerSnapshot: { at: number; paths: Set<string> } | undefined;

/**
 * The registry read currently in flight, shared by every caller that needs one.
 *
 * Without it, a burst arriving inside one event-loop turn starts one `readdir`
 * per message before any of them has updated the snapshot.
 */
let knownPeerRefresh: Promise<Set<string> | undefined> | undefined;

function refreshKnownPeers(): Promise<Set<string> | undefined> {
  if (knownPeerRefresh) return knownPeerRefresh;
  const refresh = (async () => {
    const at = Date.now();
    try {
      const rows = await readSessionRegistry();
      const paths = new Set(rows.map((row) => row.messagingSocketPath));
      knownPeerSnapshot = { at, paths };
      return paths;
    } catch {
      // Fail closed, and without caching: a directory we could not read this
      // once should not go on answering for the rest of the window.
      return undefined;
    }
  })().finally(() => {
    if (knownPeerRefresh === refresh) knownPeerRefresh = undefined;
  });
  knownPeerRefresh = refresh;
  return refresh;
}

/**
 * Whether a claimed reply address names a session in the local registry.
 *
 * The weakest useful check, and offered as exactly that. We have no
 * kernel-verified sender identity (no `SO_PEERCRED` binding in Node), so this
 * only distinguishes "a peer this machine has a record of" from "a string
 * someone supplied" — and a registry entry is itself written by an ordinary
 * process of this user, so it is evidence about mistakes, not about adversaries.
 *
 * Answered from a snapshot with a bounded lifetime. Every inbound message asks
 * this question, including one that is about to be refused, so a `readdir` per
 * message would let a peer whose traffic we reject amplify into filesystem load.
 * A miss may re-read once the snapshot is {@link KNOWN_PEER_MISS_REFRESH_MS} old,
 * because the inbound gate holds an unregistered sender for review.
 */
export async function isKnownPeerAddress(address: string): Promise<boolean> {
  if (!address.startsWith(UDS_ADDRESS_PREFIX)) return false;
  const target = parsePeerAddress(address).target;
  if (!target) return false;

  const snapshot = knownPeerSnapshot;
  const age = snapshot === undefined ? Infinity : Date.now() - snapshot.at;
  if (snapshot !== undefined && age <= KNOWN_PEER_TTL_MS) {
    if (snapshot.paths.has(target)) return true;
    if (age < KNOWN_PEER_MISS_REFRESH_MS) return false;
  }

  const paths = await refreshKnownPeers();
  return paths?.has(target) ?? false;
}

/**
 * Connects to a socket to decide whether anyone is listening.
 *
 * `EBUSY` counts as alive: the peer is listening but its accept backlog is full,
 * which is a transient busy signal rather than a dead session.
 */
export function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!isLocalIpcPath(socketPath)) {
      resolve(false);
      return;
    }
    const socket = net.connect({ path: socketPath });
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.on('connect', () => finish(true));
    socket.on('error', (error) =>
      finish((error as NodeJS.ErrnoException)?.code === 'EBUSY'),
    );
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
  });
}

/**
 * Enumerates reachable peers, excluding this session, and collects the registry
 * files of sessions that are both unreachable and dead.
 *
 * Self-exclusion is by pid alone, and deliberately takes no socket path. A
 * session only has a registry row once it has bound, and that row carries this
 * pid; a process that never bound has no row to exclude. Passing a path
 * additionally excluded whichever session that path belonged to — which, for a
 * child holding an inherited `ENV_MESSAGING_SOCKET`, was its own parent.
 */
export async function listLivePeerSessions(): Promise<LivePeerSession[]> {
  const rows = (await readSessionRegistry()).filter(
    (row) => row.messagingSocketPath !== '' && row.pid !== process.pid,
  );

  const alive = await Promise.all(
    rows.map((row) => probeSocket(row.messagingSocketPath)),
  );

  const live: LivePeerSession[] = [];
  for (const [index, row] of rows.entries()) {
    const { file, ...session } = row;
    if (alive[index]) {
      live.push(session);
      continue;
    }
    // Only reap once the pid is gone too: an unreachable-but-live process may
    // simply be mid-restart of its listener.
    if (!isProcessAlive(row.pid)) {
      await fs.unlink(file).catch(() => {});
    }
  }
  return live;
}
