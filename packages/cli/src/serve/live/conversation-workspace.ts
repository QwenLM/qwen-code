/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, realpath, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface LiveConversationRootIdentity {
  readonly configuredRoot: string;
  readonly canonicalRoot: string;
  readonly device: number;
  readonly inode: number;
}

export interface LiveConversationWorkspaceOptions {
  homeDir?: string;
}

const isSamePath = (left: string, right: string): boolean =>
  process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;

function conversationDirectoryName(sessionId: string): string {
  if (sessionId.length === 0 || sessionId.length > 256) {
    throw new Error('Live conversation session id is invalid');
  }
  return `conversation-${createHash('sha256').update(sessionId).digest('hex')}`;
}

function validateRootStats(stats: Stats, label = 'root'): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(
      `Live conversation ${label} must be a non-symlink directory`,
    );
  }
  if (
    process.platform !== 'win32' &&
    typeof process.getuid === 'function' &&
    stats.uid !== process.getuid()
  ) {
    throw new Error(
      `Live conversation ${label} must be owned by the daemon user`,
    );
  }
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new Error(
      `Live conversation ${label} must be accessible only to its owner`,
    );
  }
}

function hasIdentity(
  stats: Stats,
  root: LiveConversationRootIdentity,
): boolean {
  return stats.dev === root.device && stats.ino === root.inode;
}

async function validateConversationDirectory(
  root: LiveConversationRootIdentity,
  name: string,
  candidate: string,
  parent: string = root.canonicalRoot,
): Promise<string> {
  const before = await lstat(candidate);
  validateRootStats(before, 'directory');
  const canonical = await realpath(candidate);
  const after = await lstat(canonical);
  validateRootStats(after, 'directory');
  const child = relative(parent, canonical);
  if (
    child !== name ||
    child.includes(sep) ||
    child.startsWith('..') ||
    isAbsolute(child) ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  ) {
    throw new Error(
      'Live conversation directory must be an owned direct child',
    );
  }
  await revalidateLiveConversationRoot(root);
  return canonical;
}

export function getLiveConversationRootPath(
  homeDir: string = homedir(),
): string {
  return resolve(homeDir, 'Documents', 'Qwen Code', 'Conversations');
}

async function createRoot(
  configuredRoot: string,
): Promise<LiveConversationRootIdentity> {
  try {
    await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  } catch (error) {
    let existing: Stats;
    try {
      existing = await lstat(configuredRoot);
    } catch {
      throw error;
    }
    validateRootStats(existing);
    throw error;
  }

  const before = await lstat(configuredRoot);
  validateRootStats(before);
  const canonicalRoot = await realpath(configuredRoot);
  const after = await lstat(canonicalRoot);
  validateRootStats(after);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error(
      'Live conversation root identity changed during validation',
    );
  }
  return {
    configuredRoot,
    canonicalRoot,
    device: after.dev,
    inode: after.ino,
  };
}

export async function revalidateLiveConversationRoot(
  root: LiveConversationRootIdentity,
): Promise<LiveConversationRootIdentity> {
  const configuredStats = await lstat(root.configuredRoot);
  validateRootStats(configuredStats);
  if (!hasIdentity(configuredStats, root)) {
    throw new Error('Live conversation root identity changed');
  }

  const canonical = await realpath(root.configuredRoot);
  if (!isSamePath(canonical, root.canonicalRoot)) {
    throw new Error('Live conversation root canonical path changed');
  }

  const canonicalStats = await lstat(root.canonicalRoot);
  validateRootStats(canonicalStats);
  if (!hasIdentity(canonicalStats, root)) {
    throw new Error('Live conversation root identity changed');
  }
  return root;
}

export async function assertExactLiveConversationRoot(
  root: LiveConversationRootIdentity,
  candidate: string,
): Promise<LiveConversationRootIdentity> {
  await revalidateLiveConversationRoot(root);
  const resolvedCandidate = resolve(candidate);
  if (
    !isSamePath(resolvedCandidate, root.configuredRoot) &&
    !isSamePath(resolvedCandidate, root.canonicalRoot)
  ) {
    throw new Error('Workspace must be the exact Live conversation root');
  }

  const stats = await lstat(resolvedCandidate);
  validateRootStats(stats);
  const canonical = await realpath(resolvedCandidate);
  if (!isSamePath(canonical, root.canonicalRoot) || !hasIdentity(stats, root)) {
    throw new Error('Workspace must be the exact Live conversation root');
  }
  return root;
}

export class LiveConversationWorkspace {
  readonly rootPath: string;
  private rootPromise?: Promise<LiveConversationRootIdentity>;

  constructor(options: LiveConversationWorkspaceOptions = {}) {
    this.rootPath = getLiveConversationRootPath(options.homeDir);
  }

  async getRoot(): Promise<LiveConversationRootIdentity> {
    if (!this.rootPromise) {
      const pending = createRoot(this.rootPath);
      this.rootPromise = pending;
      void pending.catch(() => {
        if (this.rootPromise === pending) this.rootPromise = undefined;
      });
    }
    return this.rootPromise;
  }

  async revalidate(): Promise<LiveConversationRootIdentity> {
    return revalidateLiveConversationRoot(await this.getRoot());
  }

  async assertExactRoot(
    candidate: string,
  ): Promise<LiveConversationRootIdentity> {
    return assertExactLiveConversationRoot(await this.getRoot(), candidate);
  }

  async materializeConversationDirectory(sessionId: string): Promise<string> {
    const root = await this.revalidate();
    const name = conversationDirectoryName(sessionId);
    const candidate = join(root.canonicalRoot, name);
    try {
      await mkdir(candidate, { mode: 0o700 });
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        (error as NodeJS.ErrnoException).code !== 'EEXIST'
      ) {
        throw error;
      }
    }

    return validateConversationDirectory(root, name, candidate);
  }

  async discardEmptyConversationDirectory(sessionId: string): Promise<boolean> {
    const root = await this.revalidate();
    const name = conversationDirectoryName(sessionId);
    const candidate = join(root.canonicalRoot, name);
    let canonical: string;
    try {
      canonical = await validateConversationDirectory(root, name, candidate);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return false;
      }
      throw error;
    }
    try {
      await rmdir(canonical);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
          (error as NodeJS.ErrnoException).code === 'ENOTEMPTY')
      ) {
        return false;
      }
      throw error;
    }
    await revalidateLiveConversationRoot(root);
    return true;
  }
}
