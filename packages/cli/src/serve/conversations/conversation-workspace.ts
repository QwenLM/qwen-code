/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdir, rename, rm, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertExactConversationRootIdentity,
  ConversationDirectoryIdentityError,
  createConversationRootIdentity,
  getConversationDirectoryName,
  getConversationStagedDirectoryName,
  inspectConversationDirectoryIdentity,
  inspectConversationStagedDirectoryIdentity,
  isSameConversationDirectoryObject,
  materializeConversationDirectoryIdentity,
  revalidateConversationRootIdentity,
  type ConversationDirectoryIdentity,
  type ConversationRootIdentity,
} from '../../utils/conversation-directory-identity.js';
import { normalizeSessionIdForLookup } from '../../config/session-id.js';

export type { ConversationRootIdentity } from '../../utils/conversation-directory-identity.js';

export interface ConversationWorkspaceOptions {
  homeDir?: string;
}

export type StandaloneDirectoryInspection =
  | { status: 'ready'; identity: ConversationDirectoryIdentity }
  | { status: 'missing' }
  | {
      status: 'compromised';
      error: ConversationDirectoryIdentityError;
    };

export type StandaloneDirectoryEnsureResult =
  | { status: 'ready'; identity: ConversationDirectoryIdentity }
  | { status: 'created'; identity: ConversationDirectoryIdentity }
  | { status: 'recreated'; identity: ConversationDirectoryIdentity }
  | {
      status: 'compromised';
      error: ConversationDirectoryIdentityError;
    };

export type StandaloneDeletionPathsInspection =
  | { status: 'absent' }
  | { status: 'normal'; identity: ConversationDirectoryIdentity }
  | { status: 'staged'; identity: ConversationDirectoryIdentity }
  | {
      status: 'compromised';
      error: ConversationDirectoryIdentityError;
    };

function liveIdentityError(
  error: unknown,
  exactRoot = false,
  creatingRoot = false,
): never {
  if (!(error instanceof ConversationDirectoryIdentityError)) throw error;
  if (error.reason === 'io_error' && error.cause !== undefined) {
    throw error.cause;
  }
  if (error.scope === 'root') {
    switch (error.reason) {
      case 'not_directory':
        throw new Error(
          'Live conversation root must be a non-symlink directory',
        );
      case 'wrong_owner':
        throw new Error(
          'Live conversation root must be owned by the daemon user',
        );
      case 'wrong_mode':
        throw new Error(
          'Live conversation root must be accessible only to its owner',
        );
      case 'canonical_path_changed':
        throw new Error('Live conversation root canonical path changed');
      case 'identity_changed':
        throw new Error(
          creatingRoot
            ? 'Live conversation root identity changed during validation'
            : 'Live conversation root identity changed',
        );
      case 'unexpected_identity':
        if (exactRoot) {
          throw new Error('Workspace must be the exact Live conversation root');
        }
        throw new Error('Live conversation root identity changed');
      default:
        throw new Error('Live conversation root identity changed');
    }
  }
  switch (error.reason) {
    case 'invalid_session_id':
      throw new Error('Live conversation session id is invalid');
    case 'not_directory':
      throw new Error(
        'Live conversation directory must be a non-symlink directory',
      );
    case 'wrong_owner':
      throw new Error(
        'Live conversation directory must be owned by the daemon user',
      );
    case 'wrong_mode':
      throw new Error(
        'Live conversation directory must be accessible only to its owner',
      );
    default:
      throw new Error(
        'Live conversation directory must be an owned direct child',
      );
  }
}

export function getConversationRootPath(homeDir: string = homedir()): string {
  return resolve(homeDir, 'Documents', 'Qwen Code', 'Conversations');
}

export async function revalidateConversationRoot(
  root: ConversationRootIdentity,
): Promise<ConversationRootIdentity> {
  try {
    return await revalidateConversationRootIdentity(root);
  } catch (error) {
    liveIdentityError(error);
  }
}

export async function assertExactConversationRoot(
  root: ConversationRootIdentity,
  candidate: string,
): Promise<ConversationRootIdentity> {
  try {
    return await assertExactConversationRootIdentity(root, candidate);
  } catch (error) {
    liveIdentityError(error, true);
  }
}

export class ConversationWorkspace {
  readonly rootPath: string;
  private rootPromise?: Promise<ConversationRootIdentity>;

  constructor(options: ConversationWorkspaceOptions = {}) {
    this.rootPath = getConversationRootPath(options.homeDir);
  }

  private getRootIdentity(): Promise<ConversationRootIdentity> {
    if (!this.rootPromise) {
      const pending = createConversationRootIdentity(this.rootPath);
      this.rootPromise = pending;
      void pending.catch(() => {
        if (this.rootPromise === pending) this.rootPromise = undefined;
      });
    }
    return this.rootPromise;
  }

  async getRoot(): Promise<ConversationRootIdentity> {
    try {
      return await this.getRootIdentity();
    } catch (error) {
      liveIdentityError(error, false, true);
    }
  }

  private async revalidateStandaloneRoot(): Promise<ConversationRootIdentity> {
    return revalidateConversationRootIdentity(await this.getRootIdentity());
  }

  async revalidate(): Promise<ConversationRootIdentity> {
    return revalidateConversationRoot(await this.getRoot());
  }

  async assertExactRoot(candidate: string): Promise<ConversationRootIdentity> {
    return assertExactConversationRoot(await this.getRoot(), candidate);
  }

  /**
   * The private directory is derived from the canonical session id, not from
   * whatever spelling a caller happens to hold.
   *
   * `getConversationDirectoryName()` is a case-sensitive hash, and callers reach
   * these methods with a mix of request ids, live-entry ids and ids echoed back
   * from tool arguments. Canonicalizing here makes one session resolve to one
   * directory by construction instead of leaving it to every call site.
   */
  private directoryKey(sessionId: string): string {
    return normalizeSessionIdForLookup(sessionId);
  }

  async materializeConversationDirectory(sessionId: string): Promise<string> {
    const root = await this.revalidate();
    try {
      return (
        await materializeConversationDirectoryIdentity(
          root,
          this.directoryKey(sessionId),
        )
      ).identity.canonicalPath;
    } catch (error) {
      liveIdentityError(error);
    }
  }

  async discardEmptyConversationDirectory(sessionId: string): Promise<boolean> {
    const root = await this.revalidate();
    let identity: ConversationDirectoryIdentity | undefined;
    try {
      identity = await inspectConversationDirectoryIdentity(
        root,
        this.directoryKey(sessionId),
      );
    } catch (error) {
      // A root that vanished mid-inspection means there is nothing left to
      // discard: keep the ENOENT-race → `false` contract instead of
      // reporting an identity violation.
      if (
        error instanceof ConversationDirectoryIdentityError &&
        error.reason === 'io_error' &&
        (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
      ) {
        return false;
      }
      liveIdentityError(error);
    }
    if (!identity) return false;
    try {
      await rmdir(identity.canonicalPath);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' ||
        (error as NodeJS.ErrnoException).code === 'ENOTEMPTY'
      ) {
        return false;
      }
      throw error;
    }
    await revalidateConversationRoot(root);
    return true;
  }

  async prepareStandaloneDirectory(
    storageSessionId: string,
  ): Promise<{ identity: ConversationDirectoryIdentity; created: boolean }> {
    const root = await this.revalidateStandaloneRoot();
    const prepared = await materializeConversationDirectoryIdentity(
      root,
      storageSessionId,
    );
    const identity = await inspectConversationDirectoryIdentity(
      root,
      storageSessionId,
      prepared.identity,
    );
    if (!identity) {
      throw new ConversationDirectoryIdentityError('child', 'identity_changed');
    }
    // Entries are read after the final identity re-inspection so a same-uid
    // entry appearing across the inspect cannot slip past the emptiness
    // verdict on a stale snapshot.
    let entries: string[];
    try {
      entries = await readdir(identity.canonicalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ConversationDirectoryIdentityError(
          'child',
          'identity_changed',
        );
      }
      throw new ConversationDirectoryIdentityError('child', 'io_error', error);
    }
    if (entries.length > 0) {
      throw new ConversationDirectoryIdentityError('child', 'not_empty');
    }
    return { identity, created: prepared.created };
  }

  async inspectStandaloneDirectory(
    storageSessionId: string,
    expected?: ConversationDirectoryIdentity,
  ): Promise<StandaloneDirectoryInspection> {
    const root = await this.revalidateStandaloneRoot();
    try {
      const identity = await inspectConversationDirectoryIdentity(
        root,
        storageSessionId,
        expected,
      );
      return identity ? { status: 'ready', identity } : { status: 'missing' };
    } catch (error) {
      if (
        error instanceof ConversationDirectoryIdentityError &&
        error.scope === 'child'
      ) {
        return { status: 'compromised', error };
      }
      throw error;
    }
  }

  async ensureStandaloneDirectory(
    storageSessionId: string,
    expected?: ConversationDirectoryIdentity,
  ): Promise<StandaloneDirectoryEnsureResult> {
    const inspected = await this.inspectStandaloneDirectory(
      storageSessionId,
      expected,
    );
    if (inspected.status !== 'missing') return inspected;

    const root = await this.revalidateStandaloneRoot();
    try {
      const materialized = await materializeConversationDirectoryIdentity(
        root,
        storageSessionId,
      );
      if (!materialized.created) {
        // The directory appeared inside the race window, so it is adopted
        // only through the same inspection verdict as one found up front —
        // never as a blind 'ready' carrying whatever the racing creator put
        // there.
        const raced = await this.inspectStandaloneDirectory(
          storageSessionId,
          expected,
        );
        if (raced.status !== 'missing') return raced;
        throw new ConversationDirectoryIdentityError(
          'child',
          'identity_changed',
        );
      }
      // 'recreated' is reserved for a directory that vanished after its
      // identity was captured; a first-ever creation reports 'created'.
      return {
        status: expected ? 'recreated' : 'created',
        identity: materialized.identity,
      };
    } catch (error) {
      if (
        error instanceof ConversationDirectoryIdentityError &&
        error.scope === 'child'
      ) {
        return { status: 'compromised', error };
      }
      throw error;
    }
  }

  async inspectStandaloneDeletionPaths(
    storageSessionId: string,
    expected?: ConversationDirectoryIdentity,
  ): Promise<StandaloneDeletionPathsInspection> {
    const root = await this.revalidateStandaloneRoot();
    try {
      const normal = await inspectConversationDirectoryIdentity(
        root,
        storageSessionId,
      );
      const staged = await inspectConversationStagedDirectoryIdentity(
        root,
        storageSessionId,
      );
      if (normal && staged) {
        throw new ConversationDirectoryIdentityError(
          'child',
          'unexpected_identity',
        );
      }
      const identity = normal ?? staged;
      if (
        identity &&
        expected &&
        !isSameConversationDirectoryObject(identity, expected)
      ) {
        throw new ConversationDirectoryIdentityError(
          'child',
          'unexpected_identity',
        );
      }
      if (normal) return { status: 'normal', identity: normal };
      if (staged) return { status: 'staged', identity: staged };
      return { status: 'absent' };
    } catch (error) {
      if (
        error instanceof ConversationDirectoryIdentityError &&
        error.scope === 'child'
      ) {
        return { status: 'compromised', error };
      }
      throw error;
    }
  }

  async createStandaloneDeletionExpectation(
    storageSessionId: string,
    recorded: { device: number; inode: number; inodeVerifiable: boolean },
  ): Promise<ConversationDirectoryIdentity> {
    if (recorded.inodeVerifiable !== (recorded.inode !== 0)) {
      throw new ConversationDirectoryIdentityError(
        'child',
        'unexpected_identity',
      );
    }
    const root = await this.revalidateStandaloneRoot();
    const name = getConversationDirectoryName(storageSessionId);
    return {
      root,
      storageSessionId,
      name,
      canonicalPath: join(root.canonicalRoot, name),
      device: recorded.device,
      inode: recorded.inode,
    };
  }

  async stageStandaloneDirectory(
    storageSessionId: string,
    expected: ConversationDirectoryIdentity,
  ): Promise<ConversationDirectoryIdentity> {
    const inspected = await this.inspectStandaloneDeletionPaths(
      storageSessionId,
      expected,
    );
    if (inspected.status === 'compromised') throw inspected.error;
    if (inspected.status !== 'normal') {
      throw new ConversationDirectoryIdentityError('child', 'identity_changed');
    }
    const root = await this.revalidateStandaloneRoot();
    await rename(
      inspected.identity.canonicalPath,
      join(
        root.canonicalRoot,
        getConversationStagedDirectoryName(storageSessionId),
      ),
    );
    await revalidateConversationRootIdentity(root);
    const staged = await inspectConversationStagedDirectoryIdentity(
      root,
      storageSessionId,
    );
    if (
      !staged ||
      !isSameConversationDirectoryObject(staged, inspected.identity)
    ) {
      throw new ConversationDirectoryIdentityError('child', 'identity_changed');
    }
    return staged;
  }

  async restoreStagedStandaloneDirectory(
    storageSessionId: string,
    expected: ConversationDirectoryIdentity,
  ): Promise<ConversationDirectoryIdentity> {
    const inspected = await this.inspectStandaloneDeletionPaths(
      storageSessionId,
      expected,
    );
    if (inspected.status === 'compromised') throw inspected.error;
    if (inspected.status !== 'staged') {
      throw new ConversationDirectoryIdentityError('child', 'identity_changed');
    }
    const root = await this.revalidateStandaloneRoot();
    await rename(
      inspected.identity.canonicalPath,
      join(root.canonicalRoot, getConversationDirectoryName(storageSessionId)),
    );
    await revalidateConversationRootIdentity(root);
    const restored = await inspectConversationDirectoryIdentity(
      root,
      storageSessionId,
    );
    if (
      !restored ||
      !isSameConversationDirectoryObject(restored, inspected.identity)
    ) {
      throw new ConversationDirectoryIdentityError('child', 'identity_changed');
    }
    return restored;
  }

  async removeStagedStandaloneDirectory(
    storageSessionId: string,
    expected: ConversationDirectoryIdentity,
  ): Promise<void> {
    const inspected = await this.inspectStandaloneDeletionPaths(
      storageSessionId,
      expected,
    );
    if (inspected.status === 'compromised') throw inspected.error;
    if (inspected.status !== 'staged') {
      throw new ConversationDirectoryIdentityError('child', 'identity_changed');
    }
    const confirmed = await inspectConversationStagedDirectoryIdentity(
      inspected.identity.root,
      storageSessionId,
    );
    if (
      !confirmed ||
      !isSameConversationDirectoryObject(confirmed, inspected.identity)
    ) {
      throw new ConversationDirectoryIdentityError('child', 'identity_changed');
    }
    await rm(confirmed.canonicalPath, { recursive: true });
    await revalidateConversationRootIdentity(confirmed.root);
  }
}
