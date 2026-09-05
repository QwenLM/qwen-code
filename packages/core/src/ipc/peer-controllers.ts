/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Controller grants: the tokens a user mints so a process outside any
 * session may drive their sessions.
 *
 * The inbound gate delivers a message without review only between two
 * sessions in the same review class, and holds anything from a sender
 * that asserts no class at all. That is right for peers — `fromMode` is
 * a self-description and the registry record is written by the process
 * it describes — but it makes the one case a user actually wants
 * unusable: a voice front-end, a dictation bridge, an automation daemon
 * relaying the user's own words has no class to assert, so every message
 * it sends parks for per-message review.
 *
 * What makes this honest is *where the grant comes from*. Any process
 * running as this user can read a session's 0600 registry record and
 * write whatever it likes into a frame, so a claim to be a controller —
 * in the frame, in the record, in a settings key naming a program — is
 * worth nothing. A grant here is a secret the user minted by hand and
 * handed to one program, presented on the connection's auth line, and
 * classified by the transport exactly like the child token in #10764:
 * a fact about the connection that no frame can set.
 *
 * ## Why only the hash is stored
 *
 * The obvious shape is a 0600 file holding the token, the way the
 * session registry holds inbox tokens. It does not hold here. A session
 * *is* a program that reads files on request: a model in any session on
 * this machine can be talked into `cat`-ing a 0600 file in the user's
 * home and printing what it finds, and a controller token in plaintext
 * is then a credential that turns every held message into a delivered
 * one. So the file keeps `sha256(token)` and the plaintext is printed
 * once, at mint time, for the user to paste into the controller's own
 * configuration. Reading this file gets an attacker a hash it cannot
 * present.
 *
 * (The inbox token in the registry record has no such problem to solve:
 * it grants only what reaching the socket already grants — the ability
 * to send a message that the gate still judges.)
 *
 * ## Scope and revocation
 *
 * A grant belongs to the Qwen home, not to one session: a controller the
 * user trusts to relay their instructions is trusted by whichever
 * sessions they are running, and per-session enrolment would mean
 * re-granting on every restart. Sessions read this file on every auth
 * line rather than caching it, so `add` and `remove` both take effect on
 * the next connection with nothing to restart.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import { atomicWriteJSON } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { isNodeError } from '../utils/errors.js';
import { flattenPeerLabel } from './peer-envelope.js';

const debugLogger = createDebugLogger('PEER_CONTROLLERS');

export const PEER_CONTROLLER_SCHEMA_VERSION = 1;

/**
 * Marks a minted token as what it is.
 *
 * Secret scanners and a user staring at a config file both benefit from
 * a credential that announces its own kind, and the receiving side gets
 * a free pre-filter: a presented token without this prefix cannot be a
 * controller token, so it is rejected before anything is hashed or read
 * from disk.
 */
export const CONTROLLER_TOKEN_PREFIX = 'qpc_';

/** Bytes of entropy behind a minted token. */
const CONTROLLER_TOKEN_BYTES = 32;

/**
 * Longest presented string that is worth hashing.
 *
 * A minted token is `qpc_` plus 64 hex characters. The auth line is
 * bounded only by the 1 MiB frame cap, so without a ceiling a peer could
 * make this session hash a megabyte per connection.
 */
const MAX_PRESENTED_TOKEN_CHARS = 256;

/** Longest label a controller may be given. */
export const MAX_CONTROLLER_LABEL_CHARS = 40;

/**
 * Most grants one Qwen home may hold.
 *
 * Not a security property — a user with 32 controllers has bigger
 * problems than the 33rd — but a list a person is expected to review
 * and revoke from has to stay reviewable.
 */
export const MAX_CONTROLLERS = 32;

/** Refuse to parse anything larger; the whole file is a few kilobytes. */
const MAX_REGISTRY_BYTES = 64 * 1024;

const REGISTRY_FILE_MODE = 0o600;

const CONTROLLER_ID_RE = /^c_[0-9a-f]{8}$/;
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;

/** One grant, as recorded on disk. */
export interface PeerControllerRecord {
  /** Stable handle the user types to revoke it. */
  id: string;
  /** What the user called it, shown wherever a controller is named. */
  label: string;
  /** `sha256` of the minted token, hex. The token itself is never stored. */
  tokenHash: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

export interface PeerControllerRegistry {
  schemaVersion: number;
  controllers: PeerControllerRecord[];
}

/**
 * What a matched grant tells the rest of the system.
 *
 * Deliberately not the record: the hash has no business travelling with
 * a message into an envelope, a transcript line or a held-message list.
 */
export interface PeerControllerIdentity {
  id: string;
  label: string;
}

export type PeerControllerErrorCode =
  | 'invalid-label'
  | 'duplicate-label'
  | 'too-many'
  | 'unsafe-path';

export class PeerControllerError extends Error {
  constructor(
    message: string,
    readonly code: PeerControllerErrorCode,
  ) {
    super(message);
    this.name = 'PeerControllerError';
  }
}

/** Where grants live: one file per Qwen home, beside the session registry. */
export function getPeerControllerRegistryPath(): string {
  return path.join(Storage.getGlobalQwenDir(), 'peer-controllers.json');
}

export function hashControllerToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function mintControllerToken(): string {
  return (
    CONTROLLER_TOKEN_PREFIX +
    randomBytes(CONTROLLER_TOKEN_BYTES).toString('hex')
  );
}

function emptyRegistry(): PeerControllerRegistry {
  return { schemaVersion: PEER_CONTROLLER_SCHEMA_VERSION, controllers: [] };
}

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Keep a record only if every field is the shape this code writes.
 *
 * A malformed entry is skipped rather than failing the whole file: the
 * cost of one unusable grant is that its controller has to be re-added,
 * while discarding the file would silently revoke the others.
 */
function toValidRecord(value: unknown): PeerControllerRecord | null {
  if (!isRecord(value)) return null;
  const { id, label, tokenHash, createdAt } = value;
  if (typeof id !== 'string' || !CONTROLLER_ID_RE.test(id)) return null;
  // Hashes are compared with `timingSafeEqual`, which throws on a length
  // mismatch, so the shape is enforced here rather than at the comparison.
  if (typeof tokenHash !== 'string' || !TOKEN_HASH_RE.test(tokenHash)) {
    return null;
  }
  if (typeof label !== 'string') return null;
  const flattened = flattenPeerLabel(label);
  if (flattened.length === 0 || flattened.length > MAX_CONTROLLER_LABEL_CHARS) {
    return null;
  }
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  // Store the flattened form: this label is printed into an envelope
  // attribute and a terminal listing, and the file can be edited by hand.
  return { id, label: flattened, tokenHash, createdAt };
}

/**
 * Read the grants, synchronously, treating every problem as "no grants".
 *
 * Synchronous on purpose: the one hot caller is the inbox's auth-line
 * check, which must answer before it can decide whether to keep the
 * connection, and re-reading per connection is what makes a revocation
 * immediate. The file is small, capped, and read at most once per
 * connection — a rate already bounded by `MAX_PEER_CONNECTIONS`.
 *
 * Failing to an empty registry is the safe direction: no grant means no
 * message bypasses review.
 */
export function readPeerControllerRegistrySync(
  filePath: string = getPeerControllerRegistryPath(),
): PeerControllerRegistry {
  let raw: string;
  try {
    // lstat, not stat: a symlink here is not something this code wrote,
    // and following one would read a file chosen by whoever planted it.
    const stats = fsSync.lstatSync(filePath);
    if (!stats.isFile()) {
      debugLogger.debug(
        `ignoring the controller registry at ${filePath}: not a regular file`,
      );
      return emptyRegistry();
    }
    if (stats.size > MAX_REGISTRY_BYTES) {
      debugLogger.debug(
        `ignoring the controller registry at ${filePath}: ${stats.size} bytes exceeds the ${MAX_REGISTRY_BYTES}-byte cap`,
      );
      return emptyRegistry();
    }
    raw = fsSync.readFileSync(filePath, 'utf8');
  } catch (error) {
    // A missing file is the normal state — most users never mint a
    // controller — so it is not worth a log line.
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      debugLogger.debug(
        `could not read the controller registry at ${filePath}: ${describe(error)}`,
      );
    }
    return emptyRegistry();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    debugLogger.debug(
      `the controller registry at ${filePath} is not JSON: ${describe(error)}`,
    );
    return emptyRegistry();
  }
  if (!isRecord(parsed)) return emptyRegistry();
  if (parsed['schemaVersion'] !== PEER_CONTROLLER_SCHEMA_VERSION) {
    debugLogger.debug(
      `ignoring the controller registry at ${filePath}: unsupported schemaVersion ${String(
        parsed['schemaVersion'],
      )}`,
    );
    return emptyRegistry();
  }
  const controllers = parsed['controllers'];
  if (!Array.isArray(controllers)) return emptyRegistry();

  const valid: PeerControllerRecord[] = [];
  for (const entry of controllers) {
    const record = toValidRecord(entry);
    if (record === null) {
      debugLogger.debug(
        `skipping a malformed entry in the controller registry at ${filePath}`,
      );
      continue;
    }
    valid.push(record);
  }
  return { schemaVersion: PEER_CONTROLLER_SCHEMA_VERSION, controllers: valid };
}

/**
 * The grant a presented token belongs to, or undefined.
 *
 * Every record is compared, with no early exit on a hit, so the time
 * this takes says nothing about which grant matched — and the
 * comparison itself is constant-time, so it says nothing about how close
 * a guess was either.
 */
export function matchControllerToken(
  registry: PeerControllerRegistry,
  presented: string,
): PeerControllerIdentity | undefined {
  if (!isPresentableControllerToken(presented)) return undefined;
  const presentedHash = Buffer.from(hashControllerToken(presented), 'hex');
  let matched: PeerControllerIdentity | undefined;
  for (const record of registry.controllers) {
    const candidate = Buffer.from(record.tokenHash, 'hex');
    if (
      candidate.length === presentedHash.length &&
      timingSafeEqual(candidate, presentedHash)
    ) {
      matched = { id: record.id, label: record.label };
    }
  }
  return matched;
}

/**
 * Cheap shape test, before anything is hashed or read from disk.
 *
 * Every stored hash is of a string that starts with the prefix, so one
 * that does not cannot match any grant — and the prefix is not a secret,
 * so rejecting on it early leaks nothing a peer does not already know.
 */
function isPresentableControllerToken(presented: string): boolean {
  return (
    presented.length <= MAX_PRESENTED_TOKEN_CHARS &&
    presented.startsWith(CONTROLLER_TOKEN_PREFIX)
  );
}

/**
 * Resolve a token straight from disk — the form the inbox wires in.
 *
 * The shape test runs before the read so an ordinary peer connection,
 * which presents a token that is not a controller's, costs nothing at
 * all on a machine that has never minted one.
 */
export function resolveControllerToken(
  presented: string,
  filePath?: string,
): PeerControllerIdentity | undefined {
  if (!isPresentableControllerToken(presented)) return undefined;
  return matchControllerToken(
    readPeerControllerRegistrySync(filePath),
    presented,
  );
}

/**
 * Refuse to write through a symlink.
 *
 * The write itself passes `noFollow`, which *replaces* a symlink with a
 * regular file rather than writing through it — safe, but it would
 * silently destroy a link the user placed on purpose, and the read path
 * ignores a symlinked registry anyway. Saying so is better than either.
 */
async function assertWritablePath(filePath: string): Promise<void> {
  try {
    const stats = await fs.lstat(filePath);
    if (!stats.isFile()) {
      throw new PeerControllerError(
        `${filePath} is not a regular file; move it aside first.`,
        'unsafe-path',
      );
    }
  } catch (error) {
    if (error instanceof PeerControllerError) throw error;
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
}

async function writeRegistry(
  filePath: string,
  registry: PeerControllerRegistry,
): Promise<void> {
  await assertWritablePath(filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJSON(filePath, registry, {
    mode: REGISTRY_FILE_MODE,
    // The file holds credentials-in-effect: an over-permissive copy
    // restored from a backup must be healed, not preserved.
    forceMode: true,
    noFollow: true,
  });
}

/** Every grant this Qwen home holds, newest last. */
export async function listPeerControllers(
  filePath: string = getPeerControllerRegistryPath(),
): Promise<PeerControllerRecord[]> {
  return readPeerControllerRegistrySync(filePath).controllers;
}

/**
 * Mint a grant and return the token exactly once.
 *
 * The caller is the only place the plaintext ever exists after this
 * returns: nothing here logs it, and the file gets only its hash.
 */
export async function addPeerController(
  label: string,
  filePath: string = getPeerControllerRegistryPath(),
): Promise<{ record: PeerControllerRecord; token: string }> {
  const flattened = flattenPeerLabel(label);
  if (flattened.length === 0) {
    throw new PeerControllerError(
      'A controller needs a label: something you will recognize when you come to revoke it.',
      'invalid-label',
    );
  }
  if (flattened.length > MAX_CONTROLLER_LABEL_CHARS) {
    throw new PeerControllerError(
      `A controller label may be at most ${MAX_CONTROLLER_LABEL_CHARS} characters.`,
      'invalid-label',
    );
  }

  const registry = readPeerControllerRegistrySync(filePath);
  if (
    registry.controllers.some(
      (record) => record.label.toLowerCase() === flattened.toLowerCase(),
    )
  ) {
    throw new PeerControllerError(
      `A controller called "${flattened}" already exists. Labels are how you tell them apart when revoking, so pick another.`,
      'duplicate-label',
    );
  }
  if (registry.controllers.length >= MAX_CONTROLLERS) {
    throw new PeerControllerError(
      `This Qwen home already holds ${MAX_CONTROLLERS} controllers. Revoke one before adding another.`,
      'too-many',
    );
  }

  const token = mintControllerToken();
  const taken = new Set(registry.controllers.map((record) => record.id));
  let id = `c_${randomBytes(4).toString('hex')}`;
  while (taken.has(id)) {
    id = `c_${randomBytes(4).toString('hex')}`;
  }
  const record: PeerControllerRecord = {
    id,
    label: flattened,
    tokenHash: hashControllerToken(token),
    createdAt: Date.now(),
  };
  await writeRegistry(filePath, {
    schemaVersion: PEER_CONTROLLER_SCHEMA_VERSION,
    controllers: [...registry.controllers, record],
  });
  return { record, token };
}

/**
 * Revoke a grant by id. Returns what was removed, or null if no grant
 * had that id.
 *
 * Messages this controller already sent are unaffected: one that is
 * parked stays parked under its original attribution, and one already
 * delivered has been read. Revocation decides what happens on the next
 * connection, which is the only thing a token can decide.
 */
export async function removePeerController(
  id: string,
  filePath: string = getPeerControllerRegistryPath(),
): Promise<PeerControllerRecord | null> {
  const registry = readPeerControllerRegistrySync(filePath);
  const needle = id.trim().toLowerCase();
  const removed = registry.controllers.find(
    (record) => record.id.toLowerCase() === needle,
  );
  if (!removed) return null;
  await writeRegistry(filePath, {
    schemaVersion: PEER_CONTROLLER_SCHEMA_VERSION,
    controllers: registry.controllers.filter(
      (record) => record.id.toLowerCase() !== needle,
    ),
  });
  return removed;
}
