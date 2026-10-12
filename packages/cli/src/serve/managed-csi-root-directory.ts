/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { constants, promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

const UNAVAILABLE = 'Managed CSI root directory is unavailable.';

export class ManagedCsiRootDirectoryCleanupError extends AggregateError {
  constructor(openError: unknown, closeError: unknown) {
    super(
      [openError, closeError],
      'Managed CSI root directory cleanup failed.',
    );
    this.name = 'ManagedCsiRootDirectoryCleanupError';
  }
}

export class ManagedCsiRootDirectory {
  readonly rootDevice: string;
  readonly rootInode: string;
  private fenced = false;
  private readonly operations = new Set<Promise<void>>();
  private closing: Promise<void> | undefined;

  private constructor(
    private readonly root: string,
    private readonly handle: FileHandle,
    stats: BigIntStats,
  ) {
    this.rootDevice = stats.dev.toString();
    this.rootInode = stats.ino.toString();
  }

  static async open(
    root: string,
    device: string,
  ): Promise<ManagedCsiRootDirectory> {
    if (
      typeof constants.O_DIRECTORY !== 'number' ||
      typeof constants.O_NOFOLLOW !== 'number'
    )
      throw new Error(UNAVAILABLE);
    const before = await namedDirectory(root);
    if (before.dev.toString() !== device) throw new Error(UNAVAILABLE);
    const handle = await fs.open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    let directory: ManagedCsiRootDirectory | undefined;
    try {
      const stats = await handle.stat({ bigint: true });
      if (!sameDirectory(before, stats)) throw new Error(UNAVAILABLE);
      directory = new ManagedCsiRootDirectory(root, handle, stats);
      await directory.verify();
      return directory;
    } catch (error) {
      try {
        await (directory ? directory.close() : handle.close());
      } catch (closeError) {
        throw new ManagedCsiRootDirectoryCleanupError(error, closeError);
      }
      throw error;
    }
  }

  verify(): Promise<void> {
    return this.withVerifiedDirectory(async () => {});
  }

  get isAvailable(): boolean {
    return !this.fenced;
  }

  async withVerifiedDirectory<T>(
    operation: (handle: FileHandle) => Promise<T>,
  ): Promise<T> {
    if (this.fenced) throw new Error(UNAVAILABLE);
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.operations.add(pending);
    try {
      await this.inspect();
      try {
        return await operation(this.handle);
      } finally {
        await this.inspect();
      }
    } finally {
      this.operations.delete(pending);
      complete();
    }
  }

  private async inspect(): Promise<void> {
    if (this.fenced) throw new Error(UNAVAILABLE);
    try {
      const before = await namedDirectory(this.root);
      const descriptor = await this.handle.stat({ bigint: true });
      const after = await namedDirectory(this.root);
      if (
        this.fenced ||
        !sameDirectory(before, descriptor) ||
        !sameDirectory(after, descriptor) ||
        descriptor.dev.toString() !== this.rootDevice ||
        descriptor.ino.toString() !== this.rootInode
      )
        throw new Error(UNAVAILABLE);
    } catch (error) {
      // Closing joins this operation too; awaiting it here would self-wait.
      void this.close().catch(() => {});
      throw error;
    }
  }

  close(): Promise<void> {
    this.fenced = true;
    this.closing ??= (async () => {
      await Promise.all(this.operations);
      await this.handle.close();
    })();
    return this.closing;
  }
}

async function namedDirectory(root: string): Promise<BigIntStats> {
  if ((await fs.realpath(root)) !== root) throw new Error(UNAVAILABLE);
  const stats = await fs.lstat(root, { bigint: true });
  if (
    !stats.isDirectory() ||
    stats.dev < 0n ||
    stats.dev > 0xffff_ffff_ffff_ffffn ||
    stats.ino <= 0n ||
    stats.ino > 0xffff_ffff_ffff_ffffn
  )
    throw new Error(UNAVAILABLE);
  return stats;
}

function sameDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return (
    right.isDirectory() && left.dev === right.dev && left.ino === right.ino
  );
}
