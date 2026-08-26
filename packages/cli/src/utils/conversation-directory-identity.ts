/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * True iff `ino` can be used as proof of file identity.
 *
 * FAT/exFAT and some SMB-style filesystems do not expose inode numbers and
 * report `Stats.ino === 0` for every entry, so comparing by `dev:ino` there
 * collapses unrelated directories onto one identity.
 *
 * This restates core's `hasVerifiableInode()` rather than importing it: this
 * module is reachable from the serve pre-listen fast path, and importing the
 * core package barrel pulls its whole module graph into that bundle closure.
 */
function hasVerifiableInode(ino: number): boolean {
  return Number(ino) !== 0;
}

export interface ConversationRootIdentity {
  readonly configuredRoot: string;
  readonly canonicalRoot: string;
  readonly device: number;
  readonly inode: number;
  /**
   * False when the hosting filesystem does not expose inode numbers, so
   * identity cannot be proven by `dev:ino`.
   *
   * Comparisons then fall back to device, canonical path and stat shape, which
   * cannot detect a same-path replacement. That is a real reduction in
   * guarantee, but refusing to establish the root would make Conversations
   * permanently unusable on exFAT/FAT and some SMB mounts: "cannot prove
   * unchanged" is not "changed". Callers should surface this once per root.
   */
  readonly inodeVerifiable: boolean;
}

export interface ConversationDirectoryIdentity {
  readonly root: ConversationRootIdentity;
  readonly storageSessionId: string;
  readonly name: string;
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
}

export type ConversationDirectoryIdentityScope = 'root' | 'child';

export type ConversationDirectoryIdentityFailureReason =
  | 'invalid_session_id'
  | 'not_directory'
  | 'wrong_owner'
  | 'wrong_mode'
  | 'io_error'
  | 'identity_changed'
  | 'canonical_path_changed'
  | 'not_direct_child'
  | 'unexpected_identity'
  | 'not_empty';

export class ConversationDirectoryIdentityError extends Error {
  override readonly name = 'ConversationDirectoryIdentityError';

  constructor(
    readonly scope: ConversationDirectoryIdentityScope,
    readonly reason: ConversationDirectoryIdentityFailureReason,
    cause?: unknown,
  ) {
    // Passing the options bag through to Error keeps `cause` a non-enumerable
    // own property that exists only when one was provided; a class field
    // declaration would define an enumerable `cause: undefined` on every
    // instance instead.
    super(
      `Conversation ${scope} identity validation failed: ${reason}`,
      cause !== undefined ? { cause } : undefined,
    );
  }
}

function throwIdentityIoError(
  scope: ConversationDirectoryIdentityScope,
  cause: unknown,
): never {
  throw new ConversationDirectoryIdentityError(scope, 'io_error', cause);
}

export const isSameConversationPath = (left: string, right: string): boolean =>
  process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;

export function getConversationDirectoryName(storageSessionId: string): string {
  if (storageSessionId.length === 0 || storageSessionId.length > 256) {
    throw new ConversationDirectoryIdentityError('child', 'invalid_session_id');
  }
  return `conversation-${createHash('sha256')
    .update(storageSessionId)
    .digest('hex')}`;
}

export function getConversationStagedDirectoryName(
  storageSessionId: string,
): string {
  return `${getConversationDirectoryName(storageSessionId)}.deleting`;
}

function validateDirectoryStats(
  stats: Stats,
  scope: ConversationDirectoryIdentityScope,
): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new ConversationDirectoryIdentityError(scope, 'not_directory');
  }
  if (
    process.platform !== 'win32' &&
    typeof process.getuid === 'function' &&
    stats.uid !== process.getuid()
  ) {
    throw new ConversationDirectoryIdentityError(scope, 'wrong_owner');
  }
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new ConversationDirectoryIdentityError(scope, 'wrong_mode');
  }
}

function hasRootIdentity(
  stats: Stats,
  root: ConversationRootIdentity,
): boolean {
  if (!root.inodeVerifiable) return stats.dev === root.device;
  return (
    hasVerifiableInode(stats.ino) &&
    stats.dev === root.device &&
    stats.ino === root.inode
  );
}

/**
 * True iff `before` and `after` may be treated as the same directory.
 *
 * These comparisons are the anti-swap checks around `realpath`. Where inodes
 * are available they must match; where the filesystem reports none, there is
 * nothing to compare and reporting a change would be a false positive that
 * blocks the feature outright, so only the device is required.
 */
function isSameDirectoryIdentity(before: Stats, after: Stats): boolean {
  if (!hasVerifiableInode(before.ino) || !hasVerifiableInode(after.ino)) {
    return before.dev === after.dev;
  }
  return before.dev === after.dev && before.ino === after.ino;
}

function hasExpectedDirectoryIdentity(
  identity: ConversationDirectoryIdentity,
  expected: ConversationDirectoryIdentity,
): boolean {
  const identityInodeVerifiable = hasVerifiableInode(identity.inode);
  const expectedInodeVerifiable = hasVerifiableInode(expected.inode);
  return (
    identity.storageSessionId === expected.storageSessionId &&
    identity.name === expected.name &&
    isSameConversationPath(identity.canonicalPath, expected.canonicalPath) &&
    identity.device === expected.device &&
    identityInodeVerifiable === expectedInodeVerifiable &&
    (!identityInodeVerifiable || identity.inode === expected.inode) &&
    isSameConversationPath(
      identity.root.configuredRoot,
      expected.root.configuredRoot,
    ) &&
    isSameConversationPath(
      identity.root.canonicalRoot,
      expected.root.canonicalRoot,
    ) &&
    identity.root.device === expected.root.device &&
    identity.root.inodeVerifiable === expected.root.inodeVerifiable &&
    (!identity.root.inodeVerifiable ||
      identity.root.inode === expected.root.inode)
  );
}

export async function createConversationRootIdentity(
  configuredRoot: string,
): Promise<ConversationRootIdentity> {
  try {
    await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  } catch (error) {
    let existing: Stats;
    try {
      existing = await lstat(configuredRoot);
    } catch {
      throwIdentityIoError('root', error);
    }
    validateDirectoryStats(existing, 'root');
    throwIdentityIoError('root', error);
  }

  let before: Stats;
  try {
    before = await lstat(configuredRoot);
  } catch (error) {
    throwIdentityIoError('root', error);
  }
  validateDirectoryStats(before, 'root');

  let canonicalRoot: string;
  let after: Stats;
  try {
    canonicalRoot = await realpath(configuredRoot);
    after = await lstat(canonicalRoot);
  } catch (error) {
    throwIdentityIoError('root', error);
  }
  validateDirectoryStats(after, 'root');
  if (!isSameDirectoryIdentity(before, after)) {
    throw new ConversationDirectoryIdentityError('root', 'identity_changed');
  }
  return {
    configuredRoot,
    canonicalRoot,
    device: after.dev,
    inode: after.ino,
    inodeVerifiable: hasVerifiableInode(after.ino),
  };
}

export async function revalidateConversationRootIdentity(
  root: ConversationRootIdentity,
): Promise<ConversationRootIdentity> {
  let configuredStats: Stats;
  try {
    configuredStats = await lstat(root.configuredRoot);
  } catch (error) {
    throwIdentityIoError('root', error);
  }
  validateDirectoryStats(configuredStats, 'root');
  if (!hasRootIdentity(configuredStats, root)) {
    throw new ConversationDirectoryIdentityError('root', 'identity_changed');
  }

  let canonical: string;
  try {
    canonical = await realpath(root.configuredRoot);
  } catch (error) {
    throwIdentityIoError('root', error);
  }
  if (!isSameConversationPath(canonical, root.canonicalRoot)) {
    throw new ConversationDirectoryIdentityError(
      'root',
      'canonical_path_changed',
    );
  }

  let canonicalStats: Stats;
  try {
    canonicalStats = await lstat(root.canonicalRoot);
  } catch (error) {
    throwIdentityIoError('root', error);
  }
  validateDirectoryStats(canonicalStats, 'root');
  if (!hasRootIdentity(canonicalStats, root)) {
    throw new ConversationDirectoryIdentityError('root', 'identity_changed');
  }
  return root;
}

export async function assertExactConversationRootIdentity(
  root: ConversationRootIdentity,
  candidate: string,
): Promise<ConversationRootIdentity> {
  await revalidateConversationRootIdentity(root);
  const resolvedCandidate = resolve(candidate);
  if (
    !isSameConversationPath(resolvedCandidate, root.configuredRoot) &&
    !isSameConversationPath(resolvedCandidate, root.canonicalRoot)
  ) {
    throw new ConversationDirectoryIdentityError('root', 'unexpected_identity');
  }

  let stats: Stats;
  let canonical: string;
  try {
    stats = await lstat(resolvedCandidate);
    validateDirectoryStats(stats, 'root');
    canonical = await realpath(resolvedCandidate);
  } catch (error) {
    if (error instanceof ConversationDirectoryIdentityError) throw error;
    throwIdentityIoError('root', error);
  }
  if (
    !isSameConversationPath(canonical, root.canonicalRoot) ||
    !hasRootIdentity(stats, root)
  ) {
    throw new ConversationDirectoryIdentityError('root', 'unexpected_identity');
  }
  return root;
}

async function inspectConversationNamedDirectoryIdentity(
  root: ConversationRootIdentity,
  storageSessionId: string,
  name: string,
  expected?: ConversationDirectoryIdentity,
): Promise<ConversationDirectoryIdentity | undefined> {
  await revalidateConversationRootIdentity(root);
  const candidate = join(root.canonicalRoot, name);
  let before: Stats;
  try {
    before = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throwIdentityIoError('child', error);
  }
  validateDirectoryStats(before, 'child');

  let canonical: string;
  let after: Stats;
  try {
    canonical = await realpath(candidate);
    after = await lstat(canonical);
  } catch (error) {
    // A child deleted between the lstat and the realpath is "already gone" —
    // the same verdict as the initial-lstat ENOENT — not an identity change.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throwIdentityIoError('child', error);
  }
  validateDirectoryStats(after, 'child');
  const child = relative(root.canonicalRoot, canonical);
  if (
    child !== name ||
    child.includes(sep) ||
    child.startsWith('..') ||
    isAbsolute(child)
  ) {
    throw new ConversationDirectoryIdentityError('child', 'not_direct_child');
  }
  if (!isSameDirectoryIdentity(before, after)) {
    throw new ConversationDirectoryIdentityError('child', 'identity_changed');
  }
  await revalidateConversationRootIdentity(root);
  const identity: ConversationDirectoryIdentity = {
    root,
    storageSessionId,
    name,
    canonicalPath: canonical,
    device: after.dev,
    inode: after.ino,
  };
  if (expected && !hasExpectedDirectoryIdentity(identity, expected)) {
    throw new ConversationDirectoryIdentityError(
      'child',
      'unexpected_identity',
    );
  }
  return identity;
}

export async function inspectConversationDirectoryIdentity(
  root: ConversationRootIdentity,
  storageSessionId: string,
  expected?: ConversationDirectoryIdentity,
): Promise<ConversationDirectoryIdentity | undefined> {
  return inspectConversationNamedDirectoryIdentity(
    root,
    storageSessionId,
    getConversationDirectoryName(storageSessionId),
    expected,
  );
}

export async function inspectConversationStagedDirectoryIdentity(
  root: ConversationRootIdentity,
  storageSessionId: string,
): Promise<ConversationDirectoryIdentity | undefined> {
  return inspectConversationNamedDirectoryIdentity(
    root,
    storageSessionId,
    getConversationStagedDirectoryName(storageSessionId),
  );
}

export function isSameConversationDirectoryObject(
  identity: ConversationDirectoryIdentity,
  expected: ConversationDirectoryIdentity,
): boolean {
  const identityInodeVerifiable = hasVerifiableInode(identity.inode);
  const expectedInodeVerifiable = hasVerifiableInode(expected.inode);
  return (
    identity.storageSessionId === expected.storageSessionId &&
    identity.device === expected.device &&
    identityInodeVerifiable === expectedInodeVerifiable &&
    (!identityInodeVerifiable || identity.inode === expected.inode) &&
    isSameConversationPath(
      identity.root.canonicalRoot,
      expected.root.canonicalRoot,
    ) &&
    identity.root.device === expected.root.device &&
    identity.root.inodeVerifiable === expected.root.inodeVerifiable &&
    (!identity.root.inodeVerifiable ||
      identity.root.inode === expected.root.inode)
  );
}

export async function materializeConversationDirectoryIdentity(
  root: ConversationRootIdentity,
  storageSessionId: string,
): Promise<{ identity: ConversationDirectoryIdentity; created: boolean }> {
  await revalidateConversationRootIdentity(root);
  const name = getConversationDirectoryName(storageSessionId);
  const candidate = join(root.canonicalRoot, name);
  let created = false;
  try {
    await mkdir(candidate, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throwIdentityIoError('child', error);
    }
  }
  const identity = await inspectConversationDirectoryIdentity(
    root,
    storageSessionId,
  );
  if (!identity) {
    throw new ConversationDirectoryIdentityError('child', 'identity_changed');
  }
  return { identity, created };
}
