/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdir, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  assertExactConversationRootIdentity,
  ConversationDirectoryIdentityError,
  createConversationRootIdentity,
  inspectConversationDirectoryIdentity,
  materializeConversationDirectoryIdentity,
  revalidateConversationRootIdentity,
  type ConversationDirectoryIdentity,
  type ConversationRootIdentity,
} from '../../utils/conversation-directory-identity.js';

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
  | { status: 'recreated'; identity: ConversationDirectoryIdentity }
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

  async materializeConversationDirectory(sessionId: string): Promise<string> {
    const root = await this.revalidate();
    try {
      return (await materializeConversationDirectoryIdentity(root, sessionId))
        .identity.canonicalPath;
    } catch (error) {
      liveIdentityError(error);
    }
  }

  async discardEmptyConversationDirectory(sessionId: string): Promise<boolean> {
    const root = await this.revalidate();
    let identity: ConversationDirectoryIdentity | undefined;
    try {
      identity = await inspectConversationDirectoryIdentity(root, sessionId);
    } catch (error) {
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
    let entries: string[];
    try {
      entries = await readdir(prepared.identity.canonicalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ConversationDirectoryIdentityError(
          'child',
          'identity_changed',
        );
      }
      throw new ConversationDirectoryIdentityError('child', 'io_error', error);
    }
    const identity = await inspectConversationDirectoryIdentity(
      root,
      storageSessionId,
      prepared.identity,
    );
    if (!identity) {
      throw new ConversationDirectoryIdentityError('child', 'identity_changed');
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
      if (!materialized.created && expected) {
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
      return {
        status: materialized.created ? 'recreated' : 'ready',
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
}
