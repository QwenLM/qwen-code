/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ADAPTER,
  ExplorerError,
  MAX_SNAPSHOT_BYTES,
  MAX_SOURCE_BYTES,
  reportSnapshotSchema,
} from './contracts.js';
import type { ReportSnapshot } from './contracts.js';
import { parseVitestReport } from './vitest-report.js';

const reportIdPattern = /^r1_[0-9a-f]{64}$/;

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function inside(root: string, path: string): boolean {
  const tail = relative(root, path);
  return (
    tail !== '' &&
    !isAbsolute(tail) &&
    tail !== '..' &&
    !tail.startsWith(`..${sep}`)
  );
}

function checksum(snapshot: ReportSnapshot): string {
  const { snapshotChecksum: _checksum, ...body } = snapshot;
  return digest(JSON.stringify(body));
}

function checkSnapshotSize(snapshot: ReportSnapshot): void {
  let bytes = 0;
  const add = (count: number) => {
    bytes += count;
    if (bytes > MAX_SNAPSHOT_BYTES)
      throw new ExplorerError(
        'REPORT_TOO_LARGE',
        'Normalized snapshot exceeds the byte limit.',
      );
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      add(2 + Math.max(0, value.length - 1));
      for (const entry of value) visit(entry);
    } else if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value).filter(
        ([, entry]) => entry !== undefined,
      );
      add(2 + Math.max(0, entries.length - 1));
      for (const [key, entry] of entries) {
        add(Buffer.byteLength(JSON.stringify(key)) + 1);
        visit(entry);
      }
    } else {
      add(Buffer.byteLength(JSON.stringify(value)));
    }
  };
  // Count repeated source strings before allocating a complete JSON snapshot.
  visit(snapshot);
}

async function readBounded(
  path: string,
  max: number,
  signal?: AbortSignal,
  checkCtime = true,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const file = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await file.stat();
    if (!before.isFile())
      throw new ExplorerError(
        'INVALID_REPORT',
        'Expected a regular JSON file.',
      );
    if (before.size > max)
      throw new ExplorerError(
        'REPORT_TOO_LARGE',
        'File exceeds the byte limit.',
      );
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= max) {
      signal?.throwIfAborted();
      const chunk = Buffer.alloc(Math.min(64 * 1024, max + 1 - size));
      const { bytesRead } = await file.read(chunk);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > max)
        throw new ExplorerError(
          'REPORT_TOO_LARGE',
          'File exceeds the byte limit.',
        );
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await file.stat();
    const current = await lstat(path);
    if (
      size !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      (checkCtime && after.ctimeMs !== before.ctimeMs) ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.isSymbolicLink()
    ) {
      throw new ExplorerError(
        'INVALID_REPORT',
        'File changed during reading; import it again when writing has finished.',
      );
    }
    return Buffer.concat(chunks, size);
  } finally {
    await file.close();
  }
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ExplorerError('INVALID_REPORT', 'Expected complete UTF-8 JSON.');
  }
}

export class ReportStore {
  private constructor(readonly workspaceRoot: string) {}

  static async create(root: string | undefined): Promise<ReportStore> {
    if (!root || !isAbsolute(root) || root.includes('${')) {
      throw new ExplorerError(
        'PATH_OUTSIDE_WORKSPACE',
        'QWEN_TEST_EXPLORER_WORKSPACE_ROOT must be an expanded absolute directory.',
      );
    }
    try {
      const canonical = await realpath(root);
      if (!(await lstat(canonical)).isDirectory())
        throw new Error('Not a directory');
      return new ReportStore(canonical);
    } catch {
      throw new ExplorerError(
        'PATH_OUTSIDE_WORKSPACE',
        'The configured workspace root is not an accessible directory.',
      );
    }
  }

  private id(relativePath: string, sourceHash: string): string {
    return `r1_${digest(JSON.stringify([1, ADAPTER, this.workspaceRoot, relativePath, sourceHash]))}`;
  }

  private async cacheDirectory(create: boolean): Promise<string> {
    let directory = this.workspaceRoot;
    for (const part of ['.qwen', 'test-failure-explorer', 'reports']) {
      directory = join(directory, part);
      if (create)
        await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
          if (
            !(
              error instanceof Error &&
              'code' in error &&
              error.code === 'EEXIST'
            )
          )
            throw error;
        });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new ExplorerError(
          'PATH_OUTSIDE_WORKSPACE',
          'The report cache must contain real workspace directories, not symlinks.',
        );
      }
    }
    return directory;
  }

  async load(reportId: string, signal?: AbortSignal): Promise<ReportSnapshot> {
    if (!reportIdPattern.test(reportId))
      throw new ExplorerError('INVALID_QUERY', 'Invalid reportId.');
    try {
      const directory = await this.cacheDirectory(false);
      const snapshot = reportSnapshotSchema.parse(
        parseJson(
          await readBounded(
            join(directory, `${reportId}.json`),
            MAX_SNAPSHOT_BYTES,
            signal,
            // Removing the publication hard link changes ctime, not bytes.
            false,
          ),
        ),
      );
      if (
        snapshot.reportId !== reportId ||
        this.id(snapshot.source.relativePath, snapshot.source.sha256) !==
          reportId ||
        checksum(snapshot) !== snapshot.snapshotChecksum
      ) {
        throw new Error('Snapshot integrity mismatch');
      }
      signal?.throwIfAborted();
      return snapshot;
    } catch (error) {
      signal?.throwIfAborted();
      if (
        error instanceof ExplorerError &&
        error.code === 'PATH_OUTSIDE_WORKSPACE'
      )
        throw error;
      throw new ExplorerError(
        'REPORT_UNAVAILABLE',
        'Report snapshot is missing or corrupt. Check the cache and import the source report again.',
      );
    }
  }

  async importReport(
    relativePath: string,
    signal?: AbortSignal,
  ): Promise<ReportSnapshot> {
    if (
      typeof relativePath !== 'string' ||
      !relativePath ||
      isAbsolute(relativePath) ||
      relativePath.split(/[\\/]/).includes('..') ||
      extname(relativePath).toLowerCase() !== '.json'
    ) {
      throw new ExplorerError(
        'PATH_OUTSIDE_WORKSPACE',
        'Provide a workspace-relative .json path without traversal.',
      );
    }
    let sourcePath: string;
    try {
      sourcePath = await realpath(resolve(this.workspaceRoot, relativePath));
    } catch {
      throw new ExplorerError(
        'INVALID_REPORT',
        'Source report is not accessible.',
      );
    }
    if (!inside(this.workspaceRoot, sourcePath))
      throw new ExplorerError(
        'PATH_OUTSIDE_WORKSPACE',
        'Source report resolves outside this workspace.',
      );
    const normalizedPath = relative(this.workspaceRoot, sourcePath)
      .split(sep)
      .join('/');
    let bytes: Buffer;
    try {
      bytes = await readBounded(sourcePath, MAX_SOURCE_BYTES, signal);
      if ((await realpath(sourcePath)) !== sourcePath)
        throw new ExplorerError(
          'PATH_OUTSIDE_WORKSPACE',
          'Source path changed during reading.',
        );
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ExplorerError) throw error;
      throw new ExplorerError(
        'INVALID_REPORT',
        'Could not read a regular source report.',
      );
    }
    const normalized = parseVitestReport(parseJson(bytes));
    const sourceHash = digest(bytes);
    const reportId = this.id(normalizedPath, sourceHash);
    const snapshot = reportSnapshotSchema.parse({
      ...normalized,
      schemaVersion: 1,
      reportId,
      source: {
        relativePath: normalizedPath,
        sha256: sourceHash,
        bytes: bytes.length,
      },
      importedAt: new Date().toISOString(),
      snapshotChecksum: '0'.repeat(64),
    });
    checkSnapshotSize(snapshot);
    snapshot.snapshotChecksum = checksum(snapshot);
    const serialized = JSON.stringify(snapshot);
    signal?.throwIfAborted();
    let temporary: string | undefined;
    try {
      const directory = await this.cacheDirectory(true);
      const target = join(directory, `${reportId}.json`);
      try {
        await lstat(target);
        return await this.load(reportId, signal);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        )
          throw error;
      }
      temporary = join(directory, `.import-${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      signal?.throwIfAborted();
      await this.cacheDirectory(false);
      try {
        // link publishes a complete file without replacing a concurrent import.
        await link(temporary, target);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'EEXIST'
          )
        )
          throw error;
      }
      return await this.load(reportId, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ExplorerError) throw error;
      throw new ExplorerError(
        'STORAGE_ERROR',
        'Could not persist the report snapshot. Check the workspace cache directory.',
      );
    } finally {
      if (temporary) await unlink(temporary).catch(() => undefined);
    }
  }
}
