/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_EXPANDED_BYTES,
  MAX_ARCHIVE_PATH_BYTES,
} from '@qwen-code/qwen-code-core/extension/archive-safety.js';

export const MANAGED_EXTENSION_ARCHIVE_MAX_BYTES = 100 * 1024 * 1024;
const DIGEST = /^[0-9a-f]{64}$/u;

export class ManagedExtensionCache {
  constructor(readonly directory: string) {
    if (!path.isAbsolute(directory)) throw new Error('Invalid package cache.');
  }

  async upload(digest: string, source: Readable): Promise<void> {
    this.assertDigest(digest);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, `.upload-${randomUUID()}`);
    const hash = createHash('sha256');
    let bytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        if (bytes > MANAGED_EXTENSION_ARCHIVE_MAX_BYTES) {
          callback(new Error('Package archive exceeds its size limit.'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        source,
        limit,
        createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      );
      if (hash.digest('hex') !== digest)
        throw new Error('Package archive digest mismatch.');
      await this.validateArchive(temporary);
      await fs.rename(temporary, this.archivePath(digest));
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  materialize(digest: string): Promise<string> {
    this.assertDigest(digest);
    return this.extract(digest);
  }

  private async extract(digest: string): Promise<string> {
    const archive = this.archivePath(digest);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest('hex') !== digest)
      throw new Error('Cached package archive digest mismatch.');
    await this.validateArchive(archive);
    // Each materialization has its own directory: a caller never replaces a
    // directory another Session has pinned.
    const destination = path.join(this.directory, `${digest}-${randomUUID()}`);
    await fs.mkdir(destination, { mode: 0o700 });
    try {
      await tar.x({
        file: archive,
        cwd: destination,
        strict: true,
        noChmod: true,
      });
      await fs.writeFile(
        `${destination}.integrity`,
        await this.treeDigest(destination),
        { mode: 0o600, flag: 'wx' },
      );
      return destination;
    } catch (error) {
      await fs.rm(destination, { recursive: true, force: true });
      throw error;
    }
  }

  async restoreMaterialized(digest: string, directory: string): Promise<void> {
    this.assertDigest(digest);
    if (
      path.dirname(directory) !== this.directory ||
      !new RegExp(`^${digest}-[0-9a-f-]{36}$`, 'u').test(
        path.basename(directory),
      ) ||
      !(await fs.lstat(this.directory)).isDirectory()
    )
      throw new Error('Extension cache scope conflicts.');
    try {
      await this.verifyMaterialized(digest, directory);
      return;
    } catch {
      // Only explicit preparation repairs assets; ordinary tool reads only verify.
    }
    const fresh = await this.materialize(digest);
    const quarantine = path.join(this.directory, `.quarantine-${randomUUID()}`);
    const moveIfPresent = async (source: string, target: string) => {
      try {
        await fs.rename(source, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    };
    try {
      await moveIfPresent(directory, quarantine);
      await moveIfPresent(`${directory}.integrity`, `${quarantine}.integrity`);
      await fs.rename(fresh, directory);
      await fs.rename(`${fresh}.integrity`, `${directory}.integrity`);
      await this.verifyMaterialized(digest, directory);
      await fs.rm(quarantine, { recursive: true, force: true });
      await fs.rm(`${quarantine}.integrity`, { force: true });
    } finally {
      await fs.rm(fresh, { recursive: true, force: true });
      await fs.rm(`${fresh}.integrity`, { force: true });
    }
  }

  async verifyMaterialized(digest: string, directory: string): Promise<void> {
    this.assertDigest(digest);
    if (
      path.dirname(directory) !== this.directory ||
      !path.basename(directory).startsWith(`${digest}-`)
    )
      throw new Error('Extension cache scope conflicts.');
    if (!(await fs.lstat(directory)).isDirectory())
      throw new Error('Extension cache root is unsafe.');
    const expected = await fs.readFile(`${directory}.integrity`, 'utf8');
    if ((await this.treeDigest(directory)) !== expected)
      throw new Error('Extension package assets drifted.');
  }

  private async treeDigest(directory: string): Promise<string> {
    const hash = createHash('sha256');
    const visit = async (relative: string): Promise<void> => {
      const entries = await fs.readdir(path.join(directory, relative), {
        withFileTypes: true,
      });
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name, 'en'),
      )) {
        const child = path.posix.join(relative, entry.name);
        if (!entry.isDirectory() && !entry.isFile())
          throw new Error('Extension assets contain an unsafe entry.');
        hash.update(
          JSON.stringify([child, entry.isDirectory() ? 'directory' : 'file']),
        );
        if (entry.isDirectory()) await visit(child);
        else {
          const content = createHash('sha256');
          for await (const chunk of createReadStream(
            path.join(directory, child),
          ))
            content.update(chunk);
          hash.update(content.digest());
        }
      }
    };
    await visit('');
    return hash.digest('hex');
  }

  private async validateArchive(file: string): Promise<void> {
    let count = 0;
    let bytes = 0;
    let pathBytes = 0;
    let invalid = false;
    const seen = new Set<string>();
    const source = createReadStream(file);
    const parser = tar.t({
      strict: true,
      onReadEntry(entry) {
        const normalized = path.posix.normalize(entry.path).replace(/\/$/u, '');
        count++;
        bytes += entry.size;
        pathBytes += Buffer.byteLength(entry.path);
        if (
          !['File', 'Directory', 'OldFile', 'ContiguousFile'].includes(
            entry.type,
          ) ||
          entry.path.includes('\\') ||
          entry.path.includes('\0') ||
          path.posix.isAbsolute(entry.path) ||
          /^[a-zA-Z]:/u.test(entry.path) ||
          normalized === '..' ||
          normalized.startsWith('../') ||
          seen.has(normalized) ||
          count > MAX_ARCHIVE_ENTRIES ||
          bytes > MAX_ARCHIVE_EXPANDED_BYTES ||
          pathBytes > MAX_ARCHIVE_PATH_BYTES
        ) {
          invalid = true;
          source.destroy(new Error('Unsafe package archive.'));
        }
        seen.add(normalized);
      },
    });
    await pipeline(source, parser);
    if (invalid) throw new Error('Unsafe package archive.');
  }

  private archivePath(digest: string): string {
    return path.join(this.directory, `${digest}.tar.gz`);
  }

  private assertDigest(digest: string): void {
    if (!DIGEST.test(digest)) throw new Error('Invalid package digest.');
  }
}
