/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import { openNoFollow } from '../utils/no-follow-open.js';
import { syncManagedJournalDirectory } from './managed-journal-snapshot.js';

/** A derived index; callers must supply the journal's validated terminal. */
export class FileManagedTerminalIdentityStore<T extends object> {
  private readonly directory: string;

  constructor(
    journalPath: string,
    private readonly kind: 'activation' | 'inbox',
  ) {
    this.directory = `${journalPath}.terminal-identities`;
  }

  async read(
    identity: readonly [string, string, string],
    terminal: T,
  ): Promise<T> {
    const state = JSON.stringify(terminal);
    const bytes = Buffer.from(
      `${JSON.stringify({
        v: 1,
        kind: this.kind,
        identity,
        terminal,
        digest: createHash('sha256').update(state).digest('hex'),
      })}\n`,
    );
    const name = createHash('sha256')
      .update(JSON.stringify(identity))
      .digest('hex');
    const target = path.join(this.directory, `${name}.json`);

    await this.ensureDirectory();
    let stored = await this.readExisting(target, bytes);
    if (stored === undefined) {
      const pending = path.join(this.directory, `.pending-${randomUUID()}`);
      try {
        const handle = await open(pending, 'wx', 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await link(pending, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        stored = await this.readExisting(target, bytes);
        if (stored === undefined) {
          throw new Error('Terminal identity publication is missing.');
        }
      } finally {
        await unlink(pending).catch(() => undefined);
      }
    }
    await syncManagedJournalDirectory(target);
    return (JSON.parse(stored.toString('utf8')) as { terminal: T }).terminal;
  }

  private async ensureDirectory(): Promise<void> {
    await this.assertDirectory(path.dirname(this.directory));
    try {
      await mkdir(this.directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await this.assertDirectory(this.directory);
    await syncManagedJournalDirectory(this.directory);
  }

  private async assertDirectory(directory: string): Promise<void> {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Terminal identity index requires a real directory.');
    }
  }

  private async readExisting(
    target: string,
    expected: Buffer,
  ): Promise<Buffer | undefined> {
    let handle: FileHandle;
    try {
      handle = await openNoFollow(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== expected.byteLength) {
        throw new Error('Terminal identity record size is invalid.');
      }
      const bytes = Buffer.alloc(expected.byteLength);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          bytes.byteLength - offset,
          offset,
        );
        if (bytesRead === 0) {
          throw new Error('Terminal identity record is truncated.');
        }
        offset += bytesRead;
      }
      if (
        (await handle.stat()).size !== expected.byteLength ||
        !bytes.equals(expected)
      ) {
        throw new Error('Terminal identity record conflicts with its journal.');
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }
}
