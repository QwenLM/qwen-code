/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ManagedToolFileHistory } from '@qwen-code/qwen-code-core/tools/managed-tool-file-history.js';
import {
  historyPath,
  type HostedFileHistoryState,
} from './hosted-file-history-protocol.js';

export class ManagedRuntimeFileHistory {
  history: ManagedToolFileHistory;
  private readonly files: HostedFileHistoryState['files'];
  private readonly prepared = new Set<string>();

  constructor(
    readonly ownerSessionId: string,
    readonly directory: string,
    state: HostedFileHistoryState | null,
  ) {
    this.history = new ManagedToolFileHistory(
      ownerSessionId,
      directory,
      state?.snapshots.map((s) => ({
        ...s,
        trackedFileBackups: Object.fromEntries(
          Object.entries(s.trackedFileBackups).map(([file, backup]) => [
            file.split('/').join(path.sep),
            backup,
          ]),
        ),
      })) ?? [],
    );
    this.files = Object.assign(
      Object.create(null),
      structuredClone(state?.files ?? {}),
    );
  }

  async ready(checkPaths = true): Promise<void> {
    await this.history.ready();
    await this.history.service.validateRestoredSnapshots();
    for (const snapshot of this.history.state().snapshots) {
      for (const [file, backup] of Object.entries(
        snapshot.trackedFileBackups,
      )) {
        if (checkPaths) await this.resolve(file.split(path.sep).join('/'));
        if (backup.failed)
          throw new Error('Hosted file history backup is unavailable.');
      }
    }
  }

  state(): HostedFileHistoryState {
    return {
      ownerSessionId: this.ownerSessionId,
      snapshots: this.history.state().snapshots.map((s) => ({
        ...s,
        trackedFileBackups: Object.fromEntries(
          Object.entries(s.trackedFileBackups).map(([file, backup]) => [
            file.split(path.sep).join('/'),
            backup,
          ]),
        ),
      })),
      files: structuredClone(this.files),
    };
  }

  async prepare(promptId: string, paths: string[]): Promise<void> {
    await this.ready();
    const snapshots = this.history.state().snapshots;
    if (snapshots.length >= 100 && snapshots.at(-1)?.promptId !== promptId)
      throw new Error(
        'Hosted file history has reached its 100 snapshot limit.',
      );
    const newPrompt = snapshots.at(-1)?.promptId !== promptId;
    const observed: HostedFileHistoryState['files'] = Object.create(null);
    for (const file of new Set([
      ...(newPrompt ? Object.keys(this.files) : []),
      ...paths,
    ])) {
      observed[file] = await this.fingerprint(file);
      if (
        !newPrompt &&
        Object.hasOwn(this.files, file) &&
        !isDeepStrictEqual(observed[file], this.files[file])
      )
        throw new Error('Hosted file changed outside tracked mutations.');
    }
    // Initialize before preparation can fail while backup storage is unavailable.
    const previous = new ManagedToolFileHistory(
      this.ownerSessionId,
      this.directory,
      snapshots,
    );
    await previous.ready();
    try {
      await this.history.checkpoint(promptId);
      await this.history.run(async () => {
        for (const file of paths) {
          const absolute = await this.resolve(file);
          await this.history.service.trackEdit(absolute);
          const backups = this.history.service
            .getSnapshots()
            .at(-1)?.trackedFileBackups;
          const key = file.split('/').join(path.sep);
          if (!backups || !Object.hasOwn(backups, key) || backups[key].failed)
            throw new Error(
              'Hosted file backup failed; mutation was not started.',
            );
        }
        await this.ready();
        for (const [file, expected] of Object.entries(observed))
          if (!isDeepStrictEqual(await this.fingerprint(file), expected))
            throw new Error('Hosted file changed during backup preparation.');
        Object.assign(this.files, observed);
        if (newPrompt) this.prepared.clear();
        for (const file of paths) this.prepared.add(file);
      });
    } catch (error) {
      // Restore prompt bookkeeping too, so the refused prompt can be retried.
      this.history = previous;
      throw error;
    }
  }

  async execute<T>(file: string, action: () => Promise<T>): Promise<T> {
    historyPath(file);
    if (!this.prepared.has(file))
      throw new Error('Hosted file mutation has no prepared backup.');
    return this.history.run(async () => {
      await this.ready();
      if (!isDeepStrictEqual(await this.fingerprint(file), this.files[file]))
        throw new Error('Hosted file changed after backup preparation.');
      try {
        return await action();
      } finally {
        this.files[file] = await this.fingerprint(file);
      }
    });
  }

  async rewind(promptId: string): Promise<{
    state: HostedFileHistoryState;
    filesChanged: string[];
    filesFailed: string[];
    conflict: boolean;
  }> {
    await this.ready(false);
    return this.history.run(async () => {
      let conflict = false;
      try {
        for (const file of Object.keys(this.files)) {
          if (
            !isDeepStrictEqual(await this.fingerprint(file), this.files[file])
          ) {
            conflict = true;
            break;
          }
        }
      } catch {
        conflict = true;
      }
      if (conflict)
        return {
          state: this.state(),
          filesChanged: [],
          filesFailed: [],
          conflict: true,
        };
      const result = await this.history.service.rewind(promptId, false);
      for (const file of Object.keys(this.files))
        this.files[file] = await this.fingerprint(file);
      return {
        state: this.state(),
        filesChanged: result.filesChanged.map((file) =>
          path.relative(this.directory, file).split(path.sep).join('/'),
        ),
        filesFailed: result.filesFailed.map((file) =>
          path.relative(this.directory, file).split(path.sep).join('/'),
        ),
        conflict: false,
      };
    });
  }

  private async resolve(file: string): Promise<string> {
    historyPath(file);
    let current = this.directory;
    const segments = file.split('/');
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      try {
        const info = await lstat(current);
        if (
          info.isSymbolicLink() ||
          (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())
        )
          throw new Error(
            'Hosted file history requires ordinary Workspace files.',
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return current;
  }

  private async fingerprint(
    file: string,
  ): Promise<HostedFileHistoryState['files'][string]> {
    const absolute = await this.resolve(file);
    try {
      const before = await lstat(absolute);
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(absolute))
        digest.update(chunk as Buffer);
      const after = await lstat(absolute);
      if (
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.mode !== after.mode
      )
        throw new Error('Hosted file changed while reading history.');
      return {
        digest: `sha256:${digest.digest('hex')}`,
        mode: after.mode & 0o7777,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}
