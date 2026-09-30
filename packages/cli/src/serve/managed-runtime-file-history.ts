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
  readonly history: ManagedToolFileHistory;
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
    this.files = structuredClone(state?.files ?? {});
  }

  async ready(): Promise<void> {
    await this.history.ready();
    await this.history.service.validateRestoredSnapshots();
    for (const snapshot of this.history.state().snapshots) {
      for (const [file, backup] of Object.entries(
        snapshot.trackedFileBackups,
      )) {
        await this.resolve(file.split(path.sep).join('/'));
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
    await this.history.checkpoint(promptId);
    await this.history.run(async () => {
      for (const file of paths) {
        const absolute = await this.resolve(file);
        const current = await this.fingerprint(file);
        if (
          Object.hasOwn(this.files, file) &&
          !isDeepStrictEqual(current, this.files[file])
        )
          throw new Error('Hosted file changed outside tracked mutations.');
        await this.history.service.trackEdit(absolute);
        const backups = this.history.service
          .getSnapshots()
          .at(-1)?.trackedFileBackups;
        const key = file.split('/').join(path.sep);
        if (!backups || !Object.hasOwn(backups, key) || backups[key].failed)
          throw new Error(
            'Hosted file backup failed; mutation was not started.',
          );
        this.files[file] = current;
        this.prepared.add(file);
      }
      for (const snapshot of this.history.state().snapshots)
        for (const file of Object.keys(snapshot.trackedFileBackups)) {
          const relative = file.split(path.sep).join('/');
          if (!Object.hasOwn(this.files, relative))
            this.files[relative] = await this.fingerprint(relative);
        }
    });
    await this.ready();
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
    await this.ready();
    return this.history.run(async () => {
      for (const file of Object.keys(this.files))
        if (!isDeepStrictEqual(await this.fingerprint(file), this.files[file]))
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
