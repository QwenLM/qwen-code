/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { constants, createWriteStream, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  MAX_SKILL_ARCHIVE_BYTES,
  WorkspaceSkillManagementError,
} from './workspace-skill-management.js';

export interface SkillZipFileSource {
  type: 'zip-file';
  path: string;
  sha256?: string;
}

export interface PreparedSkillArchive {
  path: string;
  sha256: string;
  dispose(): Promise<void>;
}

export function validateSkillZipFileSource(source: SkillZipFileSource): void {
  if (!path.isAbsolute(source.path)) {
    throw new WorkspaceSkillManagementError(
      'invalid_skill_source',
      'ZIP path must be absolute on the daemon host',
    );
  }
  if (source.sha256 !== undefined && !/^[a-fA-F0-9]{64}$/.test(source.sha256)) {
    throw new WorkspaceSkillManagementError(
      'invalid_skill_source',
      'Expected SHA-256 must contain 64 hexadecimal digits',
    );
  }
}

export async function acquireSkillArchive(
  input: Readable | SkillZipFileSource,
  signal: AbortSignal,
): Promise<PreparedSkillArchive> {
  signal.throwIfAborted();
  const fileSource = 'type' in input ? input : undefined;
  if (fileSource) validateSkillZipFileSource(fileSource);
  let handle: FileHandle | undefined;
  let directory: string | undefined;
  let source: Readable | undefined;
  const bridge = new PassThrough();
  const forwardError = (error: Error) => bridge.destroy(error);
  try {
    let before;
    if (fileSource) {
      const named = await fs.lstat(fileSource.path, { bigint: true });
      if (!named.isFile()) {
        throw new WorkspaceSkillManagementError(
          'invalid_skill_source',
          'ZIP source must be a regular file, not a link or special file',
        );
      }
      // NONBLOCK also prevents a raced-in FIFO from hanging the open forever.
      // Identity checks cover platforms without O_NOFOLLOW.
      handle = await fs.open(
        fileSource.path,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
      before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.ino === 0n ||
        before.ino !== named.ino ||
        before.dev !== named.dev
      ) {
        throw new WorkspaceSkillManagementError(
          'invalid_skill_source',
          'ZIP source changed while opening',
        );
      }
      if (before.size > BigInt(MAX_SKILL_ARCHIVE_BYTES)) {
        throw new WorkspaceSkillManagementError(
          'skill_archive_too_large',
          'ZIP archive exceeds 50 MiB',
          413,
        );
      }
      source = handle.createReadStream({ autoClose: false });
    } else {
      source = input as Readable;
    }
    signal.throwIfAborted();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-archive-'));
    const archivePath = path.join(directory, 'archive.zip');
    const hash = createHash('sha256');
    let bytes = 0;
    const guard = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_SKILL_ARCHIVE_BYTES) {
          callback(
            new WorkspaceSkillManagementError(
              'skill_archive_too_large',
              'ZIP archive exceeds 50 MiB',
              413,
            ),
          );
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    source.on('error', forwardError);
    source.pipe(bridge);
    await pipeline(
      bridge,
      guard,
      createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    signal.throwIfAborted();
    if (handle && before) {
      const after = await handle.stat({ bigint: true });
      if (
        BigInt(bytes) !== before.size ||
        before.size !== after.size ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      ) {
        throw new WorkspaceSkillManagementError(
          'skill_archive_changed',
          'ZIP source changed while copying',
        );
      }
    }
    const sha256 = hash.digest('hex');
    if (fileSource?.sha256 && fileSource.sha256.toLowerCase() !== sha256) {
      throw new WorkspaceSkillManagementError(
        'skill_archive_digest_mismatch',
        'ZIP archive does not match the expected SHA-256',
      );
    }
    const ownedDirectory = directory;
    return {
      path: archivePath,
      sha256,
      dispose: () => fs.rm(ownedDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    if (source) {
      source.unpipe(bridge);
      source.removeListener('error', forwardError);
      if (fileSource) source.destroy();
    }
    bridge.destroy();
    await handle?.close();
  }
}
